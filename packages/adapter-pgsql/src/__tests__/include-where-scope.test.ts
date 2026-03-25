/**
 * INCLUDE-WHERE-SCOPE regression tests.
 *
 * Bug: include({ join: 'inner', where: eq('project_id', 42) }) did not filter
 * root rows because the WHERE conditions from the include intent were dropped
 * in toJoinIncludeDecision() (plan-decision-extractor.ts).
 *
 * Fix: toJoinIncludeDecision() now extracts `where` from the include intent and
 * converts it to `conditions` scoped to the joined table's alias. The compiler's
 * compileSelect() loop folds those conditions into the root WHERE clause.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('INCLUDE-WHERE-SCOPE: include({ join, where }) filters root rows', () => {
	it('compiles WHERE clause from include with join:inner and simple eq condition', () => {
		// Reproduces: orm.select('symbols')
		//   .include('file', { join: 'inner', where: eq('project_id', 42) })
		const plan: PlanReport = {
			rootTable: 'symbols',
			intent: {
				type: 'select',
				from: 'symbols',
				select: { type: 'fields', fields: ['id', 'name'] },
				include: [
					{
						relation: 'file',
						join: 'inner',
						where: {
							kind: 'comparison',
							field: 'project_id',
							operator: 'eq',
							value: 42,
						},
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
				{
					id: 'D2',
					type: 'join-type',
					choice: 'inner',
					context: {
						sourceTable: 'symbols',
						target: 'files',
						relation: 'file',
						intentPath: 'include[0]',
					},
					reasoning: 'explicit join:inner',
					alternatives: ['left'],
				},
			],
			warnings: [],
			rootTableAlias: undefined,
			schemaName: undefined,
		} as unknown as PlanReport;

		const result = compile(plan);
		const sql = normalizeSQL(result.sql);

		// Must have a JOIN on the files table (deparser renders INNER JOIN as 'JOIN')
		expect(sql).toMatch(/\bjoin\b/i);
		expect(sql).not.toMatch(/left join/i); // must not be LEFT JOIN
		expect(sql).toMatch(/file/i);

		// Must have a WHERE clause filtering by project_id on the joined alias
		expect(sql).toMatch(/where/i);
		expect(sql).toMatch(/project_id\s*=\s*\$1/i); // single parameter, no double-consume
		expect(result.parameters).toContain(42);
	});

	it('compiles WHERE clause from include with join:left and eq condition', () => {
		const plan: PlanReport = {
			rootTable: 'posts',
			intent: {
				type: 'select',
				from: 'posts',
				select: { all: true },
				include: [
					{
						relation: 'author',
						join: 'left',
						where: {
							kind: 'comparison',
							field: 'active',
							operator: 'eq',
							value: true,
						},
					},
				],
			},
			decisions: [
				{
					id: 'D1',
					type: 'include-strategy',
					choice: 'join',
					context: {
						sourceTable: 'posts',
						target: 'users',
						relation: 'author',
						relationType: 'belongsTo',
					},
					reasoning: 'explicit join:left',
					alternatives: [],
				},
			],
			warnings: [],
			rootTableAlias: undefined,
			schemaName: undefined,
		} as unknown as PlanReport;

		const result = compile(plan);
		const sql = normalizeSQL(result.sql);

		// WHERE clause with active = $1
		expect(sql).toMatch(/where/i);
		expect(sql).toMatch(/active\s*=\s*\$1/i);
		expect(result.parameters).toContain(true);
	});

	it('produces no WHERE clause when include has no where condition', () => {
		const plan: PlanReport = {
			rootTable: 'posts',
			intent: {
				type: 'select',
				from: 'posts',
				select: { all: true },
				include: [
					{
						relation: 'author',
						join: 'inner',
						// No where
					},
				],
			},
			decisions: [
				{
					id: 'D1',
					type: 'include-strategy',
					choice: 'join',
					context: {
						sourceTable: 'posts',
						target: 'users',
						relation: 'author',
						relationType: 'belongsTo',
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

		// JOIN present but no WHERE clause (join itself is the filter)
		expect(sql).toMatch(/join/i);
		expect(sql).not.toMatch(/\bwhere\b/i);
		expect(result.parameters).toHaveLength(0);
	});

	it('combines root-level WHERE and include WHERE correctly', () => {
		const plan: PlanReport = {
			rootTable: 'symbols',
			intent: {
				type: 'select',
				from: 'symbols',
				select: { all: true },
				where: {
					kind: 'comparison',
					field: 'type',
					operator: 'eq',
					value: 'function',
				},
				include: [
					{
						relation: 'file',
						join: 'inner',
						where: {
							kind: 'comparison',
							field: 'project_id',
							operator: 'eq',
							value: 7,
						},
					},
				],
			},
			decisions: [
				{
					id: 'D1',
					type: 'include-strategy',
					choice: 'join',
					context: {
						sourceTable: 'symbols',
						target: 'files',
						relation: 'file',
						relationType: 'belongsTo',
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

		// Both conditions must appear
		expect(sql).toMatch(/project_id\s*=\s*\$/i);
		expect(sql).toMatch(/type\s*=\s*\$/i);
		// Both parameter values present
		expect(result.parameters).toContain(7);
		expect(result.parameters).toContain('function');
	});
});
