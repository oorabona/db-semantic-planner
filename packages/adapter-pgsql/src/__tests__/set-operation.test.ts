/**
 * Tests for compileSetOperation — recursive set operation compilation
 * with correct parameter renumbering.
 */

import { plan, type QueryIntent, ref, schema } from '@dbsp/core';
import { compile } from '@dbsp/nql';
import type { CompiledNqlQuery, SetOperationIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';
import {
	compileSetOperation,
	createLeafCompileFn,
	type LeafCompileFn,
} from '../set-operation.js';

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
		departmentId: ref('departments', {
			onDelete: 'CASCADE',
			inverse: 'employees',
		}),
		salary: 'decimal',
		active: 'boolean',
	},
});

// ---------------------------------------------------------------------------
// Helper: create a leaf compile function for testing
// ---------------------------------------------------------------------------
function makeCompileFn(): LeafCompileFn {
	const adapter = createPgsqlCompileOnlyAdapter();
	return createLeafCompileFn(adapter, testSchema.model, plan);
}

/**
 * NQL → SQL via compileSetOperation (full pipeline).
 */
function setOpToSQL(nql: string): {
	sql: string;
	parameters: readonly unknown[];
} {
	const compiled = compile(nql, testSchema.model);
	if (!compiled.success) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	if (compiled.ast?.setOperation) {
		const compileFn = makeCompileFn();
		return compileSetOperation(compiled.ast.setOperation, compileFn);
	}
	throw new Error('NQL compilation produced no set operation');
}

function adapterSetOpToSQLWithParams(
	nql: string,
	params: Readonly<Record<string, unknown>>,
): {
	sql: string;
	parameters: readonly unknown[];
} {
	const compiled = compile(nql, testSchema.model, undefined, { params });
	if (!compiled.success || !compiled.ast?.setOperation) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	const adapter = createPgsqlCompileOnlyAdapter();
	return adapter.compileSetOperation(
		compiled.ast.setOperation,
		testSchema.model,
		{},
	);
}

function adapterNqlBundleToSQL(nql: string): {
	sql: string;
	parameters: readonly unknown[];
} {
	const compiled = compile(nql, testSchema.model);
	if (!compiled.success || !compiled.ast) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(compiled.ast, { model: testSchema.model });
	return {
		sql: normalizeSQL(result.sql),
		parameters: result.parameters,
	};
}

function boundSetOpBundleToSQL(
	op: 'union' | 'intersect' | 'except',
	schemaName: string,
): {
	sql: string;
	parameters: readonly unknown[];
} {
	const bindingQuery: QueryIntent = {
		type: 'select',
		from: 'employees',
		select: { type: 'fields', fields: ['id'] },
		where: {
			kind: 'comparison',
			field: 'active',
			operator: 'eq',
			value: true,
		},
	};
	const bundle: CompiledNqlQuery = {
		setOperation: {
			kind: 'setOperation',
			op,
			all: false,
			left: {
				type: 'select',
				from: 'employees',
				select: { type: 'fields', fields: ['id'] },
				where: {
					kind: 'in',
					field: 'id',
					subquery: {
						type: 'select',
						from: 'active_employees',
						select: { type: 'fields', fields: ['id'] },
					},
				},
			},
			right: {
				type: 'select',
				from: 'departments',
				select: { type: 'fields', fields: ['id'] },
			},
		},
		bindings: new Map([['active_employees', bindingQuery]]),
	};
	const adapter = createPgsqlCompileOnlyAdapter();
	return adapter.compile(bundle, { model: testSchema.model, schemaName });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('compileSetOperation', () => {
	describe('simple set operations', () => {
		it('compiles UNION', () => {
			const result = setOpToSQL(
				'employees | select name | union (departments | select name)',
			);
			const normalized = normalizeSQL(result.sql);
			expect(normalized).toMatch(/^\(.+\) union \(.+\)$/);
			expect(normalized).toContain('employees');
			expect(normalized).toContain('departments');
			expect(result.parameters).toEqual([]);
		});

		it('compiles UNION ALL', () => {
			const result = setOpToSQL(
				'employees | select name | union all (departments | select name)',
			);
			const normalized = normalizeSQL(result.sql);
			expect(normalized).toContain('union all');
			expect(result.parameters).toEqual([]);
		});

		it('compiles INTERSECT', () => {
			const result = setOpToSQL(
				'employees | select name | intersect (departments | select name)',
			);
			const normalized = normalizeSQL(result.sql);
			expect(normalized).toContain('intersect');
			expect(result.parameters).toEqual([]);
		});

		it('compiles EXCEPT', () => {
			const result = setOpToSQL(
				'employees | select name | except (departments | select name)',
			);
			const normalized = normalizeSQL(result.sql);
			expect(normalized).toContain('except');
			expect(result.parameters).toEqual([]);
		});
	});

	describe('parameter renumbering', () => {
		it('renumbers right-side parameters when left has params', () => {
			const result = setOpToSQL(
				'employees | where salary > 50000 | select name | union (employees | where salary < 30000 | select name)',
			);
			// Left has $1 (50000), right has $1 (30000) → must become $2
			expect(result.parameters).toEqual([50000, 30000]);
			// Verify the right side uses $2
			expect(result.sql).toContain('$1');
			expect(result.sql).toContain('$2');
		});

		it('merges parameters from both sides correctly', () => {
			const result = setOpToSQL(
				'employees | where active = true | select name | except (employees | where active = false | select name)',
			);
			expect(result.parameters).toEqual([true, false]);
		});

		for (const op of ['union', 'intersect', 'except'] as const) {
			it(`binds explicit NQL param nodes through ${op.toUpperCase()} leaves`, () => {
				const fieldRefShaped = { kind: 'fieldRef', column: 'name' };
				const result = adapterSetOpToSQLWithParams(
					`employees | where name = :left | select name | ${op} (employees | where name = :right | select name)`,
					{ left: fieldRefShaped, right: null },
				);
				const normalized = normalizeSQL(result.sql);

				expect(normalized).toContain('employees.name = $1');
				expect(normalized).toContain('employees.name = $2');
				expect(normalized).not.toContain('employees.name = employees.name');
				expect(normalized).not.toContain('employees.name = null');
				expect(result.parameters).toEqual([fieldRefShaped, null]);
			});
		}

		for (const op of ['union', 'intersect', 'except'] as const) {
			it(`keeps bound CTE set-operation ${op.toUpperCase()} leaves unqualified under schema scoping`, () => {
				const result = boundSetOpBundleToSQL(op, 'tenant_set');
				const normalized = normalizeSQL(result.sql);

				expect(normalized).toContain('with "active_employees" as (');
				expect(normalized).toContain('from tenant_set.employees');
				expect(normalized).toContain('from active_employees as');
				expect(normalized).not.toContain('from tenant_set.active_employees');
				expect(result.parameters).toEqual([true]);
			});
		}

		for (const op of ['union', 'intersect', 'except'] as const) {
			it(`compiles binding-final left leaf through ${op.toUpperCase()}`, () => {
				const result = adapterNqlBundleToSQL(
					`employees | select name | bind employee_names
employee_names | select name | ${op} (departments | select name)`,
				);

				expect(result.sql).toContain('with "employee_names" as (');
				expect(result.sql).toContain('from employee_names');
				expect(result.parameters).toEqual([]);
			});

			it(`compiles binding-final inline right leaf through ${op.toUpperCase()}`, () => {
				const result = adapterNqlBundleToSQL(
					`employees | select name | bind employee_names
departments | select name | ${op} (employee_names | select name)`,
				);

				expect(result.sql).toContain('with "employee_names" as (');
				expect(result.sql).toContain('from employee_names');
				expect(result.parameters).toEqual([]);
			});
		}

		it('compiles a bound set-operation leaf whose source is another binding', () => {
			const result = adapterNqlBundleToSQL(
				`employees | select name | bind employee_names
employee_names | select name | bind projected_names
departments | select name | union projected_names`,
			);

			expect(result.sql).toContain('with "employee_names" as (');
			expect(result.sql).toContain('"projected_names" as (select');
			expect(result.sql).toContain('from employee_names');
			expect(result.parameters).toEqual([]);
		});

		it('compiles binding-final leaves recursively inside nested set operations', () => {
			const result = adapterNqlBundleToSQL(
				`employees | select name | bind employee_names
departments | select name | union (employee_names | select name | except (departments | select name))`,
			);

			expect(result.sql).toContain('with "employee_names" as (');
			expect(result.sql).toContain('union');
			expect(result.sql).toContain('except');
			expect(result.sql).toContain('from employee_names');
			expect(result.parameters).toEqual([]);
		});

		it('handles no parameters on either side', () => {
			const result = setOpToSQL(
				'employees | select name | union (departments | select name)',
			);
			expect(result.parameters).toEqual([]);
		});
	});

	describe('nested set operations', () => {
		it('compiles A UNION (B INTERSECT C) via nested parentheses', () => {
			const result = setOpToSQL(
				'employees | select name | union (departments | select name | intersect (departments | select name))',
			);
			const normalized = normalizeSQL(result.sql);
			// Should produce nested structure: (A) UNION ((B) INTERSECT (C))
			expect(normalized).toContain('union');
			expect(normalized).toContain('intersect');
		});

		it('renumbers parameters across nested operations', () => {
			const result = setOpToSQL(
				'employees | where salary > 50000 | select name | union (employees | where salary < 30000 | select name | except (employees | where salary = 40000 | select name))',
			);
			// Three parameter sets should be merged: $1=50000, $2=30000, $3=40000
			expect(result.parameters).toEqual([50000, 30000, 40000]);
			expect(result.sql).toContain('$1');
			expect(result.sql).toContain('$2');
			expect(result.sql).toContain('$3');
		});
	});

	describe('with createLeafCompileFn', () => {
		it('creates a working compile function', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const compileFn = createLeafCompileFn(adapter, testSchema.model, plan);

			// Manually build a simple set operation intent
			const leftQuery: QueryIntent = {
				type: 'select',
				from: 'employees',
				select: { type: 'fields', fields: ['name'] },
			};
			const rightQuery: QueryIntent = {
				type: 'select',
				from: 'departments',
				select: { type: 'fields', fields: ['name'] },
			};
			const setOp: SetOperationIntent = {
				kind: 'setOperation',
				op: 'union',
				all: false,
				left: leftQuery,
				right: rightQuery,
			};

			const result = compileSetOperation(setOp, compileFn);
			// Verify structure: parenthesized left UNION parenthesized right
			const normalized = normalizeSQL(result.sql);
			expect(normalized).toContain('union');
			expect(normalized).toMatch(
				/^\(select .+ from .+\) union \(select .+ from .+\)$/,
			);
			expect(result.parameters).toEqual([]);
			expect(result.columnMetadata).toBeUndefined();
		});

		it('fails loud through envelope finalization when a branch carries js metadata', () => {
			const jsSchema = schema({
				events: {
					id: { type: 'integer', primaryKey: true },
					sequence: { type: 'bigint', js: 'bigint' },
				},
			});
			const adapter = createPgsqlCompileOnlyAdapter();
			const compileFn = createLeafCompileFn(adapter, jsSchema.model, plan);
			const setOp: SetOperationIntent = {
				kind: 'setOperation',
				op: 'union',
				all: false,
				left: {
					type: 'select',
					from: 'events',
					select: { type: 'fields', fields: ['sequence'] },
				},
				right: {
					type: 'select',
					from: 'events',
					select: { type: 'fields', fields: ['sequence'] },
				},
			};

			expect(() => compileSetOperation(setOp, compileFn)).toThrow(
				'`js` read type is not yet supported through set operations; use a plain select (tracking: #352)',
			);
		});

		it('works with nested set operations built manually', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const compileFn = createLeafCompileFn(adapter, testSchema.model, plan);

			const queryA: QueryIntent = {
				type: 'select',
				from: 'employees',
				select: { type: 'fields', fields: ['name'] },
				where: {
					kind: 'comparison',
					field: 'salary',
					operator: 'gt',
					value: 50000,
				},
			};
			const queryB: QueryIntent = {
				type: 'select',
				from: 'employees',
				select: { type: 'fields', fields: ['name'] },
				where: {
					kind: 'comparison',
					field: 'salary',
					operator: 'lt',
					value: 30000,
				},
			};
			const queryC: QueryIntent = {
				type: 'select',
				from: 'departments',
				select: { type: 'fields', fields: ['name'] },
			};

			const inner: SetOperationIntent = {
				kind: 'setOperation',
				op: 'union',
				all: true,
				left: queryA,
				right: queryB,
			};

			const outer: SetOperationIntent = {
				kind: 'setOperation',
				op: 'except',
				all: false,
				left: inner.left, // use queryA as left of outer
				right: inner, // entire UNION ALL as right
			};

			// Actually, let's test a proper nested: (A UNION ALL B) EXCEPT C
			const nested: SetOperationIntent = {
				kind: 'setOperation',
				op: 'except',
				all: false,
				left: queryA,
				right: {
					kind: 'setOperation',
					op: 'union',
					all: true,
					left: queryB,
					right: queryC,
				},
			};

			const result = compileSetOperation(nested, compileFn);
			// A has 1 param ($1=50000), B has 1 param → $2=30000, C has 0 params
			expect(result.parameters).toEqual([50000, 30000]);
			expect(result.sql).toContain('EXCEPT');
			expect(result.sql).toContain('UNION ALL');
		});
	});

	describe('edge cases', () => {
		it('handles INTERSECT ALL', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const compileFn = createLeafCompileFn(adapter, testSchema.model, plan);

			const setOp: SetOperationIntent = {
				kind: 'setOperation',
				op: 'intersect',
				all: true,
				left: {
					type: 'select',
					from: 'employees',
					select: { type: 'fields', fields: ['name'] },
				},
				right: {
					type: 'select',
					from: 'departments',
					select: { type: 'fields', fields: ['name'] },
				},
			};

			const result = compileSetOperation(setOp, compileFn);
			expect(normalizeSQL(result.sql)).toContain('intersect all');
		});

		it('handles EXCEPT ALL', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const compileFn = createLeafCompileFn(adapter, testSchema.model, plan);

			const setOp: SetOperationIntent = {
				kind: 'setOperation',
				op: 'except',
				all: true,
				left: {
					type: 'select',
					from: 'employees',
					select: { type: 'fields', fields: ['name'] },
				},
				right: {
					type: 'select',
					from: 'departments',
					select: { type: 'fields', fields: ['name'] },
				},
			};

			const result = compileSetOperation(setOp, compileFn);
			expect(normalizeSQL(result.sql)).toContain('except all');
		});
	});
});
