// @ts-nocheck — coverage test: runtime assertions
import { describe, expect, it, vi } from 'vitest';
import type { PlanReport } from '../planner.js';
import { RelationNotFoundError } from './errors.js';
import { ResultHydrator } from './result-hydrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ModelIR mock with configurable relations.
 */
function createMockModel(
	relations: Record<
		string,
		{
			name: string;
			source: string;
			target: string;
			foreignKey?: string | readonly string[];
			type?: string;
			cardinality?: string;
			optionality?: string;
		}
	> = {},
	relationsFrom: Record<string, string[]> = {},
) {
	const relationMap = new Map(Object.entries(relations));

	// Auto-generate table entries from relation sources/targets for planRecursive
	const tableMap = new Map<
		string,
		{ name: string; columns: Map<string, unknown>; primaryKey: string[] }
	>();
	for (const rel of relationMap.values()) {
		for (const tName of [rel.source, rel.target]) {
			if (!tableMap.has(tName)) {
				tableMap.set(tName, {
					name: tName,
					columns: new Map([
						['id', { name: 'id', type: 'integer', nullable: false }],
						['name', { name: 'name', type: 'text', nullable: true }],
					]),
					primaryKey: ['id'],
				});
			}
		}
	}

	return {
		tables: tableMap,
		relations: relationMap,
		getTable: vi.fn((name: string) => tableMap.get(name)),
		getRelation: vi.fn((qualifiedName: string) =>
			relationMap.get(qualifiedName),
		),
		getRelationsFrom: vi.fn((table: string) => {
			const names = relationsFrom[table] ?? [];
			if (names.length > 0) {
				return names
					.map((n) => relationMap.get(`${table}.${n}`))
					.filter(Boolean);
			}
			// Fallback: find all relations from this table
			return [...relationMap.values()].filter((r) => r.source === table);
		}),
		getRelationsTo: vi.fn().mockReturnValue([]),
		isAmbiguous: vi.fn().mockReturnValue({ ambiguous: false, options: [] }),
	};
}

/**
 * Build a minimal Adapter mock.
 */
function createMockAdapter(executeReturn: unknown[] = []) {
	return {
		capabilities: {},
		compile: vi.fn(),
		execute: vi.fn().mockResolvedValue(executeReturn),
		executeOne: vi.fn(),
		executeOneOrThrow: vi.fn(),
		compileInsert: vi.fn(),
		compileInsertFrom: vi.fn(),
		compileUpdate: vi.fn(),
		compileDelete: vi.fn(),
		compileUpsert: vi.fn(),
		compileUpsertFrom: vi.fn(),
		compileRecursive: vi.fn().mockReturnValue({
			sql: 'WITH RECURSIVE ...',
			parameters: [],
		}),
		createDump: vi.fn(),
		stream: vi.fn(),
		introspect: vi.fn(),
		transaction: vi.fn(),
		executeRaw: vi.fn(),
		generateDDL: vi.fn(),
	};
}

/**
 * Build a PlanReport with configurable decisions.
 */
function makePlanReport(
	decisions: Array<{
		id?: string;
		type: string;
		choice: string;
		context?: Record<string, unknown>;
		reasoning?: string;
		alternatives?: readonly string[];
	}> = [],
): PlanReport {
	return {
		rootTable: 'users',
		decisions: decisions.map((d, i) => ({
			id: d.id ?? `d${i}`,
			type: d.type,
			choice: d.choice,
			context: { sourceTable: 'users', ...d.context },
			reasoning: d.reasoning ?? '',
			alternatives: d.alternatives ?? [],
		})),
		warnings: [],
		ctes: [],
		intent: {} as PlanReport['intent'],
		metadata: {
			planningTimeMs: 0,
			relationsAnalyzed: 0,
			isAmbiguous: false,
		},
	} as unknown as PlanReport;
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('ResultHydrator', () => {
	describe('constructor', () => {
		it('stores model, from, and schemaName', () => {
			const model = createMockModel();
			const hydrator = new ResultHydrator(model as any, 'users', 'tenant_1');
			// Verify the hydrator is instantiated without error
			expect(hydrator).toBeDefined();
		});

		it('creates hydrator without schemaName', () => {
			const model = createMockModel();
			const hydrator = new ResultHydrator(model as any, 'users');
			expect(hydrator).toBeDefined();
		});
	});

	// -----------------------------------------------------------------------
	// hydrateJoinIncludes
	// -----------------------------------------------------------------------

	describe('include hydration metadata', () => {
		it('refuses includes from planner decisions without compile metadata', () => {
			const model = createMockModel();
			const rows = [{ 'author.id': 1, author_json: '[]' }];
			const report = {
				...makePlanReport([
					{
						type: 'include-strategy',
						choice: 'join',
						context: { nodeId: 'include:author' },
					},
				]),
				execution: {
					includes: [
						{ nodeId: 'include:author', publicKey: 'author', children: [] },
					],
				},
			} as unknown as PlanReport;
			const hydrator = new ResultHydrator(model, 'posts');
			expect(() => hydrator.hydrateJoinIncludes(rows, report)).toThrow(
				"Include hydration 'author' requires compiled includePayloads; supply the compiled query hydrationPlan.",
			);
			expect(() => hydrator.hydrateJsonAggIncludes(rows, report)).toThrow(
				"Include hydration 'author' requires compiled includePayloads; supply the compiled query hydrationPlan.",
			);
			expect(rows).toEqual([{ 'author.id': 1, author_json: '[]' }]);
			expect(model.getTable).not.toHaveBeenCalled();
		});
	});

	describe('processRecursiveIncludes', () => {
		it('returns early when results are empty', async () => {
			const model = createMockModel();
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter();

			await hydrator.processRecursiveIncludes(
				[],
				[
					{
						relation: 'parent',
						options: { recursive: true, direction: 'ancestors' },
					},
				],
				adapter as any,
			);

			expect(adapter.compileRecursive).not.toHaveBeenCalled();
		});

		it('throws RelationNotFoundError when relation is missing', async () => {
			const model = createMockModel({}, { categories: [] });
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter();

			await expect(
				hydrator.processRecursiveIncludes(
					[{ id: 1, name: 'Root' }],
					[
						{
							relation: 'parent',
							options: {
								recursive: true,
								direction: 'ancestors',
							},
						},
					],
					adapter as any,
				),
			).rejects.toThrow(RelationNotFoundError);
		});

		it('provides available relations in RelationNotFoundError', async () => {
			const model = createMockModel(
				{
					'categories.children': {
						name: 'children',
						source: 'categories',
						target: 'categories',
						foreignKey: 'parent_id',
						type: 'hasMany',
						cardinality: 'many',
						optionality: 'optional',
					},
				},
				{ categories: ['children'] },
			);
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter();

			try {
				await hydrator.processRecursiveIncludes(
					[{ id: 1, name: 'Root' }],
					[
						{
							relation: 'nonexistent',
							options: {
								recursive: true,
								direction: 'ancestors',
							},
						},
					],
					adapter as any,
				);
				expect.unreachable('Should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(RelationNotFoundError);
				expect((err as RelationNotFoundError).available).toContain('children');
			}
		});

		it('processes ancestors direction with flat=true', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');

			const recursiveRows = [
				{ id: 1, name: 'Root', parent_id: null, depth: 0, _root_id: 1 },
				{ id: 2, name: 'Child', parent_id: 1, depth: 1, _root_id: 1 },
			];
			const adapter = createMockAdapter(recursiveRows);

			const results = [{ id: 1, name: 'Root' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			// flat=true → array directly
			expect(results[0].ancestors).toEqual(recursiveRows);
		});

		it('processes descendants direction with nested tree', async () => {
			const model = createMockModel({
				'categories.children': {
					name: 'children',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'hasMany',
					cardinality: 'many',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');

			const recursiveRows = [
				{ id: 1, name: 'Root', parent_id: null, depth: 0, _root_id: 1 },
				{ id: 2, name: 'Child', parent_id: 1, depth: 1, _root_id: 1 },
			];
			const adapter = createMockAdapter(recursiveRows);

			const results = [{ id: 1, name: 'Root' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'children',
						options: {
							recursive: true,
							direction: 'descendants',
						},
					},
				],
				adapter as any,
			);

			// nested tree structure
			expect(results[0].descendants).toBeDefined();
			expect(Array.isArray(results[0].descendants)).toBe(true);
		});

		it('applies omitSelf filter (removes depth=0 rows)', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');

			const recursiveRows = [
				{ id: 1, name: 'Self', parent_id: null, depth: 0, _root_id: 1 },
				{ id: 2, name: 'Parent', parent_id: null, depth: 1, _root_id: 1 },
			];
			const adapter = createMockAdapter(recursiveRows);

			const results = [{ id: 1, name: 'Self' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							omitSelf: true,
							flat: true,
						},
					},
				],
				adapter as any,
			);

			// depth=0 row should be filtered
			expect(results[0].ancestors).toHaveLength(1);
			expect(results[0].ancestors[0].name).toBe('Parent');
		});

		it('skips when no startIds are available', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter();

			// results have no "id" field
			const results = [{ name: 'No Id' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
						},
					},
				],
				adapter as any,
			);

			expect(adapter.compileRecursive).not.toHaveBeenCalled();
		});

		it('uses includeDepth to add track.depth to intent', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');

			const recursiveRows = [
				{ id: 1, name: 'Root', parent_id: null, depth: 0, _root_id: 1 },
			];
			const adapter = createMockAdapter(recursiveRows);
			const results = [{ id: 1, name: 'Root' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							includeDepth: true,
							flat: true,
						},
					},
				],
				adapter as any,
			);

			// The planRecursive call happens internally — we just verify
			// the adapter.compileRecursive was called
			expect(adapter.compileRecursive).toHaveBeenCalled();
		});

		it('builds single startId comparison WHERE clause', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 42, name: 'Single' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			// Single ID → comparison WHERE clause (kind: 'comparison')
			expect(adapter.compileRecursive).toHaveBeenCalled();
		});

		it('builds multiple startIds IN WHERE clause', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [
				{ id: 1, name: 'First' },
				{ id: 2, name: 'Second' },
			];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			// Multiple IDs → in WHERE clause (kind: 'in')
			expect(adapter.compileRecursive).toHaveBeenCalled();
		});

		it('uses schemaName in compile options when set', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(
				model as any,
				'categories',
				'tenant_42',
			);
			const adapter = createMockAdapter([]);
			const results = [{ id: 1, name: 'Root' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			// compileRecursive should be called with schemaName in options
			expect(adapter.compileRecursive).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.objectContaining({ schemaName: 'tenant_42' }),
			);
		});

		it('does not include schemaName when undefined', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1, name: 'Root' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			// compileRecursive should be called with empty options (no schemaName)
			const callArgs = adapter.compileRecursive.mock.calls[0];
			expect(callArgs[2]).toEqual({});
		});

		it('processes multiple recursive includes in sequence', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
				'categories.children': {
					name: 'children',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'hasMany',
					cardinality: 'many',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter();
			adapter.execute
				.mockResolvedValueOnce([
					{ id: 2, name: 'Parent', parent_id: null, depth: 1, _root_id: 1 },
				])
				.mockResolvedValueOnce([
					{ id: 3, name: 'Child', parent_id: 1, depth: 1, _root_id: 1 },
				]);

			const results = [{ id: 1, name: 'Root' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
					{
						relation: 'children',
						options: {
							recursive: true,
							direction: 'descendants',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			expect(results[0].ancestors).toBeDefined();
			expect(results[0].descendants).toBeDefined();
		});
	});

	// -----------------------------------------------------------------------
	// getForeignKeyColumn (tested indirectly)
	// -----------------------------------------------------------------------

	describe('getForeignKeyColumn (via processRecursiveIncludes)', () => {
		it('defaults to parent_id when foreignKey is undefined', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: undefined,
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1, name: 'Root' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			// Uses default 'parent_id' - test passes if no error
			expect(adapter.compileRecursive).toHaveBeenCalled();
		});

		it('uses string foreignKey directly', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'manager_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1, name: 'Root' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			expect(adapter.compileRecursive).toHaveBeenCalled();
		});

		it('fails loud for composite recursive foreignKey arrays', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: ['parent_id', 'org_id'],
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1, name: 'Root' }];

			await expect(
				hydrator.processRecursiveIncludes(
					results,
					[
						{
							relation: 'parent',
							options: {
								recursive: true,
								direction: 'ancestors',
								flat: true,
							},
						},
					],
					adapter as any,
				),
			).rejects.toThrow(/single-column self-referential foreign key/);
			expect(adapter.compileRecursive).not.toHaveBeenCalled();
		});

		it('defaults to parent_id for empty array foreignKey', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: [],
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1, name: 'Root' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			expect(adapter.compileRecursive).toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// Output property naming (mergeRecursiveResults)
	// -----------------------------------------------------------------------

	describe('output property naming (mergeRecursiveResults)', () => {
		it('uses "ancestors" for parent relation + ancestors direction', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1 }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			expect(results[0]).toHaveProperty('ancestors');
		});

		it('uses "descendants" for children relation + descendants direction', async () => {
			const model = createMockModel({
				'categories.children': {
					name: 'children',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'hasMany',
					cardinality: 'many',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1 }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'children',
						options: {
							recursive: true,
							direction: 'descendants',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			expect(results[0]).toHaveProperty('descendants');
		});

		it('uses "{relation}_ancestors" for custom relation + ancestors direction', async () => {
			const model = createMockModel({
				'employees.manager': {
					name: 'manager',
					source: 'employees',
					target: 'employees',
					foreignKey: 'manager_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'employees');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1 }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'manager',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			expect(results[0]).toHaveProperty('manager_ancestors');
		});

		it('uses "{relation}_descendants" for custom relation + descendants direction', async () => {
			const model = createMockModel({
				'employees.reports': {
					name: 'reports',
					source: 'employees',
					target: 'employees',
					foreignKey: 'manager_id',
					type: 'hasMany',
					cardinality: 'many',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'employees');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1 }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'reports',
						options: {
							recursive: true,
							direction: 'descendants',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			expect(results[0]).toHaveProperty('reports_descendants');
		});
	});

	// -----------------------------------------------------------------------
	// buildNestedHierarchy (tested via processRecursiveIncludes)
	// -----------------------------------------------------------------------

	describe('buildNestedHierarchy (via mergeRecursiveResults)', () => {
		it('returns null for ancestors with empty rows', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1, name: 'Root' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
						},
					},
				],
				adapter as any,
			);

			// No rows → null for ancestors
			expect(results[0].ancestors).toBeNull();
		});

		it('returns empty array for descendants with empty rows', async () => {
			const model = createMockModel({
				'categories.children': {
					name: 'children',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'hasMany',
					cardinality: 'many',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1, name: 'Root' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'children',
						options: {
							recursive: true,
							direction: 'descendants',
						},
					},
				],
				adapter as any,
			);

			// No rows → empty array for descendants
			expect(results[0].descendants).toEqual([]);
		});

		it('builds ancestor chain (reversed nesting)', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');

			// Recursive rows: depth 0 = self, depth 1 = parent, depth 2 = grandparent
			const recursiveRows = [
				{ id: 1, name: 'Self', parent_id: 2, depth: 0, _root_id: 1 },
				{ id: 2, name: 'Parent', parent_id: 3, depth: 1, _root_id: 1 },
				{ id: 3, name: 'Grandparent', parent_id: null, depth: 2, _root_id: 1 },
			];
			const adapter = createMockAdapter(recursiveRows);
			const results = [{ id: 1, name: 'Self' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
						},
					},
				],
				adapter as any,
			);

			// Should be a chain: self -> parent -> grandparent
			const chain = results[0].ancestors;
			expect(chain).toBeDefined();
			expect(chain.id).toBe(1);
			expect(chain.parent.id).toBe(2);
			expect(chain.parent.parent.id).toBe(3);
		});

		it('builds descendant tree with children arrays', async () => {
			const model = createMockModel({
				'categories.children': {
					name: 'children',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'hasMany',
					cardinality: 'many',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');

			const recursiveRows = [
				{ id: 1, name: 'Root', parent_id: null, depth: 0, _root_id: 1 },
				{ id: 2, name: 'Child A', parent_id: 1, depth: 1, _root_id: 1 },
				{ id: 3, name: 'Child B', parent_id: 1, depth: 1, _root_id: 1 },
				{ id: 4, name: 'Grandchild', parent_id: 2, depth: 2, _root_id: 1 },
			];
			const adapter = createMockAdapter(recursiveRows);
			const results = [{ id: 1, name: 'Root' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'children',
						options: {
							recursive: true,
							direction: 'descendants',
						},
					},
				],
				adapter as any,
			);

			const tree = results[0].descendants;
			expect(Array.isArray(tree)).toBe(true);
			// Root node has parent_id: null → pushed to roots
			const root = tree[0];
			expect(root.id).toBe(1);
			expect(root.children).toHaveLength(2);

			const childA = root.children.find((c: any) => c.id === 2);
			expect(childA.children).toHaveLength(1);
			expect(childA.children[0].id).toBe(4);
		});

		it('handles orphan nodes (parentId not in map) as roots', async () => {
			const model = createMockModel({
				'categories.children': {
					name: 'children',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'hasMany',
					cardinality: 'many',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');

			// Node 2 has parent_id=99 which doesn't exist in the result set
			const recursiveRows = [
				{ id: 1, name: 'Root', parent_id: null, depth: 0, _root_id: 1 },
				{ id: 2, name: 'Orphan', parent_id: 99, depth: 1, _root_id: 1 },
			];
			const adapter = createMockAdapter(recursiveRows);
			const results = [{ id: 1, name: 'Root' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'children',
						options: {
							recursive: true,
							direction: 'descendants',
						},
					},
				],
				adapter as any,
			);

			const tree = results[0].descendants;
			// Both should be root-level because parent 99 not in map
			expect(tree).toHaveLength(2);
		});

		it('uses _root_id for grouping recursive results', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');

			// Two different starting points with their recursive data
			const recursiveRows = [
				{ id: 1, name: 'A-self', parent_id: 10, depth: 0, _root_id: 1 },
				{ id: 10, name: 'A-parent', parent_id: null, depth: 1, _root_id: 1 },
				{ id: 2, name: 'B-self', parent_id: 20, depth: 0, _root_id: 2 },
				{ id: 20, name: 'B-parent', parent_id: null, depth: 1, _root_id: 2 },
			];
			const adapter = createMockAdapter(recursiveRows);
			const results = [
				{ id: 1, name: 'A' },
				{ id: 2, name: 'B' },
			];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			// Each result should have its own ancestors
			expect(results[0].ancestors).toHaveLength(2);
			expect(results[1].ancestors).toHaveLength(2);
		});

		it('falls back to row.id when _root_id is missing', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');

			// No _root_id field → falls back to row.id
			const recursiveRows = [
				{ id: 1, name: 'Self', parent_id: null, depth: 0 },
			];
			const adapter = createMockAdapter(recursiveRows);
			const results = [{ id: 1, name: 'Root' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			// Falls back to row.id → grouped by id=1 → attached to result with id=1
			expect(results[0].ancestors).toHaveLength(1);
		});

		it('returns empty for result with no matching recursive data', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');

			// Recursive rows only for id=1, but result has id=999
			const recursiveRows = [{ id: 1, name: 'Root', depth: 0, _root_id: 1 }];
			const adapter = createMockAdapter(recursiveRows);
			const results = [{ id: 999, name: 'Unmatched' }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
						},
					},
				],
				adapter as any,
			);

			// No matching _root_id → empty recursiveData → null for ancestors
			expect(results[0].ancestors).toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// buildTraversalConfig (tested via processRecursiveIncludes)
	// -----------------------------------------------------------------------

	describe('buildTraversalConfig', () => {
		it('builds adjacency traversal for ancestors direction', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1 }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			// Verify compileRecursive was called (traversal config is internal)
			const report = adapter.compileRecursive.mock.calls[0][0];
			expect(report.intent.traversal.kind).toBe('adjacency');
			expect(report.intent.traversal.direction).toBe('ancestors');
			expect(report.intent.traversal.parentId).toBe('parent_id');
		});

		it('builds adjacency traversal for descendants direction', async () => {
			const model = createMockModel({
				'categories.children': {
					name: 'children',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'hasMany',
					cardinality: 'many',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1 }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'children',
						options: {
							recursive: true,
							direction: 'descendants',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			const report = adapter.compileRecursive.mock.calls[0][0];
			expect(report.intent.traversal.kind).toBe('adjacency');
			expect(report.intent.traversal.direction).toBe('descendants');
		});
	});

	// -----------------------------------------------------------------------
	// buildRecursiveIntent (tested via processRecursiveIncludes)
	// -----------------------------------------------------------------------

	describe('buildRecursiveIntent', () => {
		it('builds intent with depth tracking when includeDepth=true', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1 }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							includeDepth: true,
							flat: true,
						},
					},
				],
				adapter as any,
			);

			const report = adapter.compileRecursive.mock.calls[0][0];
			expect(report.intent.track).toEqual({ depth: {} });
		});

		it('builds intent without depth tracking when includeDepth is false', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1 }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			const report = adapter.compileRecursive.mock.calls[0][0];
			expect(report.intent.track).toBeUndefined();
		});

		it('uses default maxDepth of 100', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1 }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			const report = adapter.compileRecursive.mock.calls[0][0];
			expect(report.intent.maxDepth).toBe(100);
		});

		it('uses custom maxDepth when specified', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1 }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							maxDepth: 5,
							flat: true,
						},
					},
				],
				adapter as any,
			);

			const report = adapter.compileRecursive.mock.calls[0][0];
			expect(report.intent.maxDepth).toBe(5);
		});

		it('generates cteName from relation and direction', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1 }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			const report = adapter.compileRecursive.mock.calls[0][0];
			expect(report.intent.cteName).toBe('_recursive_parent_ancestors');
		});

		it('uses comparison WHERE for single startId', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 42 }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			const report = adapter.compileRecursive.mock.calls[0][0];
			expect(report.intent.start.where).toEqual({
				kind: 'comparison',
				field: 'id',
				operator: 'eq',
				value: 42,
			});
		});

		it('uses IN WHERE for multiple startIds', async () => {
			const model = createMockModel({
				'categories.parent': {
					name: 'parent',
					source: 'categories',
					target: 'categories',
					foreignKey: 'parent_id',
					type: 'belongsTo',
					cardinality: 'one',
					optionality: 'optional',
				},
			});
			const hydrator = new ResultHydrator(model as any, 'categories');
			const adapter = createMockAdapter([]);
			const results = [{ id: 1 }, { id: 2 }, { id: 3 }];

			await hydrator.processRecursiveIncludes(
				results,
				[
					{
						relation: 'parent',
						options: {
							recursive: true,
							direction: 'ancestors',
							flat: true,
						},
					},
				],
				adapter as any,
			);

			const report = adapter.compileRecursive.mock.calls[0][0];
			expect(report.intent.start.where).toEqual({
				kind: 'in',
				field: 'id',
				values: [1, 2, 3],
			});
		});
	});
});
