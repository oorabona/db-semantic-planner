// @ts-nocheck — perf regression / correctness proof tests for FIND-050, 054, 055, 056
import { describe, expect, it, vi } from 'vitest';
import type { PlanReport } from '../planner.js';
import type { HydrateOptions } from './result-hydrator.js';
import { ResultHydrator } from './result-hydrator.js';

// ---------------------------------------------------------------------------
// Helpers (mirrors result-hydrator.coverage.test.ts helpers)
// ---------------------------------------------------------------------------

function createMockModel() {
	return {
		tables: new Map(),
		relations: new Map(),
		getTable: vi.fn(),
		getRelation: vi.fn(),
		getRelationsFrom: vi.fn().mockReturnValue([]),
		getRelationsTo: vi.fn().mockReturnValue([]),
		isAmbiguous: vi.fn().mockReturnValue({ ambiguous: false, options: [] }),
	};
}

function createMockAdapter(executeReturn: unknown[] = []) {
	return {
		capabilities: {},
		compile: vi.fn(),
		compileSubqueryInclude: vi.fn().mockReturnValue({ sql: 'SELECT 1', parameters: [] }),
		execute: vi.fn().mockResolvedValue(executeReturn),
		executeOne: vi.fn(),
		executeOneOrThrow: vi.fn(),
		compileInsert: vi.fn(),
		compileInsertFrom: vi.fn(),
		compileUpdate: vi.fn(),
		compileDelete: vi.fn(),
		compileUpsert: vi.fn(),
		compileUpsertFrom: vi.fn(),
		compileRecursive: vi.fn().mockReturnValue({ sql: 'WITH RECURSIVE ...', parameters: [] }),
		createDump: vi.fn(),
		stream: vi.fn(),
		introspect: vi.fn(),
		transaction: vi.fn(),
		executeRaw: vi.fn(),
		generateDDL: vi.fn(),
	};
}

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
		metadata: { planningTimeMs: 0, relationsAnalyzed: 0, isAmbiguous: false },
	} as unknown as PlanReport;
}

function makeHydrateOptions(model = createMockModel()): HydrateOptions {
	return { model: model as any };
}

// ---------------------------------------------------------------------------
// FIND-054 + FIND-055: hydrateIncludes parentId collection + nested flatten
// ---------------------------------------------------------------------------

describe('ResultHydrator — hydrateIncludes (FIND-054, FIND-055)', () => {
	it('correctly extracts parentIds and assigns children to 100 parent rows', async () => {
		const model = createMockModel();
		const hydrator = new ResultHydrator(model as any, 'users');

		// 100 parent rows
		const parents: any[] = Array.from({ length: 100 }, (_, i) => ({
			id: i + 1,
			name: `user-${i + 1}`,
		}));

		// Children: 2 per parent
		const children: any[] = parents.flatMap((p) => [
			{ userId: p.id, title: `post-a-${p.id}` },
			{ userId: p.id, title: `post-b-${p.id}` },
		]);

		const adapter = createMockAdapter(children);

		await hydrator.hydrateIncludes(
			parents,
			[
				{
					relationName: 'posts',
					sourceKey: 'id',
					foreignKey: 'userId',
					relationType: 'hasMany',
					subquery: {},
				} as any,
			],
			adapter as any,
			makeHydrateOptions(model),
		);

		// Every parent should have exactly 2 posts attached
		for (const p of parents) {
			expect(Array.isArray(p.posts)).toBe(true);
			expect(p.posts).toHaveLength(2);
			expect(p.posts[0].userId).toBe(p.id);
		}
	});

	it('skips null parentIds without crashing (FIND-054 null guard)', async () => {
		const model = createMockModel();
		const hydrator = new ResultHydrator(model as any, 'users');

		// One row has null id
		const parents: any[] = [
			{ id: 1, name: 'alice' },
			{ id: null, name: 'ghost' },
			{ id: 3, name: 'carol' },
		];
		const adapter = createMockAdapter([
			{ userId: 1, title: 'p1' },
			{ userId: 3, title: 'p3' },
		]);

		await hydrator.hydrateIncludes(
			parents,
			[
				{
					relationName: 'posts',
					sourceKey: 'id',
					foreignKey: 'userId',
					relationType: 'hasMany',
					subquery: {},
				} as any,
			],
			adapter as any,
			makeHydrateOptions(model),
		);

		expect(parents[0].posts).toHaveLength(1);
		expect(parents[1].posts).toHaveLength(0); // null id => no children
		expect(parents[2].posts).toHaveLength(1);
	});

	it('FIND-055: correctly flattens children for nested hydration', async () => {
		const model = createMockModel();
		const hydrator = new ResultHydrator(model as any, 'users');

		const parents: any[] = [
			{ id: 1, name: 'alice' },
			{ id: 2, name: 'bob' },
		];

		const adapter = createMockAdapter();
		// First execute: return posts; second execute: return tags
		(adapter.execute as any)
			.mockResolvedValueOnce([
				{ userId: 1, id: 10 },
				{ userId: 1, id: 11 },
				{ userId: 2, id: 12 },
			])
			.mockResolvedValueOnce([
				{ postId: 10, tag: 'ts' },
				{ postId: 11, tag: 'js' },
				{ postId: 12, tag: 'go' },
			]);

		await hydrator.hydrateIncludes(
			parents,
			[
				{
					relationName: 'posts',
					sourceKey: 'id',
					foreignKey: 'userId',
					relationType: 'hasMany',
					subquery: {},
					nestedIncludes: [
						{
							relationName: 'tags',
							sourceKey: 'id',
							foreignKey: 'postId',
							relationType: 'hasMany',
							subquery: {},
						},
					],
				} as any,
			],
			adapter as any,
			makeHydrateOptions(model),
		);

		// alice has 2 posts, bob has 1 post
		expect(parents[0].posts).toHaveLength(2);
		expect(parents[1].posts).toHaveLength(1);

		// Tags should be attached to posts (nested hydration ran via FIND-055 flatten)
		const allPosts = [...parents[0].posts, ...parents[1].posts];
		const allTags = allPosts.flatMap((p: any) => p.tags ?? []);
		expect(allTags).toHaveLength(3);
	});
});

// ---------------------------------------------------------------------------
// FIND-050: hydrateJoinIncludes key-index cache + no keysToDelete allocation
// ---------------------------------------------------------------------------

describe('ResultHydrator — hydrateJoinIncludes (FIND-050)', () => {
	it('correctly nests prefixed columns for 10 rows x 2 relations', () => {
		const model = createMockModel();
		const hydrator = new ResultHydrator(model as any, 'users');

		// 10 rows with two prefixed relations: author.* and org.*
		const rows: any[] = Array.from({ length: 10 }, (_, i) => ({
			id: i + 1,
			name: `user-${i + 1}`,
			'author.id': 100 + i,
			'author.name': `author-${i}`,
			'org.id': 200 + i,
			'org.name': `org-${i}`,
		}));

		const report = makePlanReport([
			{ type: 'include-strategy', choice: 'join', context: { relation: 'author' } },
			{ type: 'include-strategy', choice: 'join', context: { relation: 'org' } },
		]);

		hydrator.hydrateJoinIncludes(rows, report);

		for (let i = 0; i < 10; i++) {
			const row = rows[i];

			// Prefixed keys must be removed
			expect(row['author.id']).toBeUndefined();
			expect(row['author.name']).toBeUndefined();
			expect(row['org.id']).toBeUndefined();
			expect(row['org.name']).toBeUndefined();

			// Nested objects must exist with correct values
			expect(row.author).toEqual({ id: 100 + i, name: `author-${i}` });
			expect(row.org).toEqual({ id: 200 + i, name: `org-${i}` });

			// Original columns preserved
			expect(row.id).toBe(i + 1);
			expect(row.name).toBe(`user-${i + 1}`);
		}
	});

	it('sets relation to null when all joined columns are null (LEFT JOIN no-match)', () => {
		const model = createMockModel();
		const hydrator = new ResultHydrator(model as any, 'users');

		const rows: any[] = [
			{ id: 1, 'author.id': null, 'author.name': null },
			{ id: 2, 'author.id': 42, 'author.name': 'alice' },
		];

		const report = makePlanReport([
			{ type: 'include-strategy', choice: 'join', context: { relation: 'author' } },
		]);

		hydrator.hydrateJoinIncludes(rows, report);

		expect(rows[0].author).toBeNull();
		expect(rows[1].author).toEqual({ id: 42, name: 'alice' });
	});

	it('skips null / non-object rows gracefully', () => {
		const model = createMockModel();
		const hydrator = new ResultHydrator(model as any, 'users');

		const rows: any[] = [null, { id: 1, 'author.id': 5, 'author.name': 'bob' }];

		const report = makePlanReport([
			{ type: 'include-strategy', choice: 'join', context: { relation: 'author' } },
		]);

		expect(() => hydrator.hydrateJoinIncludes(rows, report)).not.toThrow();
		expect(rows[1].author).toEqual({ id: 5, name: 'bob' });
	});

	it('no-ops when there are no join decisions', () => {
		const model = createMockModel();
		const hydrator = new ResultHydrator(model as any, 'users');

		const rows: any[] = [{ id: 1, name: 'alice' }];
		const report = makePlanReport([]);

		hydrator.hydrateJoinIncludes(rows, report);

		expect(rows[0]).toEqual({ id: 1, name: 'alice' });
	});
});

// ---------------------------------------------------------------------------
// FIND-056: extractKeyValue NUL-separator composite key edge cases
// ---------------------------------------------------------------------------

describe('ResultHydrator — composite key grouping via NUL separator (FIND-056)', () => {
	// We probe extractKeyValue indirectly via hydrateIncludes, which uses
	// it for Map-key grouping.  Correctness means: distinct composite PKs map
	// to distinct children; equal composite PKs map to the same parent bucket.

	async function runCompositeKeyHydration(
		parents: any[],
		children: any[],
		sourceKey: readonly string[],
		foreignKey: readonly string[],
	) {
		const model = createMockModel();
		const hydrator = new ResultHydrator(model as any, 'items');
		const adapter = createMockAdapter(children);

		await hydrator.hydrateIncludes(
			parents,
			[
				{
					relationName: 'tags',
					sourceKey,
					foreignKey,
					relationType: 'hasMany',
					subquery: {},
				} as any,
			],
			adapter as any,
			makeHydrateOptions(model),
		);
	}

	it('groups correctly for numeric composite PKs', async () => {
		const parents = [
			{ userId: 1, orgId: 10 },
			{ userId: 2, orgId: 20 },
		];
		const children = [
			{ userId: 1, orgId: 10, tag: 'ts' },
			{ userId: 2, orgId: 20, tag: 'js' },
			{ userId: 1, orgId: 10, tag: 'go' },
		];

		await runCompositeKeyHydration(parents, children, ['userId', 'orgId'], ['userId', 'orgId']);

		expect(parents[0].tags).toHaveLength(2);
		expect(parents[1].tags).toHaveLength(1);
		expect(parents[0].tags.map((t: any) => t.tag).sort()).toEqual(['go', 'ts']);
	});

	it('no collision between (1, 23) and (12, 3) — NUL separator is collision-safe', async () => {
		// (1, 23) => "1\u000023"  vs  (12, 3) => "12\u00003" — distinct keys
		const parents = [
			{ a: 1, b: 23 },
			{ a: 12, b: 3 },
		];
		const children = [
			{ a: 1, b: 23, tag: 'correct-a' },
			{ a: 12, b: 3, tag: 'correct-b' },
		];

		await runCompositeKeyHydration(parents, children, ['a', 'b'], ['a', 'b']);

		expect(parents[0].tags).toHaveLength(1);
		expect(parents[0].tags[0].tag).toBe('correct-a');
		expect(parents[1].tags).toHaveLength(1);
		expect(parents[1].tags[0].tag).toBe('correct-b');
	});

	it('no collision between ("user,1","org") and ("user","1,org") — NUL separator is collision-safe', async () => {
		// With a plain comma separator these two composite keys would be identical.
		// NUL gives: "user,1\u0000org" vs "user\u00001,org" — distinct.
		const parents = [
			{ a: 'user,1', b: 'org' },
			{ a: 'user', b: '1,org' },
		];
		const children = [
			{ a: 'user,1', b: 'org', tag: 'first' },
			{ a: 'user', b: '1,org', tag: 'second' },
		];

		await runCompositeKeyHydration(parents, children, ['a', 'b'], ['a', 'b']);

		expect(parents[0].tags).toHaveLength(1);
		expect(parents[0].tags[0].tag).toBe('first');
		expect(parents[1].tags).toHaveLength(1);
		expect(parents[1].tags[0].tag).toBe('second');
	});

	it('handles unicode PK strings without collision', async () => {
		const parents = [
			{ id1: 'αβγ', id2: 'δεζ' },
			{ id1: 'αβγδ', id2: 'εζ' },
		];
		const children = [
			{ id1: 'αβγ', id2: 'δεζ', tag: 'greek-a' },
			{ id1: 'αβγδ', id2: 'εζ', tag: 'greek-b' },
		];

		await runCompositeKeyHydration(parents, children, ['id1', 'id2'], ['id1', 'id2']);

		expect(parents[0].tags[0].tag).toBe('greek-a');
		expect(parents[1].tags[0].tag).toBe('greek-b');
	});

	it('handles mixed numeric + string PK components', async () => {
		const parents = [
			{ userId: 42, orgId: 'acme' },
			{ userId: 7, orgId: 'globex' },
		];
		const children = [
			{ userId: 42, orgId: 'acme', val: 'x' },
			{ userId: 7, orgId: 'globex', val: 'y' },
		];

		await runCompositeKeyHydration(parents, children, ['userId', 'orgId'], ['userId', 'orgId']);

		expect(parents[0].tags[0].val).toBe('x');
		expect(parents[1].tags[0].val).toBe('y');
	});
});
