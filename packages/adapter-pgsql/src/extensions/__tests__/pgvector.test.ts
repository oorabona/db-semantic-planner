/**
 * pgvector Extension Integration Tests
 *
 * Tests the pgvector wrappers (cosineDistance, rawDistance, l2Distance, innerProduct)
 * using the compile-only adapter with the full intent pipeline.
 *
 * Every query goes through a model-carrying ORM and `.dump()`.
 */

import { cast, createOrm, exprRef, op, param, schema } from '@dbsp/core';
import type { WhereComparisonIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../../pgsql-adapter.js';
import {
	cosineDistance,
	innerProduct,
	l2Distance,
	rawDistance,
} from '../pgvector.js';

// ---------------------------------------------------------------------------
// Fixture: a model-carrying ORM over an embeddings table
// ---------------------------------------------------------------------------

const db = schema({
	embeddings: {
		id: { type: 'integer', primaryKey: true },
		content: 'text',
		vector: { type: 'text', dbType: 'vector(768)' },
	},
	docs: {
		id: { type: 'integer', primaryKey: true },
		vec: { type: 'text', dbType: 'vector(2)' },
	},
});
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
	suppressDxWarnings: true,
});

type ExprRef = ReturnType<typeof cosineDistance>;

/** Dump `SELECT <expr> AS <alias> FROM embeddings`. */
function dumpSelectExpr(
	expr: ExprRef,
	alias: string,
): { sql: string; params: readonly unknown[] } {
	const { sql, params } = orm
		.select('embeddings')
		.columns([expr.as(alias)])
		.dump();
	return { sql, params };
}

const QV = [0.1, 0.2, 0.3];

// ---------------------------------------------------------------------------
// cosineDistance
// ---------------------------------------------------------------------------

describe('cosineDistance', () => {
	it('produces correct SQL in SELECT with alias', () => {
		expect(dumpSelectExpr(cosineDistance('vector', QV), 'score')).toEqual({
			sql: 'SELECT 1 - (vector <=> CAST($1 AS vector)) AS score FROM embeddings',
			params: [QV],
		});
	});

	it('binds exactly one parameter', () => {
		expect(
			dumpSelectExpr(cosineDistance('vector', QV), 'score').params,
		).toEqual([QV]);
	});
});

// ---------------------------------------------------------------------------
// rawDistance
// ---------------------------------------------------------------------------

describe('rawDistance', () => {
	it('produces correct SQL in SELECT', () => {
		expect(dumpSelectExpr(rawDistance('vector', QV), 'dist')).toEqual({
			sql: 'SELECT vector <=> CAST($1 AS vector) AS dist FROM embeddings',
			params: [QV],
		});
	});

	it('produces correct SQL for ORDER BY', () => {
		const { sql, params } = orm
			.select('embeddings')
			.orderBy(rawDistance('vector', QV), 'asc')
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT embeddings.* FROM embeddings ORDER BY vector <=> CAST($1 AS vector) ASC',
			params: [QV],
		});
	});
});

// ---------------------------------------------------------------------------
// l2Distance
// ---------------------------------------------------------------------------

describe('l2Distance', () => {
	it('uses <-> operator', () => {
		expect(dumpSelectExpr(l2Distance('vector', QV), 'l2')).toEqual({
			sql: 'SELECT vector <-> CAST($1 AS vector) AS l2 FROM embeddings',
			params: [QV],
		});
	});
});

// ---------------------------------------------------------------------------
// innerProduct
// ---------------------------------------------------------------------------

describe('innerProduct', () => {
	it('uses <#> operator', () => {
		expect(dumpSelectExpr(innerProduct('vector', QV), 'ip')).toEqual({
			sql: 'SELECT vector <#> CAST($1 AS vector) AS ip FROM embeddings',
			params: [QV],
		});
	});
});

// ---------------------------------------------------------------------------
// WHERE with expression comparison
// ---------------------------------------------------------------------------

describe('WHERE with expression comparison', () => {
	it('compiles cosineDistance.gte() as WHERE clause', () => {
		const { sql, params } = orm
			.select('embeddings')
			.where(cosineDistance('vector', QV).gte(0.5))
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT embeddings.* FROM embeddings WHERE (1 - (embeddings.vector <=> CAST($1 AS vector))) >= $2',
			params: [QV, 0.5],
		});
	});
});

// ---------------------------------------------------------------------------
// ORDER BY with expression
// ---------------------------------------------------------------------------

describe('ORDER BY with expression', () => {
	it('compiles rawDistance in ORDER BY ASC', () => {
		const { sql, params } = orm
			.select('embeddings')
			.orderBy(rawDistance('vector', QV), 'asc')
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT embeddings.* FROM embeddings ORDER BY vector <=> CAST($1 AS vector) ASC',
			params: [QV],
		});
	});

	it('compiles l2Distance in ORDER BY ASC', () => {
		const { sql, params } = orm
			.select('embeddings')
			.orderBy(l2Distance('vector', QV), 'asc')
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT embeddings.* FROM embeddings ORDER BY vector <-> CAST($1 AS vector) ASC',
			params: [QV],
		});
	});
});

// ---------------------------------------------------------------------------
// Full integration: SELECT + WHERE + ORDER BY + LIMIT
// ---------------------------------------------------------------------------

describe('full integration', () => {
	it('compiles SELECT + ORDER BY + LIMIT for ANN search', () => {
		const qv = [0.1, 0.2, 0.3];
		const { sql, params } = orm
			.select('embeddings')
			.columns(['id', 'content', cosineDistance('vector', qv).as('score')])
			.orderBy(rawDistance('vector', qv), 'asc')
			.limit(10)
			.dump();
		// Two params: one for cosineDistance SELECT, one for rawDistance ORDER BY
		expect({ sql, params }).toEqual({
			sql: 'SELECT embeddings.id, embeddings.content, 1 - (vector <=> CAST($1 AS vector)) AS score FROM embeddings ORDER BY vector <=> CAST($2 AS vector) ASC LIMIT 10',
			params: [qv, qv],
		});
	});
});

// ---------------------------------------------------------------------------
// Column vs column (no params)
// ---------------------------------------------------------------------------

describe('column-vs-column', () => {
	it('op(<=> ref ref) produces no params', () => {
		const selfJoinOn: WhereComparisonIntent = {
			kind: 'comparison',
			field: 'embeddings.id',
			operator: 'lt',
			value: { kind: 'fieldRef', column: 'id', scope: 'outer' },
		};
		const { sql, params } = orm
			.select('embeddings')
			.join('embeddings', { on: selfJoinOn, as: 'e2', type: 'inner' })
			.columns([
				op('<=>', exprRef('embeddings.vector'), exprRef('e2.vector')).as(
					'dist',
				),
			])
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT embeddings.vector <=> e2.vector AS dist FROM embeddings JOIN embeddings AS e2 ON embeddings.id < e2.id',
			params: [],
		});
	});
});

// ---------------------------------------------------------------------------
// raw op/cast/param composition
// ---------------------------------------------------------------------------

describe('raw expression composition', () => {
	it('op/ref/cast/param composes correctly', () => {
		const qv = [0.5, 0.6];
		// op('<=>', exprRef('vec'), cast(param(qv), 'vector'))
		const { sql, params } = orm
			.select('docs')
			.columns([op('<=>', exprRef('vec'), cast(param(qv), 'vector')).as('d')])
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT vec <=> CAST($1 AS vector) AS d FROM docs',
			params: [qv],
		});
	});
});
