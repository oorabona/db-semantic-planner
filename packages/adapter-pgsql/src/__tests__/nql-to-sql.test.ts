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

import { plan, ref, schema } from '@dbsp/core';
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

	const planReport = plan(compiled.ast.query, testSchema.model);

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
