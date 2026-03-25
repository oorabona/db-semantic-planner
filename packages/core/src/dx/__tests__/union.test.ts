/**
 * Tests for QueryBuilder set operations: union / unionAll / intersect / except
 *
 * Tests verify:
 * 1. Intent shape produced by each method
 * 2. all: true/false for ALL variants
 * 3. Chaining produces nested SetOperationIntent tree
 * 4. dump() compiles to valid SQL with correct keyword
 * 5. No adapter → ExecutionError on dump() / all()
 */

import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../../../../adapter-pgsql/src/pgsql-adapter.js';
import { ExecutionError } from '../errors.js';
import { createOrm } from '../orm.js';
import { QueryBuilderImpl } from '../query-builder.js';
import { ref, schema, schemaToModelIR } from '../schema.js';
import { createMockAdapter } from '../test-utils.js';

// ---------------------------------------------------------------------------
// Test schema
// ---------------------------------------------------------------------------
const testSchema = schema({
	employees: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		active: 'boolean',
		departmentId: ref('departments'),
	},
	departments: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	contractors: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		active: 'boolean',
	},
});

// ---------------------------------------------------------------------------
// ORM instances
// ---------------------------------------------------------------------------

/** ORM with mock adapter (plan-only, no SQL compilation) */
const orm = createOrm({ schema: testSchema, adapter: createMockAdapter() });

/** ORM with compile-only adapter (SQL compilation without DB) */
const compilableOrm = createOrm({
	schema: testSchema,
	adapter: createPgsqlCompileOnlyAdapter(),
});

// ---------------------------------------------------------------------------
// Intent shape tests
// ---------------------------------------------------------------------------

describe('QueryBuilder set operations — intent shape', () => {
	it('union() produces setOperation intent with op=union, all=false', () => {
		const q1 = orm.select('employees');
		const q2 = orm.select('contractors');
		const builder = q1.union(q2);

		const intent = builder.intent;
		expect(intent.kind).toBe('setOperation');
		expect(intent.op).toBe('union');
		expect(intent.all).toBe(false);
		expect(intent.left).toMatchObject({ type: 'select', from: 'employees' });
		expect(intent.right).toMatchObject({ type: 'select', from: 'contractors' });
	});

	it('unionAll() produces setOperation intent with all=true', () => {
		const builder = orm.select('employees').unionAll(orm.select('contractors'));
		expect(builder.intent.op).toBe('union');
		expect(builder.intent.all).toBe(true);
	});

	it('intersect() produces setOperation intent with op=intersect, all=false', () => {
		const builder = orm
			.select('employees')
			.intersect(orm.select('contractors'));
		expect(builder.intent.op).toBe('intersect');
		expect(builder.intent.all).toBe(false);
	});

	it('intersectAll() produces setOperation intent with op=intersect, all=true', () => {
		const builder = orm
			.select('employees')
			.intersectAll(orm.select('contractors'));
		expect(builder.intent.op).toBe('intersect');
		expect(builder.intent.all).toBe(true);
	});

	it('except() produces setOperation intent with op=except, all=false', () => {
		const builder = orm.select('employees').except(orm.select('contractors'));
		expect(builder.intent.op).toBe('except');
		expect(builder.intent.all).toBe(false);
	});

	it('exceptAll() produces setOperation intent with op=except, all=true', () => {
		const builder = orm
			.select('employees')
			.exceptAll(orm.select('contractors'));
		expect(builder.intent.op).toBe('except');
		expect(builder.intent.all).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Chaining tests
// ---------------------------------------------------------------------------

describe('QueryBuilder set operations — chaining', () => {
	it('chain union().intersect() nests correctly: (left UNION right) INTERSECT other', () => {
		const q1 = orm.select('employees');
		const q2 = orm.select('contractors');
		const q3 = orm.select('departments');

		const chained = q1.union(q2).intersect(q3);
		const intent = chained.intent;

		expect(intent.op).toBe('intersect');
		expect(intent.all).toBe(false);

		// Left side is the union result
		expect(intent.left).toMatchObject({
			kind: 'setOperation',
			op: 'union',
			all: false,
		});
		// Right side is q3
		expect(intent.right).toMatchObject({ type: 'select', from: 'departments' });
	});

	it('chain union().except() nests correctly', () => {
		const chained = orm
			.select('employees')
			.union(orm.select('contractors'))
			.except(orm.select('departments'));

		expect(chained.intent.op).toBe('except');
		expect(chained.intent.left).toMatchObject({
			kind: 'setOperation',
			op: 'union',
		});
	});

	it('SetOperationBuilder.union() further combines correctly', () => {
		const q1 = orm.select('employees');
		const q2 = orm.select('contractors');
		const q3 = orm.select('departments');

		const step1 = q1.union(q2);
		const step2 = step1.union(q3);

		expect(step2.intent.op).toBe('union');
		expect(step2.intent.left).toMatchObject({
			kind: 'setOperation',
			op: 'union',
		});
		expect(step2.intent.right).toMatchObject({
			type: 'select',
			from: 'departments',
		});
	});
});

// ---------------------------------------------------------------------------
// SQL compilation tests (compile-only adapter)
// ---------------------------------------------------------------------------

describe('QueryBuilder set operations — SQL compilation', () => {
	it('union() dump() compiles to SQL with UNION keyword', () => {
		const dump = compilableOrm
			.select('employees')
			.union(compilableOrm.select('contractors'))
			.dump();

		expect(dump.sql.toUpperCase()).toContain('UNION');
		expect(dump.sql.toUpperCase()).not.toContain('UNION ALL');
		expect(dump.sql).toContain('employees');
		expect(dump.sql).toContain('contractors');
	});

	it('unionAll() dump() compiles to SQL with UNION ALL keyword', () => {
		const dump = compilableOrm
			.select('employees')
			.unionAll(compilableOrm.select('contractors'))
			.dump();

		expect(dump.sql.toUpperCase()).toContain('UNION ALL');
	});

	it('intersect() dump() compiles to SQL with INTERSECT keyword', () => {
		const dump = compilableOrm
			.select('employees')
			.intersect(compilableOrm.select('contractors'))
			.dump();

		expect(dump.sql.toUpperCase()).toContain('INTERSECT');
		expect(dump.sql.toUpperCase()).not.toContain('INTERSECT ALL');
	});

	it('intersectAll() dump() compiles to SQL with INTERSECT ALL keyword', () => {
		const dump = compilableOrm
			.select('employees')
			.intersectAll(compilableOrm.select('contractors'))
			.dump();

		expect(dump.sql.toUpperCase()).toContain('INTERSECT ALL');
	});

	it('except() dump() compiles to SQL with EXCEPT keyword', () => {
		const dump = compilableOrm
			.select('employees')
			.except(compilableOrm.select('contractors'))
			.dump();

		expect(dump.sql.toUpperCase()).toContain('EXCEPT');
		expect(dump.sql.toUpperCase()).not.toContain('EXCEPT ALL');
	});

	it('exceptAll() dump() compiles to SQL with EXCEPT ALL keyword', () => {
		const dump = compilableOrm
			.select('employees')
			.exceptAll(compilableOrm.select('contractors'))
			.dump();

		expect(dump.sql.toUpperCase()).toContain('EXCEPT ALL');
	});

	it('dump() returns sql and params fields', () => {
		const dump = compilableOrm
			.select('employees')
			.union(compilableOrm.select('contractors'))
			.dump();

		expect(dump).toHaveProperty('sql');
		expect(dump).toHaveProperty('params');
		expect(typeof dump.sql).toBe('string');
		expect(Array.isArray(dump.params)).toBe(true);
	});

	it('chained union().intersect() produces correct SQL structure', () => {
		const dump = compilableOrm
			.select('employees')
			.union(compilableOrm.select('contractors'))
			.intersect(compilableOrm.select('departments'))
			.dump();

		const sql = dump.sql.toUpperCase();
		expect(sql).toContain('UNION');
		expect(sql).toContain('INTERSECT');
	});
});

// ---------------------------------------------------------------------------
// Error tests — no adapter configured
// ---------------------------------------------------------------------------

describe('QueryBuilder set operations — no adapter errors', () => {
	it('dump() throws ExecutionError when no adapter configured', () => {
		const model = schemaToModelIR(testSchema.definition);
		const builder = new QueryBuilderImpl(model, false, 'employees');
		const otherBuilder = new QueryBuilderImpl(model, false, 'contractors');
		const setOpBuilder = builder.union(otherBuilder);

		expect(() => setOpBuilder.dump()).toThrow(ExecutionError);
	});

	it('all() throws ExecutionError when no adapter configured', async () => {
		const model = schemaToModelIR(testSchema.definition);
		const builder = new QueryBuilderImpl(model, false, 'employees');
		const otherBuilder = new QueryBuilderImpl(model, false, 'contractors');
		const setOpBuilder = builder.union(otherBuilder);

		await expect(setOpBuilder.all()).rejects.toThrow(ExecutionError);
	});
});
