// @ts-nocheck — coverage test: runtime assertions on builder methods
/**
 * @fileoverview Branch coverage for cte-builder.ts and builder-utils.ts
 *
 * Targets uncovered branches:
 * - CteQueryBuilder.dump(): schemaName ternary (both branches)
 * - CteQueryBuilder.all(): schemaName ternary (both branches)
 * - CteQueryBuilder.execute(): alias for all()
 * - builder-utils.ts requireAdapter() success path
 */

import { describe, expect, it, vi } from 'vitest';
import { CteBuilder } from './cte-builder.js';
import { schema } from './schema.js';

// ============================================================================
// Helpers
// ============================================================================

const testSchema = schema({
	users: {
		id: 'integer',
		name: 'string',
	},
	posts: {
		id: 'integer',
		title: 'string',
	},
});

/**
 * Create a mock adapter with compileCteQuery and execute stubs.
 */
function makeCteAdapter(rows: unknown[] = []) {
	const compiledQuery = {
		sql: 'WITH "cte" AS (SELECT unnest($1::integer[])) SELECT * FROM "users"',
		parameters: [[1, 2, 3]],
	};
	return {
		compileCteQuery: vi.fn().mockReturnValue(compiledQuery),
		execute: vi.fn().mockResolvedValue(rows),
	};
}

// ============================================================================
// CteQueryBuilder.dump() — schemaName branches
// ============================================================================

describe('CteQueryBuilder.dump()', () => {
	it('returns dump without schemaName in compileOptions (undefined path)', () => {
		// No schemaName → compileOptions = undefined
		const adapter = makeCteAdapter();
		const builder = new CteBuilder('lookups', adapter as never)
			.fromUnnest({ id: [1, 2, 3] })
			.query(testSchema.model as never); // pass model as minimal selectBuilder

		// We need a proper QueryBuilder for the outer query.
		// Use the orm pattern via createOrm to get an actual QueryBuilder.
		// Instead, build via CteBuilder directly with a minimal outer builder.
		// The easiest approach: get the intent manually.
		const cteQueryBuilder = new CteBuilder('lookup_ids', adapter as never)
			.fromUnnest({ parent_id: [10, 20] })
			.query({
				buildIntent: () => ({
					type: 'select',
					from: 'users',
				}),
			} as never);

		const dump = cteQueryBuilder.dump();
		expect(dump.sql).toBe(
			'WITH "cte" AS (SELECT unnest($1::integer[])) SELECT * FROM "users"',
		);
		expect(dump.params).toEqual([[1, 2, 3]]);
		expect(dump.intent.kind).toBe('cteQuery');
		// compileCteQuery called with undefined compileOptions
		expect(adapter.compileCteQuery).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'cteQuery' }),
			undefined,
		);
	});

	it('returns dump with schemaName in compileOptions (defined path)', () => {
		// schemaName provided → compileOptions = { schemaName: 'tenant_1' }
		const adapter = makeCteAdapter();
		const cteQueryBuilder = new CteBuilder(
			'lookup_ids',
			adapter as never,
			'tenant_1', // schemaName
		)
			.fromUnnest({ parent_id: [10, 20] })
			.query({
				buildIntent: () => ({
					type: 'select',
					from: 'users',
				}),
			} as never);

		const dump = cteQueryBuilder.dump();
		expect(dump.sql).toBeTruthy();
		expect(adapter.compileCteQuery).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'cteQuery' }),
			{
				schemaName: 'tenant_1',
			},
		);
	});
});

// ============================================================================
// CteQueryBuilder.all() — schemaName branches
// ============================================================================

describe('CteQueryBuilder.all()', () => {
	it('executes without schemaName (undefined compileOptions)', async () => {
		const rows = [{ id: 1 }, { id: 2 }];
		const adapter = makeCteAdapter(rows);
		const cteQueryBuilder = new CteBuilder('ids', adapter as never)
			.fromUnnest({ id: [1, 2] })
			.query({
				buildIntent: () => ({ type: 'select', from: 'users' }),
			} as never);

		const result = await cteQueryBuilder.all();
		expect(result).toEqual(rows);
		expect(adapter.compileCteQuery).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'cteQuery' }),
			undefined,
		);
		expect(adapter.execute).toHaveBeenCalledOnce();
	});

	it('executes with schemaName (defined compileOptions)', async () => {
		const rows = [{ id: 42 }];
		const adapter = makeCteAdapter(rows);
		const cteQueryBuilder = new CteBuilder('ids', adapter as never, 'myschema')
			.fromUnnest({ id: [42] })
			.query({
				buildIntent: () => ({ type: 'select', from: 'users' }),
			} as never);

		const result = await cteQueryBuilder.all();
		expect(result).toEqual(rows);
		expect(adapter.compileCteQuery).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'cteQuery' }),
			{
				schemaName: 'myschema',
			},
		);
	});

	it('execute() is an alias for all()', async () => {
		const rows = [{ id: 7 }];
		const adapter = makeCteAdapter(rows);
		const cteQueryBuilder = new CteBuilder('ids', adapter as never)
			.fromUnnest({ id: [7] })
			.query({
				buildIntent: () => ({ type: 'select', from: 'users' }),
			} as never);

		const result = await cteQueryBuilder.execute();
		expect(result).toEqual(rows);
	});
});

// ============================================================================
// CteBuilder.fromUnnest() — array length mismatch error
// ============================================================================

describe('CteBuilder.fromUnnest() error paths', () => {
	it('throws when array lengths mismatch', () => {
		expect(() =>
			new CteBuilder('bad').fromUnnest({ a: [1, 2], b: [10] }),
		).toThrow(/Array length mismatch/);
	});

	it('allows single array column (no mismatch check)', () => {
		const builder = new CteBuilder('single').fromUnnest({ a: [1, 2, 3] });
		expect(builder).toBeDefined();
	});
});

// ============================================================================
// CteBuilder.query() without fromUnnest() — InvalidOperationError
// ============================================================================

describe('CteBuilder.query() without fromUnnest()', () => {
	it('throws when query() called before fromUnnest()', () => {
		expect(() =>
			new CteBuilder('nope').query({
				buildIntent: () => ({ type: 'select', from: 'users' }),
			} as never),
		).toThrow(/CTE requires a data source/);
	});
});

// ============================================================================
// requireAdapter() via CteQueryBuilder — success path (builder-utils.ts L1392)
// ============================================================================

describe('requireAdapter() success path (builder-utils.ts)', () => {
	it('dump() succeeds when adapter is present (requireAdapter returns adapter)', () => {
		const adapter = makeCteAdapter();
		const cteQueryBuilder = new CteBuilder('ids', adapter as never)
			.fromUnnest({ id: [1] })
			.query({
				buildIntent: () => ({ type: 'select', from: 'users' }),
			} as never);

		// Should NOT throw — adapter is present, requireAdapter returns it
		expect(() => cteQueryBuilder.dump()).not.toThrow();
		expect(adapter.compileCteQuery).toHaveBeenCalledOnce();
	});

	it('dump() throws when adapter is absent', () => {
		const cteQueryBuilder = new CteBuilder('ids') // no adapter
			.fromUnnest({ id: [1] })
			.query({
				buildIntent: () => ({ type: 'select', from: 'users' }),
			} as never);

		expect(() => cteQueryBuilder.dump()).toThrow(/requires an adapter/i);
	});
});
