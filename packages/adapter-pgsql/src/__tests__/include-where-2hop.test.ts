/**
 * INCLUDE-WHERE-SCOPE-2HOP regression test.
 * Bug: 2nd-hop include WHERE condition was not applied
 * because toJoinIncludeDecision used flat find() missing nested includes.
 * Fix: uses resolveIncludeByPath() which traverses the nested tree.
 */

import type { PlanReport } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import type { AdapterCompilerDeps } from '../adapter-compiler-deps.js';
import { compileSelect } from '../adapter-compiler-select.js';
import { DEFAULT_PK_COLUMN, defaultFkDerivation } from '../assert-field.js';
import { normalizeSQL } from '../ast-helpers.js';
import { identityNaming } from '../naming-plugin.js';

const deps: AdapterCompilerDeps = {
	naming: identityNaming,
	schemaName: undefined,
	model: undefined,
	defaultPk: DEFAULT_PK_COLUMN,
	deriveFk: defaultFkDerivation,
};

function compile(plan: PlanReport): {
	sql: string;
	parameters: readonly unknown[];
} {
	return compileSelect(plan, undefined, deps);
}

describe('INCLUDE-WHERE-SCOPE-2HOP: 2-hop include WHERE compiled', () => {
	it('where on 2nd-hop include is applied to root query', () => {
		const plan: PlanReport = {
			rootTable: 'calls',
			intent: {
				type: 'select',
				from: 'calls',
				select: { type: 'fields', fields: ['id'] },
				include: [
					{
						relation: 'callee',
						join: 'inner',
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
						intentPath: 'include[0]',
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
						intentPath: 'include[0].include[0]',
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
		expect(sql).toMatch(/join/i);
		expect(sql).toMatch(/where/i);
		expect(sql).toContain('project_id');
		expect(result.parameters).toContain(42);
	});

	it('1-hop include WHERE still works (regression guard)', () => {
		const plan: PlanReport = {
			rootTable: 'symbols',
			intent: {
				type: 'select',
				from: 'symbols',
				select: { type: 'fields', fields: ['id'] },
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
		expect(sql).toMatch(/where/i);
		expect(sql).toContain('project_id');
		expect(result.parameters).toContain(7);
	});

	it('2-hop include without where produces no WHERE', () => {
		const plan: PlanReport = {
			rootTable: 'calls',
			intent: {
				type: 'select',
				from: 'calls',
				select: { type: 'fields', fields: ['id'] },
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
						intentPath: 'include[0]',
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
						intentPath: 'include[0].include[0]',
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
		expect(sql).toMatch(/join/i);
		expect(sql).not.toMatch(/\bwhere\b/i);
		expect(result.parameters).toHaveLength(0);
	});
});
