// @ts-nocheck — perf regression / correctness proof tests for FIND-050, 054, 055, 056
import { describe, expect, it, vi } from 'vitest';
import type { PlanReport } from '../planner.js';
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
		execute: vi.fn().mockResolvedValue(executeReturn),
		executeOne: vi.fn(),
		executeOneOrThrow: vi.fn(),
		compileInsert: vi.fn(),
		compileInsertFrom: vi.fn(),
		compileUpdate: vi.fn(),
		compileDelete: vi.fn(),
		compileUpsert: vi.fn(),
		compileUpsertFrom: vi.fn(),
		compileRecursive: vi
			.fn()
			.mockReturnValue({ sql: 'WITH RECURSIVE ...', parameters: [] }),
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
			{
				type: 'include-strategy',
				choice: 'join',
				context: { relation: 'author' },
			},
			{
				type: 'include-strategy',
				choice: 'join',
				context: { relation: 'org' },
			},
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
			{
				type: 'include-strategy',
				choice: 'join',
				context: { relation: 'author' },
			},
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
			{
				type: 'include-strategy',
				choice: 'join',
				context: { relation: 'author' },
			},
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
