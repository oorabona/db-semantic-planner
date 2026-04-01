// @ts-nocheck — coverage test: runtime assertions on builder methods
/**
 * @fileoverview Branch coverage for raw-cte-builder.ts and set-operation-builder.ts
 *
 * Targets uncovered branches:
 * - RawCteQueryBuilder.dump(): schemaName ternary (both branches)
 * - RawCteQueryBuilder.all(): schemaName ternary (both branches)
 * - SetOperationBuilderImpl.dump(): schemaName injection path (L166 true branch)
 */

import { describe, expect, it, vi } from 'vitest';
import { RawCteQueryBuilder } from './raw-cte-builder.js';
import { schema } from './schema.js';
import { SetOperationBuilderImpl } from './set-operation-builder.js';

// ============================================================================
// Helpers
// ============================================================================

const testSchema = schema({
	users: {
		id: 'integer',
		name: 'string',
	},
}).model;

/** Minimal RawCteIntent */
const minimalRawCteIntent = {
	kind: 'rawCte' as const,
	name: 'tree',
	base: { type: 'select', from: 'users' },
	step: { type: 'select', from: 'users' },
	unionAll: true,
};

/** Minimal SetOperationIntent */
const minimalSetIntent = {
	kind: 'setOperation' as const,
	op: 'union' as const,
	all: false,
	left: { type: 'select', from: 'users' },
	right: { type: 'select', from: 'users' },
};

function makeCteAdapter(rows: unknown[] = []) {
	const compiledQuery = {
		sql: 'WITH RECURSIVE "tree" AS (...) SELECT * FROM "tree"',
		parameters: [],
	};
	return {
		compileCteQuery: vi.fn().mockReturnValue(compiledQuery),
		execute: vi.fn().mockResolvedValue(rows),
	};
}

// ============================================================================
// RawCteQueryBuilder.dump() — schemaName ternary branches
// ============================================================================

describe('RawCteQueryBuilder.dump()', () => {
	it('compiles without schemaName (undefined compileOptions path)', () => {
		const adapter = makeCteAdapter();
		const builder = new RawCteQueryBuilder(
			'tree',
			minimalRawCteIntent,
			adapter as never,
		);

		const dump = builder.dump();
		expect(dump.sql).toBeTruthy();
		expect(dump.intent.kind).toBe('cteQuery');
		// compileOptions should be undefined when no schemaName
		expect(adapter.compileCteQuery).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'cteQuery' }),
			undefined,
		);
	});

	it('compiles with schemaName (defined compileOptions path)', () => {
		const adapter = makeCteAdapter();
		const builder = new RawCteQueryBuilder(
			'tree',
			minimalRawCteIntent,
			adapter as never,
			'tenant_2', // schemaName
		);

		const dump = builder.dump();
		expect(dump.sql).toBeTruthy();
		expect(adapter.compileCteQuery).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'cteQuery' }),
			{
				schemaName: 'tenant_2',
			},
		);
	});
});

// ============================================================================
// RawCteQueryBuilder.all() — schemaName ternary branches
// ============================================================================

describe('RawCteQueryBuilder.all()', () => {
	it('executes without schemaName', async () => {
		const rows = [{ id: 1 }];
		const adapter = makeCteAdapter(rows);
		const builder = new RawCteQueryBuilder(
			'tree',
			minimalRawCteIntent,
			adapter as never,
		);

		const result = await builder.all();
		expect(result).toEqual(rows);
		expect(adapter.compileCteQuery).toHaveBeenCalledWith(
			expect.any(Object),
			undefined,
		);
	});

	it('executes with schemaName', async () => {
		const rows = [{ id: 2 }];
		const adapter = makeCteAdapter(rows);
		const builder = new RawCteQueryBuilder(
			'tree',
			minimalRawCteIntent,
			adapter as never,
			'ns',
		);

		const result = await builder.all();
		expect(result).toEqual(rows);
		expect(adapter.compileCteQuery).toHaveBeenCalledWith(expect.any(Object), {
			schemaName: 'ns',
		});
	});

	it('execute() is an alias for all()', async () => {
		const rows = [{ id: 3 }];
		const adapter = makeCteAdapter(rows);
		const builder = new RawCteQueryBuilder(
			'tree',
			minimalRawCteIntent,
			adapter as never,
		);

		const result = await builder.execute();
		expect(result).toEqual(rows);
	});
});

// ============================================================================
// SetOperationBuilderImpl.dump() — schemaName injection path (L166 true branch)
// ============================================================================

describe('SetOperationBuilderImpl.dump() — schemaName injection', () => {
	it('injects schemaName into meta when schemaName set and meta.schema is undefined', () => {
		// The true branch at L166: dumpResult.meta?.schema === undefined AND schemaName !== undefined
		// → result has meta.schema = schemaName
		const compiledQuery = {
			sql: 'SELECT * FROM "users" UNION SELECT * FROM "users"',
			parameters: [],
		};
		const dumpResult = {
			sql: compiledQuery.sql,
			params: compiledQuery.parameters,
			plan: { rootTable: '', decisions: [], warnings: [] },
			// No meta.schema → undefined → true branch fires
			meta: {},
		};

		const adapter = {
			compileSetOperation: vi.fn().mockReturnValue(compiledQuery),
			createDump: vi.fn().mockReturnValue(dumpResult),
		};

		const builder = new SetOperationBuilderImpl(
			minimalSetIntent,
			testSchema,
			adapter as never,
			'public', // schemaName set
		);

		const result = builder.dump();
		// schemaName injected into meta
		expect(result.meta?.schema).toBe('public');
	});

	it('does NOT inject schemaName when schemaName is not set', () => {
		const compiledQuery = { sql: 'SELECT 1 UNION SELECT 2', parameters: [] };
		const dumpResult = {
			sql: compiledQuery.sql,
			params: [],
			plan: { rootTable: '', decisions: [], warnings: [] },
			meta: {},
		};

		const adapter = {
			compileSetOperation: vi.fn().mockReturnValue(compiledQuery),
			createDump: vi.fn().mockReturnValue(dumpResult),
		};

		// No schemaName → condition false → original dumpResult returned
		const builder = new SetOperationBuilderImpl(
			minimalSetIntent,
			testSchema,
			adapter as never,
			// no schemaName
		);

		const result = builder.dump();
		expect(result.meta?.schema).toBeUndefined();
	});
});
