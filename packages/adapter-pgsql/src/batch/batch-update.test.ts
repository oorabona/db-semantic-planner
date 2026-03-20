/**
 * Batch UPDATE via unnest FROM tests — BATCH-001 Block 3
 *
 * Verifies the compileBatchUpdate strategy:
 *   UPDATE "table" SET "col" = t."col"
 *   FROM unnest(CAST($1 AS type[]), CAST($2 AS type[])) AS t("match_col", "col")
 *   WHERE "table"."match_col" = t."match_col"
 *   [RETURNING ...]
 */

import { createOrm, InvalidOperationError } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Shared ORM helper
// ---------------------------------------------------------------------------

function makeOrm() {
	return createOrm({
		model: { getTable: () => undefined } as any,
		adapter: createPgsqlCompileOnlyAdapter(),
	});
}

// ---------------------------------------------------------------------------
// SC-05: Basic batch update
// ---------------------------------------------------------------------------
describe('SC-05: basic batch update', () => {
	it('generates correct SQL for two rows', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compileBatchUpdate({
			type: 'batchUpdate',
			table: 'calls',
			matchColumns: ['id'],
			updates: [
				{ id: 10, callee_id: 42 },
				{ id: 20, callee_id: 43 },
			],
		});

		expect(result.sql).toEqual(
			'UPDATE calls SET callee_id = t.callee_id FROM unnest(CAST($1 AS int4[]), CAST($2 AS int4[])) AS t(id, callee_id) WHERE calls.id = t.id',
		);
		expect(result.parameters).toEqual([
			[10, 20],
			[42, 43],
		]);
	});

	it('transposes values correctly to column arrays', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compileBatchUpdate({
			type: 'batchUpdate',
			table: 'calls',
			matchColumns: ['id'],
			updates: [
				{ id: 1, callee_id: 100 },
				{ id: 2, callee_id: 200 },
				{ id: 3, callee_id: 300 },
			],
		});

		expect(result.parameters).toHaveLength(2);
		expect(result.parameters[0]).toEqual([1, 2, 3]);
		expect(result.parameters[1]).toEqual([100, 200, 300]);
	});
});

// ---------------------------------------------------------------------------
// SC-06: Mixed scalar + array
// ---------------------------------------------------------------------------
describe('SC-06: mixed scalar + array SET', () => {
	it('includes both t."col" refs and scalar params', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compileBatchUpdate({
			type: 'batchUpdate',
			table: 'calls',
			matchColumns: ['id'],
			updates: [
				{ id: 10, callee_id: 42 },
				{ id: 20, callee_id: 43 },
			],
			scalarSet: { confidence: 0.85 },
		});

		// Array column from unnest
		expect(result.sql).toContain('t.callee_id');
		// Scalar column
		expect(result.sql).toContain('confidence');
		expect(result.sql).toContain('$3');
		// Scalar param is third
		expect(result.parameters).toHaveLength(3);
		expect(result.parameters[2]).toBe(0.85);
	});

	it('via builder chain: .batchSet() + .set()', () => {
		const orm = makeOrm();

		const result = orm
			.update('calls')
			.batchSet('id', [
				{ id: 10, callee_id: 42 },
				{ id: 20, callee_id: 43 },
			])
			.set({ confidence: 0.85 })
			.dump();

		expect(result.sql).toContain('t.callee_id');
		expect(result.sql).toContain('confidence');
		expect(result.parameters[2]).toBe(0.85);
	});
});

// ---------------------------------------------------------------------------
// SC-07: Batch update with RETURNING
// ---------------------------------------------------------------------------
describe('SC-07: batch update with RETURNING', () => {
	it('appends RETURNING clause', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compileBatchUpdate({
			type: 'batchUpdate',
			table: 'calls',
			matchColumns: ['id'],
			updates: [{ id: 10, callee_id: 42 }],
			returning: ['id'],
		});

		expect(result.sql).toContain('RETURNING calls.id AS id');
	});

	it('supports multiple RETURNING columns', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compileBatchUpdate({
			type: 'batchUpdate',
			table: 'calls',
			matchColumns: ['id'],
			updates: [{ id: 10, callee_id: 42 }],
			returning: ['id', 'callee_id'],
		});

		expect(result.sql).toContain(
			'RETURNING calls.id AS id, calls.callee_id AS callee_id',
		);
	});

	it('builder chain: .batchSet() + .returning()', () => {
		const orm = makeOrm();

		const result = orm
			.update('calls')
			.batchSet('id', [{ id: 10, callee_id: 42 }])
			.returning(['id'])
			.dump();

		expect(result.sql).toContain('RETURNING calls.id AS id');
	});
});

// ---------------------------------------------------------------------------
// SC-08: Composite PK match
// ---------------------------------------------------------------------------
describe('SC-08: composite match columns', () => {
	it('generates AND condition in WHERE for composite key', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compileBatchUpdate({
			type: 'batchUpdate',
			table: 'org_memberships',
			matchColumns: ['org_id', 'user_id'],
			updates: [
				{ org_id: 1, user_id: 10, role: 'admin' },
				{ org_id: 1, user_id: 20, role: 'member' },
			],
		});

		// WHERE with AND for two match columns
		expect(result.sql).toContain('org_memberships.org_id = t.org_id');
		expect(result.sql).toContain('org_memberships.user_id = t.user_id');
		// SET only the non-match column
		expect(result.sql).toContain('role = t.role');
		// 3 unnest params: org_id, user_id, role
		expect(result.parameters).toHaveLength(3);
	});

	it('builder chain: .batchSet() with array match columns', () => {
		const orm = makeOrm();

		const result = orm
			.update('org_memberships')
			.batchSet(
				['org_id', 'user_id'],
				[{ org_id: 1, user_id: 10, role: 'admin' }],
			)
			.dump();

		expect(result.sql).toContain('org_memberships.org_id = t.org_id');
		expect(result.sql).toContain('org_memberships.user_id = t.user_id');
	});
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------
describe('error cases', () => {
	it('throws on empty data array', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileBatchUpdate({
				type: 'batchUpdate',
				table: 'calls',
				matchColumns: ['id'],
				updates: [],
			}),
		).toThrow(InvalidOperationError);
	});

	it('throws when match column is missing from data', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compileBatchUpdate({
				type: 'batchUpdate',
				table: 'calls',
				matchColumns: ['id'],
				updates: [{ callee_id: 42 }], // missing 'id'
			}),
		).toThrow(InvalidOperationError);
	});

	it('builder throws on empty batchSet array', () => {
		const orm = makeOrm();

		expect(() => orm.update('calls').batchSet('id', []).dump()).toThrow(
			InvalidOperationError,
		);
	});
});
