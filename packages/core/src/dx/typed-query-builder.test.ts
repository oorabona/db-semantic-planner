/**
 * @fileoverview Tests for typed-query-builder (DX-040 Block 4).
 */

import { describe, expect, it } from 'vitest';
import { eq, gt } from './filters.js';
import { ref, schema, schemaToModelIR } from './schema.js';
import { createTypedOrm } from './typed-query-builder.js';

// ============================================================================
// Test Setup
// ============================================================================

/**
 * Create a test schema with users and posts tables.
 */
function createTestSchema() {
	return schema({
		users: {
			id: 'uuid',
			name: 'string',
			email: 'string',
			age: { type: 'integer', nullable: true },
			active: 'boolean',
			createdAt: 'timestamp',
		},
		posts: {
			id: 'uuid',
			title: 'string',
			content: { type: 'string', nullable: true },
			author: ref('users'),
			publishedAt: { type: 'timestamp', nullable: true },
		},
	});
}

// ============================================================================
// Tests
// ============================================================================

describe('DX-040 Block 4: Typed Query Builder', () => {
	describe('createTypedOrm', () => {
		it('creates a TypedOrm instance with from() method', () => {
			const s = createTestSchema();
			const model = schemaToModelIR(s.definition);
			const orm = createTypedOrm(model);

			expect(orm).toBeDefined();
			expect(typeof orm.from).toBe('function');
		});

		it('from() returns a FromBuilder', () => {
			const s = createTestSchema();
			const model = schemaToModelIR(s.definition);
			const orm = createTypedOrm(model);
			const { users } = s.tables;

			const builder = orm.from(users);

			expect(builder).toBeDefined();
			expect(typeof builder.all).toBe('function');
			expect(typeof builder.first).toBe('function');
			expect(typeof builder.pick).toBe('function');
			expect(typeof builder.where).toBe('function');
			expect(typeof builder.orderBy).toBe('function');
			expect(typeof builder.limit).toBe('function');
			expect(typeof builder.offset).toBe('function');
			expect(typeof builder.plan).toBe('function');
		});
	});

	describe('FromBuilder.plan()', () => {
		it('generates a valid plan for simple select', () => {
			const s = createTestSchema();
			const model = schemaToModelIR(s.definition);
			const orm = createTypedOrm(model);
			const { users } = s.tables;

			const plan = orm.from(users).plan();

			expect(plan.rootTable).toBe('users');
			expect(plan.intent.type).toBe('select');
			expect(plan.intent.from).toBe('users');
			expect(plan.intent.select).toBeUndefined(); // SELECT * (all columns)
		});

		it('generates plan with picked columns', () => {
			const s = createTestSchema();
			const model = schemaToModelIR(s.definition);
			const orm = createTypedOrm(model);
			const { users } = s.tables;

			const plan = orm.from(users).pick(users.id, users.name).plan();

			expect(plan.intent.select).toEqual({
				type: 'fields',
				fields: ['id', 'name'],
			});
		});

		it('generates plan with where condition', () => {
			const s = createTestSchema();
			const model = schemaToModelIR(s.definition);
			const orm = createTypedOrm(model);
			const { users } = s.tables;

			const plan = orm.from(users).where(eq(users.active, true)).plan();

			expect(plan.intent.where).toEqual({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			});
		});

		it('generates plan with multiple where conditions (AND)', () => {
			const s = createTestSchema();
			const model = schemaToModelIR(s.definition);
			const orm = createTypedOrm(model);
			const { users } = s.tables;

			const plan = orm
				.from(users)
				.where(eq(users.active, true))
				.where(gt(users.age, 18))
				.plan();

			expect(plan.intent.where).toEqual({
				kind: 'and',
				conditions: [
					{ kind: 'comparison', field: 'active', operator: 'eq', value: true },
					{ kind: 'comparison', field: 'age', operator: 'gt', value: 18 },
				],
			});
		});

		it('generates plan with orderBy', () => {
			const s = createTestSchema();
			const model = schemaToModelIR(s.definition);
			const orm = createTypedOrm(model);
			const { users } = s.tables;

			const plan = orm.from(users).orderBy(users.createdAt, 'desc').plan();

			expect(plan.intent.orderBy).toEqual([
				{ kind: 'field', field: 'createdAt', direction: 'desc' },
			]);
		});

		it('generates plan with limit', () => {
			const s = createTestSchema();
			const model = schemaToModelIR(s.definition);
			const orm = createTypedOrm(model);
			const { users } = s.tables;

			const plan = orm.from(users).limit(10).plan();

			expect(plan.intent.limit).toBe(10);
		});

		it('generates plan with offset', () => {
			const s = createTestSchema();
			const model = schemaToModelIR(s.definition);
			const orm = createTypedOrm(model);
			const { users } = s.tables;

			const plan = orm.from(users).offset(20).plan();

			expect(plan.intent.offset).toBe(20);
		});

		it('generates plan with combined clauses', () => {
			const s = createTestSchema();
			const model = schemaToModelIR(s.definition);
			const orm = createTypedOrm(model);
			const { users } = s.tables;

			const plan = orm
				.from(users)
				.pick(users.id, users.name)
				.where(eq(users.active, true))
				.where(gt(users.age, 21))
				.orderBy(users.createdAt, 'desc')
				.limit(10)
				.offset(0)
				.plan();

			expect(plan.intent.from).toBe('users');
			expect(plan.intent.select).toEqual({
				type: 'fields',
				fields: ['id', 'name'],
			});
			expect(plan.intent.where).toEqual({
				kind: 'and',
				conditions: [
					{ kind: 'comparison', field: 'active', operator: 'eq', value: true },
					{ kind: 'comparison', field: 'age', operator: 'gt', value: 21 },
				],
			});
			expect(plan.intent.orderBy).toEqual([
				{ kind: 'field', field: 'createdAt', direction: 'desc' },
			]);
			expect(plan.intent.limit).toBe(10);
			expect(plan.intent.offset).toBe(0);
		});
	});

	describe('FromBuilder immutability', () => {
		it('chained methods return new builder instances', () => {
			const s = createTestSchema();
			const model = schemaToModelIR(s.definition);
			const orm = createTypedOrm(model);
			const { users } = s.tables;

			const builder1 = orm.from(users);
			const builder2 = builder1.where(eq(users.active, true));
			const builder3 = builder2.limit(10);

			// Each builder should be independent
			const plan1 = builder1.plan();
			const plan2 = builder2.plan();
			const plan3 = builder3.plan();

			expect(plan1.intent.where).toBeUndefined();
			expect(plan1.intent.limit).toBeUndefined();

			expect(plan2.intent.where).toBeDefined();
			expect(plan2.intent.limit).toBeUndefined();

			expect(plan3.intent.where).toBeDefined();
			expect(plan3.intent.limit).toBe(10);
		});
	});

	describe('Error handling', () => {
		it('throws when dump() called without adapter', () => {
			const s = createTestSchema();
			const model = schemaToModelIR(s.definition);
			const orm = createTypedOrm(model);
			const { users } = s.tables;

			expect(() => orm.from(users).dump()).toThrow(
				'Cannot dump query without adapter',
			);
		});

		it('throws when all() called without adapter', async () => {
			const s = createTestSchema();
			const model = schemaToModelIR(s.definition);
			const orm = createTypedOrm(model);
			const { users } = s.tables;

			await expect(orm.from(users).all()).rejects.toThrow(
				'Cannot execute query without adapter',
			);
		});

		it('throws when first() called without adapter', async () => {
			const s = createTestSchema();
			const model = schemaToModelIR(s.definition);
			const orm = createTypedOrm(model);
			const { users } = s.tables;

			await expect(orm.from(users).first()).rejects.toThrow(
				'Cannot execute query without adapter',
			);
		});
	});

	describe('Type inference', () => {
		it('from() returns builder for table', () => {
			const s = createTestSchema();
			const model = schemaToModelIR(s.definition);
			const orm = createTypedOrm(model);
			const { users } = s.tables;

			const builder = orm.from(users);

			// Type test: builder should be a FromBuilder
			expect(builder).toBeDefined();
			expect(typeof builder.all).toBe('function');
		});

		it('pick() changes the result fields', () => {
			const s = createTestSchema();
			const model = schemaToModelIR(s.definition);
			const orm = createTypedOrm(model);
			const { users } = s.tables;

			const builder = orm.from(users).pick(users.id, users.name);

			// Verify the select is narrowed
			const plan = builder.plan();
			expect(plan.intent.select).toEqual({
				type: 'fields',
				fields: ['id', 'name'],
			});
		});
	});

	describe('Integration with schema.tables', () => {
		it('works with schema().tables for table access', () => {
			const s = createTestSchema();
			const model = schemaToModelIR(s.definition);
			const orm = createTypedOrm(model);

			// Access users table via schema.tables
			const { users } = s.tables;
			expect(users).toBeDefined();

			// Use in query builder
			const plan = orm.from(users).plan();
			expect(plan.rootTable).toBe('users');
		});

		it('works with column access via schema.tables', () => {
			const s = createTestSchema();
			const model = schemaToModelIR(s.definition);
			const orm = createTypedOrm(model);
			const { users } = s.tables;

			// Use columns in pick and where
			const plan = orm
				.from(users)
				.pick(users.id, users.name)
				.where(eq(users.active, true))
				.plan();

			expect(plan.intent.select).toEqual({
				type: 'fields',
				fields: ['id', 'name'],
			});
			expect(plan.intent.where).toEqual({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			});
		});
	});
});
