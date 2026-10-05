import {
	plan as nativePlan,
	POSTGRESQL_CAPABILITIES,
	ref,
	schema,
} from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
/**
 * INCLUDE-WHERE-SCOPE-2HOP regression test.
 * Bug: 2nd-hop include WHERE condition was not applied
 * because toJoinIncludeDecision used flat find() missing nested includes.
 * Fix: uses resolveIncludeByPath() which traverses the nested tree.
 */

import type { PlanReport } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';

const compileModel = schema({
	calls: { id: 'integer', callee_id: ref('callees', { as: 'callee' }) },
	symbols: { id: 'integer', file_id: ref('files', { as: 'file' }) },
	callees: { id: 'integer', file_id: ref('files', { as: 'file' }) },
	files: { id: 'integer', project_id: 'integer' },
}).model;

function compile(plan: PlanReport): {
	sql: string;
	parameters: readonly unknown[];
} {
	return createPgCompileOnlyAdapter({ model: compileModel }).compile(plan);
}

describe('INCLUDE-WHERE-SCOPE-2HOP: 2-hop include WHERE compiled', () => {
	it('where on 2nd-hop include is applied to root query', () => {
		const plan: PlanReport = nativePlan(
			{
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
			compileModel,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);

		const result = compile(plan);
		const sql = normalizeSQL(result.sql);
		expect(sql).toMatch(/join/i);
		expect(sql).toMatch(/where/i);
		expect(sql).toContain('project_id');
		expect(result.parameters).toContain(42);
	});

	it('1-hop include WHERE still works (regression guard)', () => {
		const plan: PlanReport = nativePlan(
			{
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
			compileModel,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);

		const result = compile(plan);
		const sql = normalizeSQL(result.sql);
		expect(sql).toMatch(/where/i);
		expect(sql).toContain('project_id');
		expect(result.parameters).toContain(7);
	});

	it('2-hop include without where produces no WHERE', () => {
		const plan: PlanReport = nativePlan(
			{
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
			compileModel,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);

		const result = compile(plan);
		const sql = normalizeSQL(result.sql);
		expect(sql).toMatch(/join/i);
		expect(sql).not.toMatch(/\bwhere\b/i);
		expect(result.parameters).toHaveLength(0);
	});
});
