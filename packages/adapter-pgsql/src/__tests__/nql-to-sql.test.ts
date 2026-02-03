/**
 * NQL → SQL Compile-Only Integration Tests
 *
 * Verifies the FULL pipeline without a database:
 *   NQL string → nql.compile() → plan() → adapter.compile() → SQL string
 *
 * This layer catches bugs that unit tests miss because they construct
 * PlanReport manually — here the planner produces real decisions from
 * real NQL input, and the adapter compiles them to real SQL.
 */

import {
	POSTGRESQL_CAPABILITIES,
	plan,
	type QueryIntent,
	ref,
	schema,
} from '@dbsp/core';
import { compile } from '@dbsp/nql';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Test schema: departments → employees (1:N)
// ---------------------------------------------------------------------------
const testSchema = schema({
	departments: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		budget: { type: 'decimal', nullable: true },
	},
	employees: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
		departmentId: ref('departments', {
			onDelete: 'CASCADE',
			inverse: 'employees',
		}),
		salary: 'decimal',
	},
});

// ---------------------------------------------------------------------------
// Helper: NQL → normalized SQL
// ---------------------------------------------------------------------------
function nqlToSQL(nql: string): string {
	const compiled = compile(nql, testSchema.model);
	if (!compiled.success || !compiled.ast?.query) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	const planReport = plan(compiled.ast.query, testSchema.model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});

	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(planReport, { model: testSchema.model });

	return normalizeSQL(result.sql);
}

describe('NQL → SQL compile-only pipeline', () => {
	it('compiles a simple select', () => {
		const sql = nqlToSQL('departments | select id, name');
		expect(sql).toContain('select');
		expect(sql).toContain('departments');
	});

	it('compiles a where clause with parameter', () => {
		const sql = nqlToSQL("departments | where name = 'Engineering'");
		expect(sql).toContain('name');
		expect(sql).toContain('$1');
	});

	it('compiles flat include with all columns', () => {
		const sql = nqlToSQL('departments | select *, employees.* | flat');
		// flat = non-nested strategy (join or lateral, planner decides)
		expect(sql).toContain('join');
		expect(sql).toContain('employees');
	});

	it('propagates specific columns through flat include', () => {
		const sql = nqlToSQL('departments | select id, employees.name | flat');
		// Must contain the specific column from the relation
		expect(sql).toContain('employees');
		expect(sql).toContain('.name');
		// Should NOT have employees.* — only the specific column
		expect(sql).not.toMatch(/employees\.\*/);
	});

	it('propagates multiple columns through flat include', () => {
		const sql = nqlToSQL(
			'departments | select id, employees.name, employees.email | flat',
		);
		expect(sql).toContain('.name');
		expect(sql).toContain('.email');
	});

	it('uses star for flat include with relation.*', () => {
		const sql = nqlToSQL('departments | select id, employees.* | flat');
		expect(sql).toContain('employees');
		// Should include employees columns (star or individual expansion)
	});

	it('compiles include without flat (json_agg or join)', () => {
		const sql = nqlToSQL('departments | select *, employees.*');
		// Planner picks best strategy (json_agg for 1:N, or join)
		expect(sql).toContain('employees');
	});

	it('compiles order by', () => {
		const sql = nqlToSQL('departments | order by name asc');
		expect(sql).toContain('order by');
		expect(sql).toContain('name');
	});

	it('compiles limit', () => {
		const sql = nqlToSQL('departments | limit 10');
		expect(sql).toContain('limit 10');
	});

	it('compiles where with relation column', () => {
		const sql = nqlToSQL('employees | where departmentId = 1');
		expect(sql).toContain('$1');
		expect(sql).toContain('departmentid');
	});

	it('propagates limit from IN subquery to SQL', () => {
		const sql = nqlToSQL(
			'departments | where id in (employees | select departmentId | limit 5)',
		);
		expect(sql).toContain('limit 5');
	});

	it('propagates order by from IN subquery to SQL', () => {
		const sql = nqlToSQL(
			'departments | where id in (employees | select departmentId | order by salary desc | limit 5)',
		);
		expect(sql).toContain('limit 5');
		expect(sql).toContain('order by');
	});

	// Regression test: specific relation columns must NOT produce star
	it('does not produce star when specific relation columns are selected', () => {
		const sql = nqlToSQL(
			'departments | select id, employees.name, employees.salary | flat',
		);
		// The SQL should contain .name and .salary for the relation
		expect(sql).toContain('.name');
		expect(sql).toContain('.salary');
		// But should NOT contain employees.* anywhere
		expect(sql).not.toMatch(/employees\.\*/);
	});
});

// ---------------------------------------------------------------------------
// ORM-level tests: Intent → Plan → SQL (for features NQL can't express yet)
// ---------------------------------------------------------------------------
describe('Intent → SQL compile-only pipeline', () => {
	function intentToSQL(intent: QueryIntent): string {
		const planReport = plan(intent, testSchema.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});
		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compile(planReport, { model: testSchema.model });
		return normalizeSQL(result.sql);
	}

	// NQL per-include limit: | limit <relation> N
	it('compiles per-include limit into LATERAL subquery via NQL', () => {
		const sql = nqlToSQL(
			'departments | select id, employees.* | limit employees 3 | flat',
		);
		// LATERAL should be used because per-include limit forces flat
		expect(sql).toContain('lateral');
		expect(sql).toContain('limit 3');
	});

	it('compiles per-include limit with implicit flat (no explicit | flat)', () => {
		const sql = nqlToSQL(
			'departments | select id, employees.* | limit employees 3',
		);
		// Even without explicit | flat, per-include limit forces LATERAL
		expect(sql).toContain('lateral');
		expect(sql).toContain('limit 3');
	});

	it('combines per-include limit with outer limit', () => {
		const sql = nqlToSQL(
			'departments | select id, employees.* | limit employees 3 | limit 5',
		);
		expect(sql).toContain('lateral');
		// Inner LATERAL limit
		expect(sql).toContain('limit 3');
		// Outer limit on the main query
		// Count occurrences of "limit" — should have both
		const limitMatches = sql.match(/limit \d+/g) ?? [];
		expect(limitMatches).toContain('limit 3');
		expect(limitMatches).toContain('limit 5');
	});

	// Regression: LATERAL subquery must contain LIMIT when include.limit is set
	it('propagates include.limit into LATERAL subquery', () => {
		const sql = intentToSQL({
			type: 'select',
			from: 'departments',
			select: { type: 'fields', fields: ['id', 'name'] },
			include: [
				{
					relation: 'employees',
					strategy: 'flat',
					limit: 3,
				},
			],
		});
		// LATERAL should be used (not plain LEFT JOIN) because limit is set
		expect(sql).toContain('lateral');
		// The LIMIT must appear inside the LATERAL subquery
		expect(sql).toContain('limit 3');
	});

	it('does not use LATERAL when include has no limit', () => {
		const sql = intentToSQL({
			type: 'select',
			from: 'departments',
			select: { type: 'fields', fields: ['id'] },
			include: [{ relation: 'employees', strategy: 'flat' }],
		});
		// Plain LEFT JOIN (no LATERAL) when no per-include limit
		expect(sql).toContain('left join');
		expect(sql).not.toContain('lateral');
	});

	it('includes parent columns with LATERAL and specific select', () => {
		const sql = intentToSQL({
			type: 'select',
			from: 'departments',
			select: { type: 'fields', fields: ['id', 'name'] },
			include: [
				{
					relation: 'employees',
					strategy: 'flat',
					limit: 5,
				},
			],
		});
		// Parent columns must appear in the SELECT
		expect(sql).toContain('departments.id');
		expect(sql).toContain('departments.name');
		// LATERAL subquery must have limit
		expect(sql).toContain('limit 5');
	});
});
