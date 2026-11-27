/**
 * Vector Search Integration Tests — FR-4
 *
 * Covers:
 * 1. vectorDims(col) — SELECT vector_dims(col) AS dim
 * 2. cosineDistance() end-to-end: SELECT, WHERE, ORDER BY
 * 3. Self-join pattern for find-duplicates using .join(..., { on, as })
 *
 * All tests use the compile-only adapter (no DB required).
 * Every query goes through the model-carrying ORM and `.dump()`; the full SQL
 * and params are asserted.
 */

import { createOrm, exprRef, op, schema } from '@dbsp/core';
import type { WhereComparisonIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	cosineDistance,
	rawDistance,
	vectorDims,
} from '../extensions/pgvector.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const testSchema = schema({
	embeddings: {
		id: { type: 'integer', primaryKey: true },
		model: { type: 'text' },
		vector: { type: 'text', dbType: 'vector(768)' },
	},
});

const orm = createOrm({
	model: testSchema.model,
	adapter: createPgCompileOnlyAdapter({ model: testSchema.model }),
});

const QV = [0.1, 0.2, 0.3];

describe('vectorDims', () => {
	const dims = () =>
		orm
			.select('embeddings')
			.columns([vectorDims('vector').as('dim')])
			.dump();

	it('compiles to vector_dims(col) in SELECT', () => {
		const { sql, params } = dims();
		expect({ sql, params }).toEqual({
			sql: 'SELECT vector_dims(vector) AS dim FROM embeddings',
			params: [],
		});
	});

	it('returns ExpressionRef chainable with .as() — alias stored in intent', () => {
		const expr = vectorDims('vector').as('ndim');
		// .as() stores alias in intent, returns new ExpressionRef
		expect((expr as unknown as { intent: { as?: string } }).intent.as).toBe(
			'ndim',
		);
	});

	it('produces no bound parameters', () => {
		const { sql, params } = dims();
		expect({ sql, params }).toEqual({
			sql: 'SELECT vector_dims(vector) AS dim FROM embeddings',
			params: [],
		});
	});

	it('SQL contains FROM embeddings table', () => {
		expect(dims().sql).toBe(
			'SELECT vector_dims(vector) AS dim FROM embeddings',
		);
	});
});

describe('cosineDistance — SELECT', () => {
	const scored = () =>
		orm
			.select('embeddings')
			.columns([cosineDistance('vector', QV).as('score')])
			.dump();

	it('compiles 1 - (col <=> $1::vector) in SELECT', () => {
		const { sql, params } = scored();
		expect({ sql, params }).toEqual({
			sql: 'SELECT 1 - (vector <=> CAST($1 AS vector)) AS score FROM embeddings',
			params: [QV],
		});
	});

	it('CAST($N AS vector) appears in SELECT SQL', () => {
		const { sql, params } = scored();
		expect({ sql, params }).toEqual({
			sql: 'SELECT 1 - (vector <=> CAST($1 AS vector)) AS score FROM embeddings',
			params: [QV],
		});
	});
});

describe('cosineDistance — WHERE', () => {
	it('compiles cosineDistance expression in WHERE with gte threshold', () => {
		const { sql, params } = orm
			.select('embeddings')
			.where(cosineDistance('vector', QV).gte(0.8))
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT embeddings.* FROM embeddings WHERE (1 - (embeddings.vector <=> CAST($1 AS vector))) >= $2',
			params: [QV, 0.8],
		});
	});

	it('WHERE with lt threshold has correct parameter order', () => {
		const { sql, params } = orm
			.select('embeddings')
			.where(cosineDistance('vector', QV).lt(0.3))
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT embeddings.* FROM embeddings WHERE (1 - (embeddings.vector <=> CAST($1 AS vector))) < $2',
			params: [QV, 0.3],
		});
	});
});

describe('cosineDistance — ORDER BY', () => {
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

	it('compiles cosineDistance in ORDER BY DESC', () => {
		const { sql, params } = orm
			.select('embeddings')
			.orderBy(cosineDistance('vector', QV), 'desc')
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT embeddings.* FROM embeddings ORDER BY 1 - (vector <=> CAST($1 AS vector)) DESC',
			params: [QV],
		});
	});
});

describe('cosineDistance — full ANN search pipeline', () => {
	it('SELECT score + WHERE threshold + ORDER BY raw distance + LIMIT', () => {
		const { sql, params } = orm
			.select('embeddings')
			.columns(['id', cosineDistance('vector', QV).as('score')])
			.where(cosineDistance('vector', QV).gte(0.5))
			.orderBy(rawDistance('vector', QV), 'asc')
			.limit(10)
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT embeddings.id, 1 - (vector <=> CAST($1 AS vector)) AS score FROM embeddings WHERE (1 - (embeddings.vector <=> CAST($2 AS vector))) >= $3 ORDER BY vector <=> CAST($4 AS vector) ASC LIMIT 10',
			params: [QV, QV, 0.5, QV],
		});
	});
});

describe('self-join: find-duplicates pattern', () => {
	// ON condition for self-join: embeddings.id < e2.id
	// Uses WhereComparisonIntent directly with fieldRef value (scope: 'outer')
	// per the established pattern in join-api.test.ts
	const selfJoinOn: WhereComparisonIntent = {
		kind: 'comparison',
		field: 'embeddings.id',
		operator: 'lt',
		value: { kind: 'fieldRef', column: 'id', scope: 'outer' },
	};

	it('generates INNER JOIN embeddings AS e2 with ON embeddings.id < e2.id', () => {
		const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
		const orm = createOrm({ model: testSchema.model, adapter });

		const dump = (orm as any)
			.select('embeddings')
			.join('embeddings', { on: selfJoinOn, as: 'e2', type: 'inner' })
			.dump();

		const sql = dump.sql.replace(/\s+/g, ' ').trim();

		expect(sql).toEqual(
			'SELECT embeddings.* FROM embeddings JOIN embeddings AS e2 ON embeddings.id < e2.id',
		);
		expect(dump.params).toEqual([]);
	});

	it('self-join SQL matches expected structure (FROM + INNER JOIN + ON id < id)', () => {
		const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
		const orm = createOrm({ model: testSchema.model, adapter });

		const dump = (orm as any)
			.select('embeddings')
			.join('embeddings', { on: selfJoinOn, as: 'e2', type: 'inner' })
			.dump();

		// Expected: SELECT embeddings.* FROM embeddings JOIN embeddings AS e2 ON embeddings.id < e2.id
		expect(dump.sql.replace(/\s+/g, ' ').trim()).toEqual(
			'SELECT embeddings.* FROM embeddings JOIN embeddings AS e2 ON embeddings.id < e2.id',
		);
		expect(dump.params).toEqual([]);
	});

	it('col-vs-col <=> in SELECT produces zero params', () => {
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

	it('self-join with cosineDistance in WHERE uses col-vs-col expr', () => {
		// Verify: op(<=> ref ref) in WHERE with .lt() threshold
		const { sql, params } = orm
			.select('embeddings')
			.join('embeddings', { on: selfJoinOn, as: 'e2', type: 'inner' })
			.where(
				op('<=>', exprRef('embeddings.vector'), exprRef('e2.vector')).lt(0.2),
			)
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT embeddings.* FROM embeddings JOIN embeddings AS e2 ON embeddings.id < e2.id WHERE (embeddings.vector <=> e2.vector) < $1',
			params: [0.2],
		});
	});
});
