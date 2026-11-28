/**
 * pgvector Extension Integration Tests
 *
 * Tests the pgvector wrappers (cosineDistance, rawDistance, l2Distance, innerProduct)
 * using the compile-only adapter with the full intent pipeline.
 *
 * Every query goes through a model-carrying ORM and `.dump()`.
 */

import {
	cast,
	createOrm,
	exprRef,
	InvalidOperationError,
	literal,
	NotYetSupportedError,
	op,
	outerRef,
	param,
	ref,
	schema,
} from '@dbsp/core';
import type { WhereComparisonIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../../pgsql-adapter.js';
import {
	cosineDistance,
	innerProduct,
	l2Distance,
	rawDistance,
	vectorDims,
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
// A number[] vector is bound as pgvector's text form (#1120).
const QV_TEXT = '[0.1,0.2,0.3]';

// ---------------------------------------------------------------------------
// cosineDistance
// ---------------------------------------------------------------------------

describe('cosineDistance', () => {
	it('produces correct SQL in SELECT with alias', () => {
		expect(dumpSelectExpr(cosineDistance('vector', QV), 'score')).toEqual({
			sql: 'SELECT 1 - (vector <=> CAST($1 AS vector)) AS score FROM embeddings',
			params: [QV_TEXT],
		});
	});

	it('binds exactly one parameter', () => {
		expect(
			dumpSelectExpr(cosineDistance('vector', QV), 'score').params,
		).toEqual([QV_TEXT]);
	});
});

// ---------------------------------------------------------------------------
// rawDistance
// ---------------------------------------------------------------------------

describe('rawDistance', () => {
	it('produces correct SQL in SELECT', () => {
		expect(dumpSelectExpr(rawDistance('vector', QV), 'dist')).toEqual({
			sql: 'SELECT vector <=> CAST($1 AS vector) AS dist FROM embeddings',
			params: [QV_TEXT],
		});
	});

	it('produces correct SQL for ORDER BY', () => {
		const { sql, params } = orm
			.select('embeddings')
			.orderBy(rawDistance('vector', QV), 'asc')
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT embeddings.* FROM embeddings ORDER BY vector <=> CAST($1 AS vector) ASC',
			params: [QV_TEXT],
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
			params: [QV_TEXT],
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
			params: [QV_TEXT],
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
			params: [QV_TEXT, 0.5],
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
			params: [QV_TEXT],
		});
	});

	it('compiles l2Distance in ORDER BY ASC', () => {
		const { sql, params } = orm
			.select('embeddings')
			.orderBy(l2Distance('vector', QV), 'asc')
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT embeddings.* FROM embeddings ORDER BY vector <-> CAST($1 AS vector) ASC',
			params: [QV_TEXT],
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
			params: ['[0.1,0.2,0.3]', '[0.1,0.2,0.3]'],
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

// ---------------------------------------------------------------------------
// ADR 0011 leaf rule (#1082): the column is a reference leaf, the vector a
// value leaf inside CAST(… AS vector).
// ---------------------------------------------------------------------------

describe('pgvector helper leaves (#1082)', () => {
	const leafDb = schema({
		users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			embedding: { type: 'text', dbType: 'vector(2)' },
			user_id: ref('users', { as: 'author' }),
		},
	});
	const leafOrm = createOrm({
		schema: leafDb,
		adapter: createPgCompileOnlyAdapter({ model: leafDb.model }),
		suppressDxWarnings: true,
	});
	const T = leafOrm.tables;
	const select = (expr: ExprRef) => {
		const { sql, params } = leafOrm
			.select('posts')
			.columns([expr.as('v')])
			.dump();
		return { sql, params };
	};
	const notAnArgument = (helper: string, kind: string) =>
		new InvalidOperationError(
			helper,
			`${kind} is not an expression argument; use literal(null), param(value) or an expression`,
		);

	it('AC-B5 / ColumnRef', () => {
		expect(select(cosineDistance(T.posts.embedding, [0.1, 0.2]))).toEqual({
			sql: 'SELECT 1 - (posts.embedding <=> CAST($1 AS vector)) AS v FROM posts',
			params: ['[0.1,0.2]'],
		});
		expect(select(rawDistance(T.posts.embedding, [0.1, 0.2]))).toEqual({
			sql: 'SELECT posts.embedding <=> CAST($1 AS vector) AS v FROM posts',
			params: ['[0.1,0.2]'],
		});
		expect(select(l2Distance(T.posts.embedding, [0.1, 0.2]))).toEqual({
			sql: 'SELECT posts.embedding <-> CAST($1 AS vector) AS v FROM posts',
			params: ['[0.1,0.2]'],
		});
		expect(select(innerProduct(T.posts.embedding, [0.1, 0.2]))).toEqual({
			sql: 'SELECT posts.embedding <#> CAST($1 AS vector) AS v FROM posts',
			params: ['[0.1,0.2]'],
		});
		expect(select(vectorDims(T.posts.embedding))).toEqual({
			sql: 'SELECT vector_dims(posts.embedding) AS v FROM posts',
			params: [],
		});
	});
	it('AC-B6 / plain: a number[] is bound as pgvector text (#1120)', () => {
		expect(select(cosineDistance('embedding', [0.1, 0.2]))).toEqual({
			sql: 'SELECT 1 - (embedding <=> CAST($1 AS vector)) AS v FROM posts',
			params: ['[0.1,0.2]'],
		});
	});
	it('a string vector is bound as given', () => {
		expect(select(rawDistance('embedding', '[1,0]'))).toEqual({
			sql: 'SELECT embedding <=> CAST($1 AS vector) AS v FROM posts',
			params: ['[1,0]'],
		});
	});
	it('AC-B6 / expression', () => {
		expect(select(rawDistance('embedding', literal('[1,0]')))).toEqual({
			sql: "SELECT embedding <=> '[1,0]'::vector AS v FROM posts",
			params: [],
		});
		expect(select(l2Distance('embedding', T.posts.embedding))).toEqual({
			sql: 'SELECT embedding <-> CAST(posts.embedding AS vector) AS v FROM posts',
			params: [],
		});
	});
	it('AC-B6 / param', () => {
		expect(select(innerProduct('embedding', param([0.1, 0.2])))).toEqual({
			sql: 'SELECT embedding <#> CAST($1 AS vector) AS v FROM posts',
			params: [[0.1, 0.2]],
		});
	});

	it('RT-B5 / null', () => {
		expect(() => select(cosineDistance(null as never, [0.1]))).toThrowError(
			notAnArgument('cosineDistance', 'null'),
		);
		expect(() => select(vectorDims(undefined as never))).toThrowError(
			notAnArgument('vectorDims', 'undefined'),
		);
	});
	it('RT-B6 / outerRef', () => {
		expect(() =>
			select(cosineDistance('embedding', outerRef('embedding'))),
		).toThrowError(
			new NotYetSupportedError('outerRef()', 'expression argument', 1029),
		);
	});
});
