import {
	plan as nativePlan,
	POSTGRESQL_CAPABILITIES,
	ref,
	schema,
} from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
/**
 * INCLUDE-WHERE-SCOPE regression tests.
 *
 * Bug: include({ join: 'inner', where: eq('project_id', 42) }) did not filter
 * root rows because the WHERE conditions from the include intent were dropped
 * in toJoinIncludeDecision() (plan-decision-extractor.ts).
 *
 * Fix: resolved include lowering retains the include WHERE and scopes it to
 * the joined range before SQL emission folds it into the root WHERE.
 */

import type { PlanReport } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const compileModel = schema({
	symbols: {
		id: 'integer',
		name: 'text',
		type: 'text',
		file_id: ref('files', { as: 'file' }),
	},
	files: { id: 'integer', project_id: 'integer' },
	posts: { id: 'integer', user_id: ref('users', { as: 'author' }) },
	users: { id: 'integer', active: 'boolean' },
}).model;

function compile(plan: PlanReport): {
	sql: string;
	parameters: readonly unknown[];
} {
	return createPgCompileOnlyAdapter({ model: compileModel }).compile(plan);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('INCLUDE-WHERE-SCOPE: include({ join, where }) filters root rows', () => {
	it('compiles WHERE clause from include with join:inner and simple eq condition', () => {
		// Reproduces: orm.select('symbols')
		//   .include('file', { join: 'inner', where: eq('project_id', 42) })
		const plan: PlanReport = nativePlan(
			{
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
			compileModel,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);

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
		const plan: PlanReport = nativePlan(
			{
				type: 'select',
				from: 'posts',
				select: { type: 'all' },
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
			compileModel,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);

		const result = compile(plan);
		const sql = normalizeSQL(result.sql);

		// WHERE clause with active = $1
		expect(sql).toMatch(/where/i);
		expect(sql).toMatch(/active\s*=\s*\$1/i);
		expect(result.parameters).toContain(true);
	});

	it('produces no WHERE clause when include has no where condition', () => {
		const plan: PlanReport = nativePlan(
			{
				type: 'select',
				from: 'posts',
				select: { type: 'all' },
				include: [
					{
						relation: 'author',
						join: 'inner',
						// No where
					},
				],
			},
			compileModel,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);

		const result = compile(plan);
		const sql = normalizeSQL(result.sql);

		// JOIN present but no WHERE clause (join itself is the filter)
		expect(sql).toMatch(/join/i);
		expect(sql).not.toMatch(/\bwhere\b/i);
		expect(result.parameters).toHaveLength(0);
	});

	it('combines root-level WHERE and include WHERE correctly', () => {
		const plan: PlanReport = nativePlan(
			{
				type: 'select',
				from: 'symbols',
				select: { type: 'all' },
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
			compileModel,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);

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
