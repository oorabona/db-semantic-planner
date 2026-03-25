/**
 * INCLUDE-2HOP-COLS regression tests.
 *
 * Bug: relationColumn('callee.file', 'path', 'file_path') threw
 * "Unknown column 'path' in relation 'callee'" because the
 * relationColumnsMap used the root segment ('callee') as key, causing
 * the column to be injected into the 1st-hop includeStrategy decision
 * instead of the 2nd-hop one (relationName='file').
 *
 * Fix (adapter-compiler-select.ts): use the full relation path as the
 * map key and resolve via suffix matching when injecting columns into
 * the matching leaf includeStrategy decision.
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

/**
 * Build a minimal PlanReport for: calls → callee → file
 *   calls.callee_id → callees.id  (relation 'callee')
 *   callees.file_id → files.id    (relation 'file')
 */
function buildPlan(overrides?: {
	selectColumns?: string[];
	includeNestedColumns?: boolean;
	joinType?: 'inner' | 'left';
}): PlanReport {
	const {
		selectColumns = ['id'],
		includeNestedColumns = true,
		joinType = 'inner',
	} = overrides ?? {};

	const selectExpressions = [
		...selectColumns.map((c) => ({ kind: 'column' as const, column: c })),
		...(includeNestedColumns
			? [
					{
						kind: 'relationColumn' as const,
						relation: 'callee',
						column: 'name',
						as: 'callee_name',
					},
					{
						kind: 'relationColumn' as const,
						relation: 'callee.file',
						column: 'path',
						as: 'file_path',
					},
				]
			: []),
	];

	return {
		rootTable: 'calls',
		intent: {
			type: 'select',
			from: 'calls',
			select: {
				type: 'expressions',
				columns: selectExpressions,
			},
			include: [
				{
					relation: 'callee',
					join: joinType,
					include: [
						{
							relation: 'file',
							join: joinType,
						},
					],
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
					sourceTable: 'calls',
					target: 'callees',
					relation: 'callee',
					relationType: 'belongsTo',
					includeAlias: 'callee',
					intentPath: 'include[0]',
					foreignKey: 'callee_id',
				},
				reasoning: `explicit join:${joinType}`,
				alternatives: [],
			},
			{
				id: 'D2',
				type: 'include-strategy',
				choice: 'join',
				joinType,
				context: {
					sourceTable: 'callees',
					target: 'files',
					relation: 'file',
					relationType: 'belongsTo',
					includeAlias: 'file',
					intentPath: 'include[0].include[0]',
					foreignKey: 'file_id',
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

describe('INCLUDE-2HOP-COLS: 2nd-hop relation columns resolve to correct include', () => {
	it('does not throw when using relationColumn() for a 2nd-hop relation', () => {
		// Previously threw: "Unknown column 'path' in relation 'callee'"
		expect(() => compile(buildPlan())).not.toThrow();
	});

	it('produces JOINs for both callee and file hops', () => {
		const { sql } = compile(buildPlan());
		const normalized = normalizeSQL(sql);
		expect(normalized).toMatch(/join\s+callees\s+as\s+callee/i);
		expect(normalized).toMatch(/join\s+files\s+as\s+file/i);
	});

	it('selects callee.name with user-supplied alias callee_name (1-hop)', () => {
		const { sql } = compile(buildPlan());
		// Alias may be unquoted (plain lowercase identifier) — match both forms
		expect(sql).toMatch(/callee_name/);
		expect(sql).toMatch(/callee\.name\s+AS\s+callee_name/);
	});

	it('selects file.path with user-supplied alias file_path (2-hop)', () => {
		const { sql } = compile(buildPlan());
		// Alias may be unquoted (plain lowercase identifier) — match both forms
		expect(sql).toMatch(/file_path/);
		expect(sql).toMatch(/file\.path\s+AS\s+file_path/);
	});

	it('does not cross-contaminate: callee alias never references path, file alias never references name', () => {
		const { sql } = compile(buildPlan());
		expect(sql).not.toMatch(/callee\.path/);
		expect(sql).not.toMatch(/file\.name/);
	});

	it('works with LEFT JOIN as well as INNER JOIN', () => {
		const { sql } = compile(buildPlan({ joinType: 'left' }));
		const normalized = normalizeSQL(sql);
		expect(normalized).toMatch(/left join\s+callees/i);
		expect(normalized).toMatch(/left join\s+files/i);
		expect(sql).toMatch(/file_path/);
		expect(sql).toMatch(/file\.path\s+AS\s+file_path/);
	});

	it('works with only a 2-hop column and no 1-hop column', () => {
		const plan: PlanReport = {
			rootTable: 'calls',
			intent: {
				type: 'select',
				from: 'calls',
				select: {
					type: 'expressions',
					columns: [
						{ kind: 'column', column: 'id' },
						{
							kind: 'relationColumn',
							relation: 'callee.file',
							column: 'path',
							as: 'file_path',
						},
					],
				},
				include: [
					{
						relation: 'callee',
						join: 'inner',
						include: [{ relation: 'file', join: 'inner' }],
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
						sourceTable: 'calls',
						target: 'callees',
						relation: 'callee',
						relationType: 'belongsTo',
						includeAlias: 'callee',
						intentPath: 'include[0]',
						foreignKey: 'callee_id',
					},
					reasoning: 'explicit join:inner',
					alternatives: [],
				},
				{
					id: 'D2',
					type: 'include-strategy',
					choice: 'join',
					joinType: 'inner',
					context: {
						sourceTable: 'callees',
						target: 'files',
						relation: 'file',
						relationType: 'belongsTo',
						includeAlias: 'file',
						intentPath: 'include[0].include[0]',
						foreignKey: 'file_id',
					},
					reasoning: 'explicit join:inner',
					alternatives: [],
				},
			],
			warnings: [],
			rootTableAlias: undefined,
			schemaName: undefined,
		} as unknown as PlanReport;

		expect(() => compile(plan)).not.toThrow();
		const { sql } = compile(plan);
		expect(sql).toMatch(/file_path/);
		expect(sql).toMatch(/file\.path\s+AS\s+file_path/);
	});

	it('1-hop-only relationColumn still works (regression guard)', () => {
		const plan: PlanReport = {
			rootTable: 'calls',
			intent: {
				type: 'select',
				from: 'calls',
				select: {
					type: 'expressions',
					columns: [
						{ kind: 'column', column: 'id' },
						{
							kind: 'relationColumn',
							relation: 'callee',
							column: 'name',
							as: 'callee_name',
						},
					],
				},
				include: [
					{
						relation: 'callee',
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
						sourceTable: 'calls',
						target: 'callees',
						relation: 'callee',
						relationType: 'belongsTo',
						includeAlias: 'callee',
						intentPath: 'include[0]',
						foreignKey: 'callee_id',
					},
					reasoning: 'explicit join:inner',
					alternatives: [],
				},
			],
			warnings: [],
			rootTableAlias: undefined,
			schemaName: undefined,
		} as unknown as PlanReport;

		expect(() => compile(plan)).not.toThrow();
		const { sql } = compile(plan);
		expect(sql).toMatch(/callee_name/);
		expect(sql).toMatch(/callee\.name\s+AS\s+callee_name/);
	});
});
