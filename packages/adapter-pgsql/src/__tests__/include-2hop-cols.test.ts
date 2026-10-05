import {
	plan as nativePlan,
	POSTGRESQL_CAPABILITIES,
	ref,
	schema,
} from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
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
import { normalizeSQL } from '../ast-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const compileModel = schema({
	calls: { id: 'integer', callee_id: ref('callees', { as: 'callee' }) },
	callees: {
		id: 'integer',
		name: 'text',
		file_id: ref('files', { as: 'file' }),
	},
	files: { id: 'integer', path: 'text' },
}).model;

function compile(plan: PlanReport): {
	sql: string;
	parameters: readonly unknown[];
} {
	return createPgCompileOnlyAdapter({ model: compileModel }).compile(plan);
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

	return nativePlan(
		{
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
		compileModel,
		{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
	);
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
		expect(sql).toMatch(/callee\.name\s+AS\s+"callee\.callee_name"/);
	});

	it('selects file.path with user-supplied alias file_path (2-hop)', () => {
		const { sql } = compile(buildPlan());
		// Alias may be unquoted (plain lowercase identifier) — match both forms
		expect(sql).toMatch(/file_path/);
		expect(sql).toMatch(/file\.path\s+AS\s+"callee\.file\.file_path"/);
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
		expect(sql).toMatch(/file\.path\s+AS\s+"callee\.file\.file_path"/);
	});

	it('works with only a 2-hop column and no 1-hop column', () => {
		const plan: PlanReport = nativePlan(
			{
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
			compileModel,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);

		expect(() => compile(plan)).not.toThrow();
		const { sql } = compile(plan);
		expect(sql).toMatch(/file_path/);
		expect(sql).toMatch(/file\.path\s+AS\s+"callee\.file\.file_path"/);
	});

	it('1-hop-only relationColumn still works (regression guard)', () => {
		const plan: PlanReport = nativePlan(
			{
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
			compileModel,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);

		expect(() => compile(plan)).not.toThrow();
		const { sql } = compile(plan);
		expect(sql).toMatch(/callee_name/);
		expect(sql).toMatch(/callee\.name\s+AS\s+"callee\.callee_name"/);
	});
});
