/**
 * Tests for adapter.compileSetOperation — a set operation compiles into one
 * tree, its right operand's parameters shifted in the tree (ADR 0012).
 */

import {
	createOrm,
	eq,
	exprRef,
	fn,
	literal,
	nqlRaw,
	type QueryIntent,
	ref,
	schema,
} from '@dbsp/core';
import { compile } from '@dbsp/nql';
import type {
	CompiledNqlQuery,
	CompiledQuery,
	Dump,
	SetOperationIntent,
} from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { builtShape, parsedShape } from './statement-shape.js';

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

/**
 * NQL → SQL via adapter.compileSetOperation (full pipeline).
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
		return createPgCompileOnlyAdapter().compileSetOperation(
			compiled.ast.setOperation,
			testSchema.model,
		);
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

	const adapter = createPgCompileOnlyAdapter();
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

	const adapter = createPgCompileOnlyAdapter();
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
	const adapter = createPgCompileOnlyAdapter();
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
			expect(normalized).toBe(
				'select employees.name from employees union select departments.name from departments',
			);
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

				expect(normalized).toContain('with active_employees as (');
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

				expect(result.sql).toContain('with employee_names as (');
				expect(result.sql).toContain('from employee_names');
				expect(result.parameters).toEqual([]);
			});

			it(`compiles binding-final inline right leaf through ${op.toUpperCase()}`, () => {
				const result = adapterNqlBundleToSQL(
					`employees | select name | bind employee_names
departments | select name | ${op} (employee_names | select name)`,
				);

				expect(result.sql).toContain('with employee_names as (');
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

			expect(result.sql).toContain('with employee_names as (');
			expect(result.sql).toContain('projected_names as (select');
			expect(result.sql).toContain('from employee_names');
			expect(result.parameters).toEqual([]);
		});

		it('compiles binding-final leaves recursively inside nested set operations', () => {
			const result = adapterNqlBundleToSQL(
				`employees | select name | bind employee_names
departments | select name | union (employee_names | select name | except (departments | select name))`,
			);

			expect(result.sql).toContain('with employee_names as (');
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

	describe('through adapter.compileSetOperation', () => {
		it('compiles a manually built set operation', () => {
			const adapter = createPgCompileOnlyAdapter();

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

			const result = adapter.compileSetOperation(setOp, testSchema.model);
			expect(result.sql).toBe(
				'SELECT employees.name FROM employees UNION SELECT departments.name FROM departments',
			);
			expect(result.parameters).toEqual([]);
			expect(result.columnMetadata?.size).toBe(0);
		});

		it('fails loud through envelope finalization when a branch carries js metadata', () => {
			const jsSchema = schema({
				events: {
					id: { type: 'integer', primaryKey: true },
					sequence: { type: 'bigint', js: 'bigint' },
				},
			});
			const adapter = createPgCompileOnlyAdapter();
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

			expect(() => adapter.compileSetOperation(setOp, jsSchema.model)).toThrow(
				'`js` read type is not yet supported through set operations; use a plain select (tracking: #352)',
			);
		});

		it('works with nested set operations built manually', () => {
			const adapter = createPgCompileOnlyAdapter();

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

			const result = adapter.compileSetOperation(nested, testSchema.model);
			// A has 1 param ($1=50000), B has 1 param → $2=30000, C has 0 params
			expect(result.parameters).toEqual([50000, 30000]);
			expect(result.sql).toContain('EXCEPT');
			expect(result.sql).toContain('UNION ALL');
		});
	});

	describe('edge cases', () => {
		it('handles INTERSECT ALL', () => {
			const adapter = createPgCompileOnlyAdapter();

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

			const result = adapter.compileSetOperation(setOp, testSchema.model);
			expect(normalizeSQL(result.sql)).toContain('intersect all');
		});

		it('handles EXCEPT ALL', () => {
			const adapter = createPgCompileOnlyAdapter();

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

			const result = adapter.compileSetOperation(setOp, testSchema.model);
			expect(normalizeSQL(result.sql)).toContain('except all');
		});
	});
});

// ---------------------------------------------------------------------------
// One tree per set operation (ADR 0012)
// ---------------------------------------------------------------------------
const itemSchema = schema({
	items: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		cost$1: { type: 'string', nullable: true },
	},
});

/** An ORM whose adapter records the CompiledQuery each set operation returns. */
function recordingOrm() {
	const adapter = createPgCompileOnlyAdapter();
	const compileSetOperation = vi.spyOn(adapter, 'compileSetOperation');
	const compileBundle = vi.spyOn(adapter, 'compile');
	const orm = createOrm({ schema: itemSchema, adapter });
	const lastCompiled = (): CompiledQuery => {
		const spy = [compileSetOperation, compileBundle].find(
			(candidate) => candidate.mock.results.length > 0,
		);
		const result = spy?.mock.results.at(-1);
		if (result?.type !== 'return') throw new Error('nothing was compiled');
		return result.value as CompiledQuery;
	};
	return { orm, lastCompiled };
}

function nqlSetOperation(text: string): {
	sql: string;
	params: readonly unknown[];
	built: CompiledQuery;
} {
	const { orm, lastCompiled } = recordingOrm();
	const dump = orm.nql`${nqlRaw(text)}`.dump() as Dump;
	return { sql: dump.sql, params: dump.params, built: lastCompiled() };
}

const plainOperand = { sort: false, limit: false, offset: false, lock: false };

describe('one tree per set operation (ADR 0012)', () => {
	it('AC1 set-op-constant: keeps a $-constant and a $-column on the right side and shifts its parameter', () => {
		const { orm } = recordingOrm();
		const left = orm
			.select('items')
			.columns(['id', 'name'])
			.where(eq('name', 'a'));
		const right = orm
			.select('items')
			.columns([
				'id',
				fn('concat', literal('Price: $1'), exprRef('cost$1')).as('name'),
			])
			.where(eq('cost$1', 'b'));

		const dump = left.union(right).dump();

		expect(dump.sql).toBe(
			'SELECT items.id, items.name FROM items WHERE items.name = $1 UNION SELECT items.id, concat(\'Price: $1\', "cost$1") AS name FROM items WHERE items."cost$1" = $2',
		);
		expect(dump.params).toEqual(['a', 'b']);
	});

	it('AC1b union-intersect-grouping: q1.union(q2).intersect(q3) parses with INTERSECT at the root over the UNION', () => {
		const { orm, lastCompiled } = recordingOrm();
		const q = (name: string) =>
			orm.select('items').columns(['id']).where(eq('name', name));

		const dump = q('a').union(q('b')).intersect(q('c')).dump();

		expect(dump.sql).toBe(
			'(SELECT items.id FROM items WHERE items.name = $1 UNION SELECT items.id FROM items WHERE items.name = $2) INTERSECT SELECT items.id FROM items WHERE items.name = $3',
		);
		expect(dump.params).toEqual(['a', 'b', 'c']);
		const expected = {
			op: 'SETOP_INTERSECT',
			all: false,
			larg: {
				op: 'SETOP_UNION',
				all: false,
				larg: plainOperand,
				rarg: plainOperand,
			},
			rarg: plainOperand,
		};
		expect(parsedShape(dump.sql)).toEqual(expected);
		expect(builtShape(lastCompiled())).toEqual(expected);
	});

	it('AC1b union-all-nested-grouping: A UNION ALL (B UNION C) keeps its grouping', () => {
		const { sql, params, built } = nqlSetOperation(
			"items | where name = 'a' | select id | union all (items | where name = 'b' | select id | union (items | where name = 'c' | select id))",
		);

		expect(sql).toBe(
			'SELECT items.id FROM items WHERE items.name = $1 UNION ALL (SELECT items.id FROM items WHERE items.name = $2 UNION SELECT items.id FROM items WHERE items.name = $3)',
		);
		expect(params).toEqual(['a', 'b', 'c']);
		const expected = {
			op: 'SETOP_UNION',
			all: true,
			larg: plainOperand,
			rarg: {
				op: 'SETOP_UNION',
				all: false,
				larg: plainOperand,
				rarg: plainOperand,
			},
		};
		expect(parsedShape(sql)).toEqual(expected);
		expect(builtShape(built)).toEqual(expected);
	});

	it('AC1c left-order-by: an ORDER BY stays on the left operand', () => {
		const { sql, built } = nqlSetOperation(
			'items | select id | order by id | union (items | select id)',
		);

		expect(sql).toBe(
			'(SELECT items.id FROM items ORDER BY items.id ASC) UNION SELECT items.id FROM items',
		);
		const expected = {
			op: 'SETOP_UNION',
			all: false,
			larg: { ...plainOperand, sort: true },
			rarg: plainOperand,
		};
		expect(parsedShape(sql)).toEqual(expected);
		expect(builtShape(built)).toEqual(expected);
	});

	it('AC1c right-offset: an OFFSET stays on the right operand', () => {
		const { sql, built } = nqlSetOperation(
			'items | select id | union (items | select id | offset 1)',
		);

		expect(sql).toBe(
			'SELECT items.id FROM items UNION (SELECT items.id FROM items OFFSET 1)',
		);
		const expected = {
			op: 'SETOP_UNION',
			all: false,
			larg: plainOperand,
			rarg: { ...plainOperand, offset: true },
		};
		expect(parsedShape(sql)).toEqual(expected);
		expect(builtShape(built)).toEqual(expected);
	});

	it('AC1c left-limit-valid: a left operand with LIMIT is valid SQL with the limit on it', () => {
		const { sql, built } = nqlSetOperation(
			'items | select id | limit 2 | union (items | select id)',
		);

		expect(sql).toBe(
			'(SELECT items.id FROM items LIMIT 2) UNION SELECT items.id FROM items',
		);
		const expected = {
			op: 'SETOP_UNION',
			all: false,
			larg: { ...plainOperand, limit: true },
			rarg: plainOperand,
		};
		expect(parsedShape(sql)).toEqual(expected);
		expect(builtShape(built)).toEqual(expected);
	});

	it('AC1c right-limit: a right operand LIMIT stays on that operand', () => {
		const { sql, built } = nqlSetOperation(
			'items | select id | union (items | select id | limit 1)',
		);

		expect(sql).toBe(
			'SELECT items.id FROM items UNION (SELECT items.id FROM items LIMIT 1)',
		);
		const expected = {
			op: 'SETOP_UNION',
			all: false,
			larg: plainOperand,
			rarg: { ...plainOperand, limit: true },
		};
		expect(parsedShape(sql)).toEqual(expected);
		expect(builtShape(built)).toEqual(expected);
	});

	it.each([
		[
			'items | select id | except (items | select id | intersect (items | select id))',
			'SELECT items.id FROM items EXCEPT (SELECT items.id FROM items INTERSECT SELECT items.id FROM items)',
			'SETOP_EXCEPT',
			'SETOP_INTERSECT',
		],
		[
			'items | select id | intersect (items | select id | except (items | select id))',
			'SELECT items.id FROM items INTERSECT (SELECT items.id FROM items EXCEPT SELECT items.id FROM items)',
			'SETOP_INTERSECT',
			'SETOP_EXCEPT',
		],
	])(
		'AC1c composed-except-intersect: %s keeps its right operand grouped',
		(text, expectedSql, rootOp, rightOp) => {
			const { sql, built } = nqlSetOperation(text);

			expect(sql).toBe(expectedSql);
			const expected = {
				op: rootOp,
				all: false,
				larg: plainOperand,
				rarg: {
					op: rightOp,
					all: false,
					larg: plainOperand,
					rarg: plainOperand,
				},
			};
			expect(parsedShape(sql)).toEqual(expected);
			expect(builtShape(built)).toEqual(expected);
		},
	);

	it('AC9 with-on-setop-root: a binding CTE is emitted as the WITH of the set-operation root', () => {
		const result = boundSetOpBundleToSQL('union', 'tenant_set');

		expect(result.sql).toBe(
			'WITH active_employees AS (SELECT employees.id FROM tenant_set.employees WHERE employees.active = $1) SELECT employees.id FROM tenant_set.employees WHERE employees.id = ANY (SELECT active_employees_subq_0.id FROM active_employees AS active_employees_subq_0) UNION SELECT departments.id FROM tenant_set.departments',
		);
		expect(result.parameters).toEqual([true]);
		const expected = {
			op: 'SETOP_UNION',
			all: false,
			larg: plainOperand,
			rarg: plainOperand,
			with: {
				recursive: false,
				ctes: [{ name: 'active_employees', columns: [] }],
			},
		};
		expect(parsedShape(result.sql)).toEqual(expected);
		expect(builtShape(result as CompiledQuery)).toEqual(expected);
	});
});
