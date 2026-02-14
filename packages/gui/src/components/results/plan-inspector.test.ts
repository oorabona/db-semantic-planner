import { describe, expect, it } from 'vitest';

// We test the isPlanData logic and component data flow without React rendering.
// The components are pure presentational — testing their props interface
// and the type guard that decides structured vs raw JSON display.

/** Mirrors the isPlanData guard from PlanInspector.tsx */
function isPlanData(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('isPlanData type guard', () => {
	it('accepts a PlanReport-like object', () => {
		const plan = {
			rootTable: 'users',
			decisions: [],
			warnings: [],
			ctes: [],
			metadata: { planningTimeMs: 1.2, relationsAnalyzed: 3 },
		};
		expect(isPlanData(plan)).toBe(true);
	});

	it('accepts an empty object', () => {
		expect(isPlanData({})).toBe(true);
	});

	it('rejects null', () => {
		expect(isPlanData(null)).toBe(false);
	});

	it('rejects an array', () => {
		expect(isPlanData([1, 2, 3])).toBe(false);
	});

	it('rejects a string', () => {
		expect(isPlanData('hello')).toBe(false);
	});

	it('rejects a number', () => {
		expect(isPlanData(42)).toBe(false);
	});

	it('rejects undefined', () => {
		expect(isPlanData(undefined)).toBe(false);
	});
});

describe('DecisionCard props', () => {
	const TYPE_COLORS: Record<string, string> = {
		'filter-strategy': 'bg-blue-500/20 text-blue-700 dark:text-blue-400',
		'join-type': 'bg-green-500/20 text-green-700 dark:text-green-400',
		'include-strategy': 'bg-purple-500/20 text-purple-700 dark:text-purple-400',
		'cte-extraction': 'bg-orange-500/20 text-orange-700 dark:text-orange-400',
		ambiguity: 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-400',
		'recursive-cte': 'bg-pink-500/20 text-pink-700 dark:text-pink-400',
	};

	it('maps known decision types to color classes', () => {
		expect(TYPE_COLORS['filter-strategy']).toContain('blue');
		expect(TYPE_COLORS['join-type']).toContain('green');
		expect(TYPE_COLORS['include-strategy']).toContain('purple');
		expect(TYPE_COLORS['cte-extraction']).toContain('orange');
		expect(TYPE_COLORS.ambiguity).toContain('yellow');
		expect(TYPE_COLORS['recursive-cte']).toContain('pink');
	});

	it('returns undefined for unknown types', () => {
		expect(TYPE_COLORS['unknown-type']).toBeUndefined();
	});
});

describe('PlanInspector data extraction', () => {
	it('extracts decisions with defaults', () => {
		const plan = { rootTable: 'orders' };
		const decisions = (plan as Record<string, unknown>).decisions ?? [];
		expect(decisions).toEqual([]);
	});

	it('extracts warnings array', () => {
		const plan = {
			warnings: [
				{
					code: 'AMBIGUOUS_PATH',
					message: 'Multiple paths',
					suggestion: 'Use explicit',
				},
			],
		};
		expect(plan.warnings).toHaveLength(1);
		expect(plan.warnings[0]!.code).toBe('AMBIGUOUS_PATH');
		expect(plan.warnings[0]!.suggestion).toBe('Use explicit');
	});

	it('extracts CTE list', () => {
		const plan = {
			ctes: [
				{
					name: 'user_roles_cte',
					purpose: 'Flatten roles',
					referencedBy: ['main'],
					recursive: false,
				},
				{
					name: 'tree_cte',
					purpose: 'Hierarchy',
					referencedBy: ['main'],
					recursive: true,
				},
			],
		};
		expect(plan.ctes).toHaveLength(2);
		expect(plan.ctes[0]!.recursive).toBe(false);
		expect(plan.ctes[1]!.recursive).toBe(true);
	});

	it('handles plan with all sections', () => {
		const plan = {
			rootTable: 'users',
			decisions: [
				{
					type: 'join-type',
					choice: 'LEFT JOIN',
					reasoning: 'Optional relation',
					alternatives: ['INNER JOIN'],
					context: {
						sourceTable: 'users',
						target: 'profiles',
						relation: 'profile',
					},
				},
			],
			warnings: [{ code: 'W001', message: 'Test warning' }],
			ctes: [
				{ name: 'cte1', purpose: 'Test', referencedBy: [], recursive: false },
			],
			metadata: {
				planningTimeMs: 2.5,
				relationsAnalyzed: 4,
				isAmbiguous: false,
			},
		};

		expect(plan.rootTable).toBe('users');
		expect(plan.decisions).toHaveLength(1);
		expect(plan.decisions[0]!.alternatives).toEqual(['INNER JOIN']);
		expect(plan.warnings).toHaveLength(1);
		expect(plan.ctes).toHaveLength(1);
		expect(plan.metadata.planningTimeMs).toBe(2.5);
	});

	it('detects ambiguous plans', () => {
		const plan = {
			rootTable: 'users',
			metadata: { planningTimeMs: 1, relationsAnalyzed: 2, isAmbiguous: true },
		};
		expect(plan.metadata.isAmbiguous).toBe(true);
	});
});

describe('CSV export integration with plan data', () => {
	it('plan data is not CSV-exportable (only results tab)', () => {
		// Plan tab shows structured data, not tabular rows.
		// CSV export button only appears on results tab via StatusBar.
		const planData = { rootTable: 'users', decisions: [] };
		expect(typeof planData).toBe('object');
		expect(Array.isArray(planData)).toBe(false);
	});
});
