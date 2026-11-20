/**
 * FR-8: orm.recursive() — WITH RECURSIVE CTE via explicit base/step builders.
 *
 * Tests compile to exact SQL using createPgCompileOnlyAdapter + createOrm.
 * No DB connection required.
 */

import {
	and,
	createOrm,
	createRawCteBuilder,
	eq,
	exprRef,
	fn,
	literal,
	ref,
	schema,
} from '@dbsp/core';
import type { Dump } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { builtShape, parsedShape } from './statement-shape.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const testSchema = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		file_id: { type: 'integer' },
	},
	symbol_parents: {
		id: { type: 'integer', primaryKey: true },
		parent_symbol_id: { type: 'integer' },
		child_symbol_id: { type: 'integer' },
	},
	categories: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		parent_id: { type: 'integer' },
	},
	chain: {
		id: { type: 'integer', primaryKey: true },
	},
	departments: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	employees: {
		id: { type: 'integer', primaryKey: true },
		departmentId: ref('departments', { inverse: 'employees' }),
	},
} as const);

function buildOrm() {
	const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

/** Normalize whitespace for SQL comparison */
function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

function relationQuery(from = 'employees', column = 'name') {
	return {
		type: 'select' as const,
		from,
		select: {
			type: 'expressions' as const,
			columns: [
				{ kind: 'column' as const, column: 'id' },
				{
					kind: 'relationColumn' as const,
					relation: 'department',
					column,
					as: `department.${column}`,
				},
			],
		},
		include: [{ relation: 'department', strategy: 'flat' as const }],
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FR-8: orm.recursive() — WITH RECURSIVE CTE', () => {
	it('resolves a declared recursive CTE root from the physical inventory', () => {
		const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
		const result = adapter.compileCteQuery({
			kind: 'cteQuery',
			ctes: [
				{
					kind: 'rawCte',
					name: 'employee_rows',
					base: {
						type: 'select',
						from: 'employees',
						select: { type: 'all' },
					},
					step: {
						type: 'select',
						from: 'employee_rows',
						select: { type: 'all' },
					},
					unionAll: true,
				},
			],
			query: { type: 'select', from: 'employee_rows', select: { type: 'all' } },
		});

		expect(ws(result.sql)).toBe(
			'WITH RECURSIVE employee_rows AS (SELECT employees.* FROM employees UNION ALL SELECT employee_rows.* FROM employee_rows) SELECT employee_rows.* FROM employee_rows',
		);
	});

	it('plans relation paths in a recursive CTE anchor over a model table', () => {
		const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
		const result = adapter.compileCteQuery({
			kind: 'cteQuery',
			ctes: [
				{
					kind: 'rawCte',
					name: 'employee_rows',
					base: relationQuery(),
					step: {
						type: 'select',
						from: 'employee_rows',
						select: { type: 'all' },
					},
					unionAll: true,
				},
			],
			query: { type: 'select', from: 'employee_rows', select: { type: 'all' } },
		});

		expect(ws(result.sql)).toBe(
			'WITH RECURSIVE employee_rows AS (SELECT employees.id, department.name AS "department.name" FROM employees JOIN departments AS department ON employees."departmentId" = department.id UNION ALL SELECT employee_rows.* FROM employee_rows) SELECT employee_rows.* FROM employee_rows',
		);
	});

	it('plans relation paths in a recursive CTE step over a model table', () => {
		const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
		const result = adapter.compileCteQuery({
			kind: 'cteQuery',
			ctes: [
				{
					kind: 'rawCte',
					name: 'employee_rows',
					base: {
						type: 'select',
						from: 'employees',
						select: { type: 'fields', fields: ['id', 'departmentId'] },
					},
					step: relationQuery('employees', 'id'),
					unionAll: true,
				},
			],
			query: { type: 'select', from: 'employee_rows', select: { type: 'all' } },
		});

		expect(ws(result.sql)).toBe(
			'WITH RECURSIVE employee_rows AS (SELECT employees.id, employees."departmentId" FROM employees UNION ALL SELECT employees.id, department.id AS "department.id" FROM employees JOIN departments AS department ON employees."departmentId" = department.id) SELECT employee_rows.* FROM employee_rows',
		);
	});

	it('T1: basic — base + step, no maxDepth, UNION ALL (default)', () => {
		const orm = buildOrm() as any;

		const chain = orm.recursive('parent_chain', {
			base: orm.select('symbols').where(eq('id', 1)),
			step: orm.select('parent_chain'),
		});

		const dump = chain.dump();

		expect(ws(dump.sql)).toEqual(
			'WITH RECURSIVE parent_chain AS (' +
				'SELECT symbols.* FROM symbols WHERE symbols.id = $1' +
				' UNION ALL ' +
				'SELECT parent_chain.* FROM parent_chain' +
				') SELECT parent_chain.* FROM parent_chain',
		);
		expect(dump.params).toEqual([1]);
	});

	it('keeps its recursive source unqualified under a schema scope', () => {
		const orm = buildOrm() as any;

		const dump = orm
			.withSchema('tenant_x')
			.recursive('chain', {
				base: orm.select('categories').where(eq('id', 1)),
				step: orm.select('chain'),
			})
			.dump();

		expect(ws(dump.sql)).toEqual(
			'WITH RECURSIVE chain AS (' +
				'SELECT categories.* FROM tenant_x.categories WHERE categories.id = $1' +
				' UNION ALL ' +
				'SELECT chain.* FROM chain' +
				') SELECT chain.* FROM chain',
		);
		expect(dump.params).toEqual([1]);
	});

	it('keeps a physical table in the anchor and its own name in the step', () => {
		const orm = buildOrm() as any;

		const dump = orm
			.withSchema('tenant_x')
			.recursive('chain', {
				base: orm.select('chain'),
				step: orm.select('chain'),
			})
			.dump();

		expect(ws(dump.sql)).toEqual(
			'WITH RECURSIVE chain AS (' +
				'SELECT chain.* FROM tenant_x.chain' +
				' UNION ALL ' +
				'SELECT chain.* FROM chain' +
				') SELECT chain.* FROM chain',
		);
	});

	it('T2: UNION (dedup) instead of UNION ALL', () => {
		const orm = buildOrm() as any;

		const chain = orm.recursive('cats', {
			base: orm.select('categories').where(eq('id', 5)),
			step: orm.select('cats'),
			unionAll: false,
		});

		const dump = chain.dump();

		expect(ws(dump.sql)).toContain('UNION SELECT');
		expect(ws(dump.sql)).not.toContain('UNION ALL');
		expect(dump.params).toEqual([5]);
	});

	it('T3: outer .columns() projection', () => {
		const orm = buildOrm() as any;

		const chain = orm.recursive('parent_chain', {
			base: orm.select('symbols').where(eq('id', 42)),
			step: orm.select('parent_chain'),
		});

		const dump = chain.columns(['id', 'name']).dump();

		// Outer query should SELECT only id, name
		const outerSelect = dump.sql.split(') SELECT ')[1];
		expect(outerSelect).toContain('parent_chain.id');
		expect(outerSelect).toContain('parent_chain.name');
		expect(outerSelect).not.toContain('file_id');
		expect(dump.params).toEqual([42]);
	});

	it('T4: outer .orderBy() appended to outer query', () => {
		const orm = buildOrm() as any;

		const dump = orm
			.recursive('parent_chain', {
				base: orm.select('symbols').where(eq('id', 1)),
				step: orm.select('parent_chain'),
			})
			.columns(['id', 'name'])
			.orderBy('id')
			.dump();

		expect(ws(dump.sql)).toContain('ORDER BY parent_chain.id ASC');
	});

	it('T5: outer .orderBy() DESC', () => {
		const orm = buildOrm() as any;

		const dump = orm
			.recursive('parent_chain', {
				base: orm.select('symbols').where(eq('id', 1)),
				step: orm.select('parent_chain'),
			})
			.orderBy('name', 'desc')
			.dump();

		expect(ws(dump.sql)).toContain('ORDER BY parent_chain.name DESC');
	});

	it('T6: outer .limit() and .offset()', () => {
		const orm = buildOrm() as any;

		const dump = orm
			.recursive('parent_chain', {
				base: orm.select('symbols').where(eq('id', 7)),
				step: orm.select('parent_chain'),
			})
			.limit(10)
			.offset(5)
			.dump();

		expect(ws(dump.sql)).toContain('LIMIT 10');
		expect(ws(dump.sql)).toContain('OFFSET 5');
	});

	it('T7: base params are correctly offset in final output', () => {
		const orm = buildOrm() as any;

		// Base has $1 (id = rootId), outer query has no extra params
		const dump = orm
			.recursive('parent_chain', {
				base: orm.select('symbols').where(eq('id', 99)),
				step: orm.select('parent_chain'),
			})
			.dump();

		// Base param → $1; outer SELECT has no params
		expect(dump.params).toEqual([99]);
		expect(dump.sql).toContain('$1');
	});

	it('T8: WITH RECURSIVE keyword is present', () => {
		const orm = buildOrm() as any;

		const dump = orm
			.recursive('cats', {
				base: orm.select('categories').where(eq('parent_id', 1)),
				step: orm.select('cats'),
			})
			.dump();

		expect(ws(dump.sql)).toMatch(/^WITH RECURSIVE/);
	});

	it('T9: buildIntent() produces correct CteQueryIntent structure', () => {
		const orm = buildOrm() as any;

		const builder = orm.recursive('parent_chain', {
			base: orm.select('symbols').where(eq('id', 1)),
			step: orm.select('parent_chain'),
			maxDepth: 10,
			unionAll: true,
		});

		const intent = builder.buildIntent();

		expect(intent.kind).toBe('cteQuery');
		expect(intent.ctes).toHaveLength(1);
		const cte = intent.ctes[0];
		expect(cte.kind).toBe('rawCte');
		expect(cte.name).toBe('parent_chain');
		expect(cte.unionAll).toBe(true);
		expect(cte.maxDepth).toBe(10);
		expect(cte.base.from).toBe('symbols');
		expect(cte.step.from).toBe('parent_chain');
		expect(intent.query.from).toBe('parent_chain');
	});

	it('T10: step query with WHERE compiles correctly and renumbers params', () => {
		const orm = buildOrm() as any;

		// Base: WHERE id = $1 (param: rootId)
		// Step: WHERE name IS NOT NULL (no extra params)
		// Outer: no params
		const dump = orm
			.recursive('parent_chain', {
				base: orm.select('symbols').where(eq('id', 42)),
				step: orm.select('parent_chain').where(eq('name', 'foo')),
			})
			.dump();

		// Base param → $1 (42), step param → $2 ('foo')
		expect(dump.params).toEqual([42, 'foo']);
		expect(dump.sql).toContain('$1');
		expect(dump.sql).toContain('$2');
	});

	it('T11: error thrown when no adapter provided', () => {
		const orm = buildOrm() as any;

		// createRawCteBuilder is imported at top level — build without adapter
		const builder = createRawCteBuilder(
			'test',
			{
				base: orm.select('symbols'),
				step: orm.select('test'),
			},
			undefined, // no adapter
		);

		expect(() => builder.dump()).toThrow(/requires an adapter/);
	});

	it('T12: maxDepth injects WHERE "depth" < $N in step query (no prior step WHERE)', () => {
		const orm = buildOrm() as any;

		const dump = orm
			.recursive('chain', {
				base: orm.select('categories').where(eq('parent_id', 1)),
				step: orm.select('chain'),
				maxDepth: 10,
				depthColumn: 'depth',
			})
			.dump();

		// base: $1=1 (parent_id), maxDepth: $2=10
		// step has no WHERE → depth guard becomes: WHERE depth < $2
		expect(dump.params).toEqual([1, 10]);
		expect(ws(dump.sql)).toEqual(
			'WITH RECURSIVE chain AS (' +
				'SELECT categories.* FROM categories WHERE categories.parent_id = $1' +
				' UNION ALL ' +
				'SELECT chain.* FROM chain WHERE depth < $2' +
				') SELECT chain.* FROM chain',
		);
	});

	it('quotes a depth column named binary, a keyword PostgreSQL refuses bare', () => {
		const orm = buildOrm() as any;

		const dump = orm
			.recursive('chain', {
				base: orm.select('categories').where(eq('parent_id', 1)),
				step: orm.select('chain'),
				maxDepth: 3,
				depthColumn: 'binary',
			})
			.dump();

		expect(dump.params).toEqual([1, 3]);
		expect(ws(dump.sql)).toEqual(
			'WITH RECURSIVE chain AS (' +
				'SELECT categories.* FROM categories WHERE categories.parent_id = $1' +
				' UNION ALL ' +
				'SELECT chain.* FROM chain WHERE "binary" < $2' +
				') SELECT chain.* FROM chain',
		);
	});

	it('T13: maxDepth AND-ed with existing step WHERE clause', () => {
		const orm = buildOrm() as any;

		const dump = orm
			.recursive('chain', {
				base: orm.select('categories').where(eq('parent_id', 1)),
				step: orm.select('chain').where(eq('name', 'active')),
				maxDepth: 5,
				depthColumn: 'depth',
			})
			.dump();

		// base: $1=1, step: $2='active', maxDepth: $3=5
		// step already has WHERE → depth guard becomes: AND depth < $3
		expect(dump.params).toEqual([1, 'active', 5]);
		expect(ws(dump.sql)).toContain('WHERE chain.name = $2 AND depth < $3');
	});

	it('T14: maxDepth without depthColumn defaults to "depth"', () => {
		const orm = buildOrm() as any;

		const dump = orm
			.recursive('chain', {
				base: orm.select('categories').where(eq('parent_id', 2)),
				step: orm.select('chain'),
				maxDepth: 7,
				// depthColumn not specified — should default to 'depth'
			})
			.dump();

		expect(dump.params).toEqual([2, 7]);
		expect(ws(dump.sql)).toContain('WHERE depth < $2');
	});
});

// ---------------------------------------------------------------------------
// One tree per CTE statement (ADR 0012): no `$N` text is renumbered
// ---------------------------------------------------------------------------

const dollarSchema = schema({
	items: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		cost$1: { type: 'string', nullable: true },
	},
});

function dollarOrm() {
	const adapter = createPgCompileOnlyAdapter({ model: dollarSchema.model });
	// Untyped like buildOrm(): a recursive step reads the CTE name, not a model table.
	const orm = createOrm({ model: dollarSchema.model, adapter }) as any;
	return { adapter, orm };
}

/** `concat('Price: $1', <column>) = $N`: a constant holding `$1` in a WHERE. */
function priceEq(column: string) {
	return fn('concat', literal('Price: $1'), exprRef(column)).eq('Price: $1x');
}

describe('CTE composition keeps $-constants and $-identifiers (ADR 0012)', () => {
	it('AC2 simple-cte: a simple CTE after a parameterised CTE keeps its constant and column', () => {
		const { orm } = dollarOrm();

		const dump =
			orm.nql`with a as (items | where name = ${'x'} | select id), b as (items | where "cost$1" = ${'y'} | select id, "cost$1", 'Price: $1' as label) b | select id, label`.dump() as Dump;

		expect(dump.sql).toBe(
			'WITH a AS (SELECT items.id FROM items WHERE items.name = $1), b AS (SELECT items.id, items."cost$1", \'Price: $1\' AS label FROM items WHERE items."cost$1" = $2) SELECT b.id, b.label FROM b',
		);
		expect(dump.params).toEqual(['x', 'y']);
	});

	it('AC2b recursive-outer: the outer query of orm.recursive keeps its constant and column', () => {
		const { orm } = dollarOrm();

		const dump = orm
			.recursive('chain', {
				base: orm.select('items').where(eq('name', 'root')),
				step: orm.select('chain').where(eq('name', 'k')),
			})
			.where(and(eq('cost$1', 'c'), priceEq('name')))
			.dump();

		expect(dump.sql).toBe(
			'WITH RECURSIVE chain AS (SELECT items.* FROM items WHERE items.name = $1 UNION ALL SELECT chain.* FROM chain WHERE chain.name = $2) SELECT chain.* FROM chain WHERE chain."cost$1" = $3 AND concat(\'Price: $1\', chain.name) = $4',
		);
		expect(dump.params).toEqual(['root', 'k', 'c', 'Price: $1x']);
	});

	it('AC2c recursive-step: the step keeps its constant and column beside the depth guard', () => {
		const { orm } = dollarOrm();

		const filtered = orm
			.recursive('chain', {
				base: orm.select('items').where(eq('name', 'root')),
				step: orm
					.select('chain')
					.where(and(eq('cost$1', 'k'), priceEq('name'))),
				maxDepth: 3,
			})
			.dump();

		expect(filtered.sql).toBe(
			'WITH RECURSIVE chain AS (SELECT items.* FROM items WHERE items.name = $1 UNION ALL SELECT chain.* FROM chain WHERE chain."cost$1" = $2 AND concat(\'Price: $1\', chain.name) = $3 AND depth < $4) SELECT chain.* FROM chain',
		);
		expect(filtered.params).toEqual(['root', 'k', 'Price: $1x', 3]);
	});

	it("AC2c recursive-step: a step with no WHERE and a 'WHERE' constant gets a valid depth guard", () => {
		const { orm } = dollarOrm();

		const unfiltered = orm
			.recursive('chain', {
				base: orm
					.select('items')
					.columns(['id', 'name'])
					.where(eq('name', 'root')),
				step: orm
					.select('chain')
					.columns([
						'id',
						fn('concat', literal('a WHERE b $1'), exprRef('name')).as('name'),
					]),
				maxDepth: 3,
			})
			.dump();

		expect(unfiltered.sql).toBe(
			"WITH RECURSIVE chain AS (SELECT items.id, items.name FROM items WHERE items.name = $1 UNION ALL SELECT chain.id, concat('a WHERE b $1', name) AS name FROM chain WHERE depth < $2) SELECT chain.* FROM chain",
		);
		expect(unfiltered.params).toEqual(['root', 3]);
		expect(parsedShape(unfiltered.sql)).toEqual({
			sort: false,
			limit: false,
			offset: false,
			lock: false,
			with: { recursive: true, ctes: [{ name: 'chain', columns: [] }] },
		});
	});

	it('AC2d raw-cte-after-cte: a raw CTE after a parameterised CTE keeps its constant and column', () => {
		const { adapter, orm } = dollarOrm();

		const compiled = adapter.compileCteQuery(
			{
				kind: 'cteQuery',
				ctes: [
					{
						kind: 'simpleCte',
						name: 'a',
						query: orm.select('items').where(eq('name', 'x')).buildIntent(),
					},
					{
						kind: 'rawCte',
						name: 'chain',
						base: orm.select('items').where(eq('name', 'root')).buildIntent(),
						step: orm
							.select('chain')
							.where(and(eq('cost$1', 'k'), priceEq('name')))
							.buildIntent(),
						unionAll: true,
					},
				],
				query: orm.select('chain').buildIntent(),
			},
			{ model: dollarSchema.model },
		);

		expect(compiled.sql).toBe(
			'WITH RECURSIVE a AS (SELECT items.* FROM items WHERE items.name = $1), chain AS (SELECT items.* FROM items WHERE items.name = $2 UNION ALL SELECT chain.* FROM chain WHERE chain."cost$1" = $3 AND concat(\'Price: $1\', chain.name) = $4) SELECT chain.* FROM chain',
		);
		expect(compiled.parameters).toEqual(['x', 'root', 'k', 'Price: $1x']);
		const expected = {
			sort: false,
			limit: false,
			offset: false,
			lock: false,
			with: {
				recursive: true,
				ctes: [
					{ name: 'a', columns: [] },
					{ name: 'chain', columns: [] },
				],
			},
		};
		expect(parsedShape(compiled.sql)).toEqual(expected);
		expect(builtShape(compiled)).toEqual(expected);
	});
});
