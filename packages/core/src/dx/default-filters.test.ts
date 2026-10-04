/**
 * E17: Default Filters (Soft Delete Convention) Tests
 *
 * Tests for table-level default filters applied automatically to queries.
 */

import type { WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	and,
	createOrm,
	type DefaultFilters,
	eq,
	isNull,
	ref,
	schema,
} from './index.js';
import { createMockAdapter } from './test-utils.js';

// Schema with soft delete columns
const tables = {
	products: {
		id: 'uuid' as const,
		name: 'text' as const,
		deletedAt: { type: 'timestamp' as const, nullable: true },
	},
	users: {
		id: 'uuid' as const,
		email: 'text' as const,
		active: { type: 'boolean' as const, default: true },
	},
	orders: {
		id: 'uuid' as const,
		userId: ref('users'),
		deletedAt: { type: 'timestamp' as const, nullable: true },
	},
};

describe('E17: Default Filters (Soft Delete)', () => {
	describe('schema() with defaultFilters option', () => {
		it('should accept defaultFilters in schema options', () => {
			const defaultFilters: DefaultFilters = {
				products: isNull('deletedAt'),
				orders: isNull('deletedAt'),
			};

			const db = schema(tables, undefined, { defaultFilters });

			expect(db.defaultFilters).toBeDefined();
			expect(db.defaultFilters).toEqual(defaultFilters);
		});

		it('should throw for non-existent table in defaultFilters', () => {
			const defaultFilters: DefaultFilters = {
				nonExistentTable: isNull('deletedAt'),
			};

			expect(() => schema(tables, undefined, { defaultFilters })).toThrow(
				/non-existent table 'nonExistentTable'/,
			);
		});

		it('should work without defaultFilters option', () => {
			const db = schema(tables);
			expect(db.defaultFilters).toBeUndefined();
		});
	});

	describe('QueryBuilder with default filters', () => {
		const defaultFilters: DefaultFilters = {
			products: isNull('deletedAt'),
			orders: isNull('deletedAt'),
		};

		const db = schema(tables, undefined, { defaultFilters });
		const orm = createOrm({
			schema: db,
			adapter: createMockAdapter(),
		});

		it('should include default filter in plan intent', () => {
			const plan = orm.select('products').plan();

			// The intent should have the deletedAt IS NULL filter
			expect(plan.intent.where).toBeDefined();
			expect((plan.intent.where as { kind: string }).kind).toBe('null');
			expect((plan.intent.where as { field: string }).field).toBe('deletedAt');
		});

		it('should combine default filter with user filter using AND', () => {
			const plan = orm.select('products').where(eq('name', 'Widget')).plan();

			// Intent should have AND with both filters
			expect(plan.intent.where).toBeDefined();
			expect((plan.intent.where as { kind: string }).kind).toBe('and');

			const andIntent = plan.intent.where as {
				conditions: readonly WhereIntent[];
			};
			expect(andIntent.conditions).toHaveLength(2);

			// First condition should be the default filter
			const defaultFilter = andIntent.conditions[0] as {
				kind: string;
				field?: string;
			};
			expect(defaultFilter?.kind).toBe('null');
			expect(defaultFilter?.field).toBe('deletedAt');

			// Second condition should be the user filter
			const userFilter = andIntent.conditions[1] as { kind: string };
			expect(userFilter?.kind).toBe('comparison');
		});

		it('should not apply default filter to tables without one', () => {
			// users table has no default filter
			const plan = orm.select('users').plan();

			// No where clause since no default filter and no user filter
			expect(plan.intent.where).toBeUndefined();
		});

		it('should support withoutDefaultFilters() to skip default filter', () => {
			const plan = orm.select('products').withoutDefaultFilters().plan();

			// No where clause since default filters are skipped
			expect(plan.intent.where).toBeUndefined();
		});

		it('should keep user filter when using withoutDefaultFilters()', () => {
			const plan = orm
				.select('products')
				.where(eq('name', 'Widget'))
				.withoutDefaultFilters()
				.plan();

			// Should only have the user filter
			expect(plan.intent.where).toBeDefined();
			expect((plan.intent.where as { kind: string }).kind).toBe('comparison');
		});

		it('should combine multiple user filters with default filter', () => {
			const plan = orm
				.select('orders')
				.where(eq('userId', '123'))
				.where(eq('id', '456'))
				.plan();

			// Should be AND with 3 conditions: default + 2 user filters
			expect(plan.intent.where).toBeDefined();
			expect((plan.intent.where as { kind: string }).kind).toBe('and');

			const andIntent = plan.intent.where as {
				conditions: readonly WhereIntent[];
			};
			expect(andIntent.conditions).toHaveLength(3);
		});
	});

	describe('ORM with no default filters', () => {
		const db = schema(tables);
		const orm = createOrm({
			schema: db,
			adapter: createMockAdapter(),
		});

		it('should work normally without default filters', () => {
			const plan = orm.select('products').plan();
			expect(plan.intent.where).toBeUndefined();
		});

		it('withoutDefaultFilters() should be no-op when no default filters', () => {
			const plan = orm.select('products').withoutDefaultFilters().plan();
			expect(plan.intent.where).toBeUndefined();
		});
	});

	describe('Complex default filter scenarios', () => {
		it('should support multiple conditions in a default filter', () => {
			const complexDefaultFilters: DefaultFilters = {
				users: and(eq('active', true), isNull('deletedAt')),
			};

			// Need a schema with both columns
			const complexTables = {
				users: {
					id: 'uuid' as const,
					active: 'boolean' as const,
					deletedAt: { type: 'timestamp' as const, nullable: true },
				},
			};

			const db = schema(complexTables, undefined, {
				defaultFilters: complexDefaultFilters,
			});
			const orm = createOrm({
				schema: db,
				adapter: createMockAdapter(),
			});

			const plan = orm.select('users').plan();

			expect(plan.intent.where).toBeDefined();
			expect((plan.intent.where as { kind: string }).kind).toBe('and');
		});
	});
});
