/**
 * INCLUDE-COUNT regression tests.
 *
 * Bug: include({ join: 'inner', where: ... }).count() generated invalid SQL by
 * mixing COUNT(*) with join column targets in the SELECT list, e.g.:
 *   SELECT COUNT(*), "file"."id" AS "file.id" FROM ...  -- PostgreSQL rejects this
 *
 * Fix: When the select intent is aggregate-only (no GROUP BY fields), join
 * includeStrategy decisions have their `columns` cleared so the join handler
 * emits only the JoinExpr (for filtering), not ResTarget column nodes.
 *
 * Expected SQL:
 *   SELECT COUNT(*) FROM "symbols" JOIN "files" ON ... WHERE "file"."project_id" = $1
 */

import type { PlanReport } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import type { AdapterCompilerDeps } from '../adapter-compiler-deps.js';
import { compileSelect } from '../adapter-compiler-select.js';
import { DEFAULT_PK_COLUMN, defaultFkDerivation } from '../assert-field.js';
import { normalizeSQL } from '../ast-helpers.js';
import { identityNaming } from '../naming-plugin.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const deps: AdapterCompilerDeps = {
	naming: identityNaming,
	defaultPk: DEFAULT_PK_COLUMN,
	deriveFk: defaultFkDerivation,
};

function compile(plan: PlanReport): {
	sql: string;
	parameters: readonly unknown[];
} {
	return compileSelect(plan, undefined, deps);
}

/** Minimal PlanReport for .count() with a join include. */
function makeCountWithJoinPlan(
	options: { joinType?: 'inner' | 'left'; withWhere?: boolean } = {},
): PlanReport {
	const { joinType = 'inner', withWhere = true } = options;
	return {
		rootTable: 'symbols',
		intent: {
			type: 'select',
			from: 'symbols',
			select: {
				type: 'aggregate',
				aggregates: [{ function: 'count' }],
				// No fields — aggregate-only
			},
			include: [
				{
					relation: 'file',
					join: joinType,
					...(withWhere && {
						where: {
							kind: 'comparison',
							field: 'project_id',
							operator: 'eq',
							value: 42,
						},
					}),
				},
			],
		},
		decisions: [
			{
				id: 'D1',
				type: 'include-strategy',
				choice: 'join',
				joinType,
				context: {
					sourceTable: 'symbols',
					target: 'files',
					relation: 'file',
					relationType: 'belongsTo',
					intentPath: 'include[0]',
				},
				reasoning: `explicit join:${joinType}`,
				alternatives: [],
			},
		],
		warnings: [],
		rootTableAlias: undefined,
		schemaName: undefined,
	} as unknown as PlanReport;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('INCLUDE-COUNT: include(join) + count() produces valid SQL', () => {
	it('SELECT is COUNT(*) only — no join columns in SELECT list', () => {
		const result = compile(makeCountWithJoinPlan());
		const sql = normalizeSQL(result.sql);

		// SELECT clause must be COUNT(*) only
		expect(sql).toMatch(/select\s+count\s*\(\s*\*\s*\)/i);
		// Must NOT contain any joined column targets (e.g., "file.id")
		expect(sql).not.toMatch(/"file\.\w+"/i);
		expect(sql).not.toMatch(/AS\s+"file\./i);
	});

	it('JOIN is still present for filtering', () => {
		const result = compile(makeCountWithJoinPlan());
		const sql = normalizeSQL(result.sql);

		expect(sql).toMatch(/\bjoin\b/i);
		expect(sql).toMatch(/files/i);
	});

	it('inner join: produces JOIN (not LEFT JOIN)', () => {
		const result = compile(makeCountWithJoinPlan({ joinType: 'inner' }));
		const sql = normalizeSQL(result.sql);

		expect(sql).toMatch(/\bjoin\b/i);
		expect(sql).not.toMatch(/left\s+join/i);
	});

	it('WHERE condition from include is applied', () => {
		const result = compile(makeCountWithJoinPlan({ withWhere: true }));
		const sql = normalizeSQL(result.sql);

		expect(sql).toMatch(/\bwhere\b/i);
		expect(sql).toMatch(/project_id\s*=\s*\$1/i);
		expect(result.parameters).toContain(42);
	});

	it('no GROUP BY generated', () => {
		const result = compile(makeCountWithJoinPlan());
		const sql = normalizeSQL(result.sql);

		expect(sql).not.toMatch(/\bgroup\s+by\b/i);
	});

	it('count() + join without where: JOIN present, no WHERE, no extra SELECT columns', () => {
		const result = compile(makeCountWithJoinPlan({ withWhere: false }));
		const sql = normalizeSQL(result.sql);

		expect(sql).toMatch(/select\s+count\s*\(\s*\*\s*\)/i);
		expect(sql).toMatch(/\bjoin\b/i);
		expect(sql).not.toMatch(/\bwhere\b/i);
		expect(sql).not.toMatch(/"file\.\w+"/i);
	});

	it('aggregate with GROUP BY fields still includes join columns (non-aggregate-only path)', () => {
		// When fields are present alongside aggregates, this is a GROUP BY query —
		// NOT aggregate-only. The fix must not clear join columns in this case.
		const plan: PlanReport = {
			rootTable: 'symbols',
			intent: {
				type: 'select',
				from: 'symbols',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count' }],
					fields: ['name'], // has GROUP BY field → NOT aggregate-only
				},
				include: [
					{
						relation: 'file',
						join: 'inner',
					},
				],
			},
			decisions: [
				{
					id: 'D1',
					type: 'include-strategy',
					choice: 'join',
					joinType: 'inner',
					context: {
						sourceTable: 'symbols',
						target: 'files',
						relation: 'file',
						relationType: 'belongsTo',
						intentPath: 'include[0]',
					},
					reasoning: 'explicit join:inner',
					alternatives: [],
				},
			],
			warnings: [],
			rootTableAlias: undefined,
			schemaName: undefined,
		} as unknown as PlanReport;

		const result = compile(plan);
		const sql = normalizeSQL(result.sql);

		// COUNT(*) still present
		expect(sql).toMatch(/count\s*\(\s*\*\s*\)/i);
		// JOIN present
		expect(sql).toMatch(/\bjoin\b/i);
		// 'name' field selected (GROUP BY scenario)
		expect(sql).toMatch(/\bname\b/i);
	});
});
