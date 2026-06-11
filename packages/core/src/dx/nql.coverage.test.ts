// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * @fileoverview Coverage tests for nql.ts — targeting uncovered branches.
 *
 * The existing nql.test.ts covers basic template usage, plan, dump-without-adapter,
 * all/first errors, and interpolation. This file targets:
 * - Cache hit path (compile called twice returns cached intent)
 * - extractPseudoColumnKeywords with pseudoColumns present
 * - extractPseudoColumnKeywords with empty tables
 * - dump() with an adapter that returns compiled SQL
 * - all() + first() with a working adapter mock
 * - first() returning null on empty result set
 * - Template interpolation with multiple values
 * - Error path: compilation failure with specific error messages
 */
import { describe, expect, it } from 'vitest';
import type { Adapter, CompiledQuery } from '../adapter.js';
import type { ModelIR, TableIR } from '../model-ir.js';
import { createNqlTag, extractPseudoColumnKeywords } from './nql.js';
import { ref, schema } from './schema.js';
import { createMockAdapter } from './test-utils.js';

// ============================================================================
// Test Setup
// ============================================================================

function createTestSchema() {
	return schema({
		users: {
			id: 'uuid',
			name: 'string',
			email: 'string',
			active: 'boolean',
		},
		posts: {
			id: 'uuid',
			title: 'string',
			content: 'text',
			author: ref('users'),
		},
	});
}

/**
 * Create a mock adapter that can compile and execute (returns controlled results).
 */
function createCompilableAdapter(rows: unknown[] = []): Adapter {
	const base = createMockAdapter();
	return {
		...base,
		compile: <T>(): CompiledQuery<T> => ({
			sql: 'SELECT "id", "name" FROM "users"',
			parameters: [],
		}),
		execute: async <T>(): Promise<T[]> => rows as T[],
	};
}

// ============================================================================
// Cache hit — compile() called twice
// ============================================================================

describe('NqlBuilder compile cache (coverage)', () => {
	it('returns cached intent on second toIntentIR() call', () => {
		const s = createTestSchema();
		const nql = createNqlTag(s.definition, s.model);

		const builder = nql<{ name: string }>`users | select name`;

		const intent1 = builder.toIntentIR();
		const intent2 = builder.toIntentIR();

		// Same reference — cached
		expect(intent1).toBe(intent2);
	});

	it('plan() reuses cached intent from prior toIntentIR()', () => {
		const s = createTestSchema();
		const nql = createNqlTag(s.definition, s.model);

		const builder = nql<unknown>`users`;

		// First call compiles and caches
		const intent = builder.toIntentIR();
		// plan() internally calls compile() which should hit cache
		const planReport = builder.plan();

		expect(intent.from).toBe('users');
		expect(planReport.rootTable).toBe('users');
	});
});

// ============================================================================
// Template interpolation — multiple values
// ============================================================================

describe('NqlBuilder template interpolation (coverage)', () => {
	it('handles multiple interpolated values in single template', () => {
		const s = createTestSchema();
		const nql = createNqlTag(s.definition, s.model);

		// Table names are structural identifiers. Use a literal table name in the
		// template; value positions are bound as generated named params.
		const limit = 10;
		const builder = nql<unknown>`users | limit ${limit}`;
		const intent = builder.toIntentIR();

		expect(intent.from).toBe('users');
		expect(intent.limit).toEqual({ kind: 'param', value: 10 });
	});

	it('handles template with multiple interpolated value positions', () => {
		const s = createTestSchema();
		const nql = createNqlTag(s.definition, s.model);

		// Column names are structural identifiers; value operands are bound.
		const name = 'Alice';
		const limit = 5;
		const builder = nql<unknown>`users | where name = ${name} | limit ${limit}`;
		const intent = builder.toIntentIR();

		expect(intent.from).toBe('users');
		expect(intent.limit).toEqual({ kind: 'param', value: 5 });
		expect(intent.where).toEqual({
			kind: 'comparison',
			field: 'name',
			operator: 'eq',
			value: { kind: 'param', value: 'Alice' },
		});
	});
});

// ============================================================================
// dump() with adapter
// ============================================================================

describe('NqlBuilder.dump() with adapter (coverage)', () => {
	it('returns compiled SQL and parameters when adapter is present', () => {
		const s = createTestSchema();
		const adapter = createCompilableAdapter();
		const nql = createNqlTag(s.definition, s.model, adapter);

		const dump = nql<{ name: string }>`users | select name`.dump();

		expect(dump.plan).toBeDefined();
		expect(dump.plan.rootTable).toBe('users');
		expect(dump.sql).toBe('SELECT "id", "name" FROM "users"');
		expect(dump.params).toEqual([]);
	});
});

// ============================================================================
// all() and first() with adapter
// ============================================================================

describe('NqlBuilder.all() with adapter (coverage)', () => {
	it('executes query and returns rows', async () => {
		const s = createTestSchema();
		const mockRows = [
			{ name: 'Alice', email: 'alice@test.com' },
			{ name: 'Bob', email: 'bob@test.com' },
		];
		const adapter = createCompilableAdapter(mockRows);
		const nql = createNqlTag(s.definition, s.model, adapter);

		const results = await nql<{
			name: string;
			email: string;
		}>`users | select name, email`.all();

		expect(results).toEqual(mockRows);
		expect(results).toHaveLength(2);
	});
});

describe('NqlBuilder.first() (coverage)', () => {
	it('returns first row when results exist', async () => {
		const s = createTestSchema();
		const mockRows = [{ name: 'Alice' }, { name: 'Bob' }];
		const adapter = createCompilableAdapter(mockRows);
		const nql = createNqlTag(s.definition, s.model, adapter);

		const result = await nql<{ name: string }>`users | select name`.first();

		expect(result).toEqual({ name: 'Alice' });
	});

	it('returns null when result set is empty', async () => {
		const s = createTestSchema();
		const adapter = createCompilableAdapter([]);
		const nql = createNqlTag(s.definition, s.model, adapter);

		const result = await nql<{ name: string }>`users | select name`.first();

		expect(result).toBeNull();
	});
});

// ============================================================================
// createNqlTag with schemaName
// ============================================================================

describe('createNqlTag with schemaName (coverage)', () => {
	it('accepts schemaName parameter without error', () => {
		const s = createTestSchema();
		const adapter = createCompilableAdapter();
		const nql = createNqlTag(s.definition, s.model, adapter, 'tenant_42');

		// Should construct without error; schemaName is stored internally
		const builder = nql<unknown>`users`;
		expect(builder.toIntentIR().from).toBe('users');
	});
});

// ============================================================================
// Error path — NQL compilation failure
// ============================================================================

describe('NqlBuilder compilation errors (coverage)', () => {
	it('throws with error details when NQL has unknown pipe operator', () => {
		const s = createTestSchema();
		const nql = createNqlTag(s.definition, s.model);

		expect(() => {
			nql<unknown>`users | foobarbaz`.toIntentIR();
		}).toThrow('NQL compilation failed');
	});

	it('includes error details in the thrown message', () => {
		const s = createTestSchema();
		const nql = createNqlTag(s.definition, s.model);

		try {
			nql<unknown>`users | invalid_operator`.toIntentIR();
			// Should not reach here
			expect.unreachable('Expected NQL compilation to throw');
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/NQL compilation failed:/);
		}
	});
});

// ============================================================================
// extractPseudoColumnKeywords
// ============================================================================

describe('extractPseudoColumnKeywords (coverage)', () => {
	it('returns undefined when model has no tables', () => {
		const emptyModel: ModelIR = {
			tables: new Map(),
			relations: [],
		};

		const result = extractPseudoColumnKeywords(emptyModel);
		expect(result).toBeUndefined();
	});

	it('returns undefined when tables have no pseudoColumns', () => {
		const s = createTestSchema();
		// Standard schema has no self-referential FKs → no pseudoColumns
		const result = extractPseudoColumnKeywords(s.model);
		expect(result).toBeUndefined();
	});

	it('returns keywords when tables have pseudoColumns', () => {
		// Build a model with pseudoColumns metadata
		const tableWithPseudo: TableIR = {
			name: 'categories',
			columns: new Map([
				[
					'id',
					{
						name: 'id',
						type: 'integer',
						nullable: false,
						isPrimaryKey: true,
						dbName: 'id',
					},
				],
				[
					'parentId',
					{
						name: 'parentId',
						type: 'integer',
						nullable: true,
						isPrimaryKey: false,
						dbName: 'parent_id',
					},
				],
			]),
			primaryKey: ['id'],
			pseudoColumns: [
				{
					table: 'categories',
					foreignKeyColumn: 'parentId',
					targetColumn: 'id',
					parentRole: 'parent',
					childRole: 'children',
					ascendantKeyword: 'ascendant',
					descendantKeyword: 'descendant',
				},
			],
		};

		const model: ModelIR = {
			tables: new Map([['categories', tableWithPseudo]]),
			relations: [],
		};

		const result = extractPseudoColumnKeywords(model);

		expect(result).toBeDefined();
		expect(result?.pseudoColumnKeywords).toEqual(
			expect.arrayContaining(['parent', 'children', 'ascendant', 'descendant']),
		);
		expect(result?.recursiveKeywords).toEqual(
			expect.arrayContaining(['ascendant', 'descendant']),
		);
		// Non-recursive keywords should NOT be in recursiveKeywords
		expect(result?.recursiveKeywords).not.toContain('parent');
		expect(result?.recursiveKeywords).not.toContain('children');
	});

	it('collects keywords from multiple tables with pseudoColumns', () => {
		const makeTable = (
			name: string,
			parentRole: string,
			childRole: string,
			asc: string,
			desc: string,
		): TableIR => ({
			name,
			columns: new Map([
				[
					'id',
					{
						name: 'id',
						type: 'integer',
						nullable: false,
						isPrimaryKey: true,
						dbName: 'id',
					},
				],
			]),
			primaryKey: ['id'],
			pseudoColumns: [
				{
					table: name,
					foreignKeyColumn: 'parentId',
					targetColumn: 'id',
					parentRole,
					childRole,
					ascendantKeyword: asc,
					descendantKeyword: desc,
				},
			],
		});

		const model: ModelIR = {
			tables: new Map([
				[
					'categories',
					makeTable(
						'categories',
						'parent',
						'children',
						'ascendant',
						'descendant',
					),
				],
				[
					'employees',
					makeTable(
						'employees',
						'manager',
						'subordinates',
						'manager.ascendant',
						'manager.descendant',
					),
				],
			]),
			relations: [],
		};

		const result = extractPseudoColumnKeywords(model);

		expect(result).toBeDefined();
		// All roles from both tables
		expect(result?.pseudoColumnKeywords).toEqual(
			expect.arrayContaining([
				'parent',
				'children',
				'ascendant',
				'descendant',
				'manager',
				'subordinates',
				'manager.ascendant',
				'manager.descendant',
			]),
		);
		// Recursive keywords from both tables
		expect(result?.recursiveKeywords).toEqual(
			expect.arrayContaining([
				'ascendant',
				'descendant',
				'manager.ascendant',
				'manager.descendant',
			]),
		);
	});

	it('deduplicates keywords across tables', () => {
		const makeTable = (name: string): TableIR => ({
			name,
			columns: new Map([
				[
					'id',
					{
						name: 'id',
						type: 'integer',
						nullable: false,
						isPrimaryKey: true,
						dbName: 'id',
					},
				],
			]),
			primaryKey: ['id'],
			pseudoColumns: [
				{
					table: name,
					foreignKeyColumn: 'parentId',
					targetColumn: 'id',
					parentRole: 'parent',
					childRole: 'children',
					ascendantKeyword: 'ascendant',
					descendantKeyword: 'descendant',
				},
			],
		});

		const model: ModelIR = {
			tables: new Map([
				['a', makeTable('a')],
				['b', makeTable('b')],
			]),
			relations: [],
		};

		const result = extractPseudoColumnKeywords(model);

		expect(result).toBeDefined();
		// Sets deduplicate, so we should get exactly 4 pseudo keywords
		expect(result?.pseudoColumnKeywords).toHaveLength(4);
		expect(result?.recursiveKeywords).toHaveLength(2);
	});
});
