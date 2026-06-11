import { describe, expect, it } from 'vitest';
import { type ColumnValidatorSchema, compile } from '../src/index.js';

/**
 * Mock schema implementing ColumnValidatorSchema for testing.
 * Models a simple e-commerce domain: users, orders, products, categories.
 */
function createMockSchema(): ColumnValidatorSchema {
	const tables: Record<
		string,
		{
			columns: { name: string }[];
			pseudoColumns?: { parentRole: string; childRole: string }[];
		}
	> = {
		users: {
			columns: [
				{ name: 'id' },
				{ name: 'name' },
				{ name: 'email' },
				{ name: 'active' },
				{ name: 'createdAt' },
			],
		},
		orders: {
			columns: [
				{ name: 'id' },
				{ name: 'userId' },
				{ name: 'total' },
				{ name: 'status' },
				{ name: 'createdAt' },
			],
		},
		products: {
			columns: [
				{ name: 'id' },
				{ name: 'name' },
				{ name: 'price' },
				{ name: 'categoryId' },
			],
		},
		categories: {
			columns: [
				{ name: 'id' },
				{ name: 'name' },
				{ name: 'sortOrder' },
				{ name: 'parentId' },
			],
			pseudoColumns: [{ parentRole: 'parent', childRole: 'children' }],
		},
	};

	const relations: Record<string, { name: string; target: string }[]> = {
		users: [{ name: 'orders', target: 'orders' }],
		orders: [
			{ name: 'user', target: 'users' },
			{ name: 'products', target: 'products' },
		],
		categories: [
			{ name: 'parent', target: 'categories' },
			{ name: 'children', target: 'categories' },
		],
	};

	return {
		getTable(name: string) {
			return tables[name];
		},
		getRelationsFrom(sourceTable: string) {
			return relations[sourceTable] ?? [];
		},
	};
}

describe('Column Validation', () => {
	const schema = createMockSchema();

	describe('valid queries — no errors', () => {
		it('should accept valid simple columns', () => {
			const result = compile('users | select id, name, email', schema);
			expect(result.success).toBe(true);
		});

		it('should accept wildcard select', () => {
			const result = compile('users | select *', schema);
			expect(result.success).toBe(true);
		});

		it('should accept valid WHERE column', () => {
			const result = compile('users | where active = true', schema);
			expect(result.success).toBe(true);
		});

		it('should accept valid ORDER BY column', () => {
			const result = compile('users | order by createdAt desc', schema);
			expect(result.success).toBe(true);
		});

		it('should accept valid GROUP BY column', () => {
			const result = compile(
				'orders | select status, count(*) as cnt | group by status',
				schema,
			);
			expect(result.success).toBe(true);
		});

		it('should accept valid aggregate function column', () => {
			const result = compile(
				'orders | select sum(total) as totalRevenue',
				schema,
			);
			expect(result.success).toBe(true);
		});

		it('should accept valid SELECT function argument columns', () => {
			const result = compile('users | select lower(name) as x', schema);
			expect(result.success).toBe(true);
		});

		it('should not validate named params in SELECT function args as columns', () => {
			const result = compile(
				'users | select lower(:nope) as x',
				schema,
				undefined,
				{
					params: { nope: 'alice' },
				},
			);
			expect(result.success).toBe(true);
		});

		it('should accept valid relation path (relation.column)', () => {
			const result = compile('orders | select id, user.name', schema);
			expect(result.success).toBe(true);
		});

		it('should accept valid pseudo-column path (parent.name)', () => {
			const result = compile(
				'categories | select id, name, parent.name',
				schema,
			);
			expect(result.success).toBe(true);
		});

		it('should accept valid BETWEEN columns', () => {
			const result = compile('orders | where total between 10 and 100', schema);
			expect(result.success).toBe(true);
		});

		it('should accept valid IN columns', () => {
			const result = compile(
				'orders | where status in ("pending", "shipped")',
				schema,
			);
			expect(result.success).toBe(true);
		});

		it('should accept valid IS NULL column', () => {
			const result = compile('users | where email is null', schema);
			expect(result.success).toBe(true);
		});

		it('should accept valid LIKE column', () => {
			const result = compile('users | where name like "%john%"', schema);
			expect(result.success).toBe(true);
		});

		it('should accept valid INSERT columns', () => {
			const result = compile(
				'insert into users set name = "John", email = "john@example.com"',
				schema,
			);
			expect(result.success).toBe(true);
		});

		it('should accept valid UPDATE columns', () => {
			const result = compile(
				'update users set active = false where id = 1',
				schema,
			);
			expect(result.success).toBe(true);
		});

		it('should accept valid UPSERT columns', () => {
			const result = compile(
				'upsert into users on (email) set name = "John", email = "john@example.com"',
				schema,
			);
			expect(result.success).toBe(true);
		});

		it('should accept valid RETURNING columns', () => {
			const result = compile(
				'insert into users set name = "John" | select id, name',
				schema,
			);
			expect(result.success).toBe(true);
		});
	});

	describe('invalid columns — produces errors', () => {
		it('should reject non-existent column in SELECT', () => {
			const result = compile('users | select id, namee', schema);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.code).toBe('ERR-SEM-001');
			expect(result.errors[0]?.message).toContain(
				"Column 'namee' does not exist on table 'users'",
			);
			expect(result.errors[0]?.message).toContain('Available columns:');
		});

		it('should reject non-existent column in WHERE', () => {
			const result = compile('users | where actve = true', schema);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain(
				"Column 'actve' does not exist on table 'users'",
			);
		});

		it('should reject non-existent column in ORDER BY', () => {
			const result = compile('users | order by sortOrder2 desc', schema);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain(
				"Column 'sortOrder2' does not exist on table 'users'",
			);
		});

		it('should reject non-existent column in GROUP BY', () => {
			const result = compile(
				'orders | select statusX, count(*) as cnt | group by statusX',
				schema,
			);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain("Column 'statusX'");
		});

		it('should reject non-existent column in aggregate', () => {
			const result = compile(
				'orders | select sum(totall) as totalRevenue',
				schema,
			);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain(
				"Column 'totall' does not exist on table 'orders'",
			);
		});

		it('should reject non-existent column in SELECT function args', () => {
			const result = compile('users | select lower(nope) as x', schema);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.code).toBe('ERR-SEM-001');
			expect(result.errors[0]?.message).toContain(
				"Column 'nope' does not exist on table 'users'",
			);
		});

		it('should reject non-existent column in nested SELECT function arg expressions', () => {
			const result = compile(
				'users | select round(nope + :d) as x',
				schema,
				undefined,
				{ params: { d: 1 } },
			);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.code).toBe('ERR-SEM-001');
			expect(result.errors[0]?.message).toContain(
				"Column 'nope' does not exist on table 'users'",
			);
		});

		it('should reject non-existent column on relation target', () => {
			const result = compile('orders | select id, user.namee', schema);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain(
				"Column 'namee' does not exist on table 'users'",
			);
		});

		it('should reject non-existent column in INSERT', () => {
			const result = compile('insert into users set namee = "John"', schema);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain(
				"Column 'namee' does not exist on table 'users'",
			);
		});

		it('should reject non-existent column in UPDATE', () => {
			const result = compile(
				'update users set actve = false where id = 1',
				schema,
			);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain(
				"Column 'actve' does not exist on table 'users'",
			);
		});

		it('should reject non-existent column in UPSERT', () => {
			const result = compile(
				'upsert into users on (email) set namee = "John", email = "john@example.com"',
				schema,
			);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain(
				"Column 'namee' does not exist on table 'users'",
			);
		});

		it('should reject non-existent column in RETURNING', () => {
			const result = compile(
				'insert into users set name = "John" | select id, namee',
				schema,
			);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain(
				"Column 'namee' does not exist on table 'users'",
			);
		});

		it('should reject non-existent column in BETWEEN', () => {
			const result = compile(
				'orders | where totall between 10 and 100',
				schema,
			);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain("Column 'totall'");
		});

		it('should reject non-existent column in IN', () => {
			const result = compile(
				'orders | where statusX in ("pending", "shipped")',
				schema,
			);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain("Column 'statusX'");
		});

		it('should reject non-existent column in IS NULL', () => {
			const result = compile('users | where emaill is null', schema);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain("Column 'emaill'");
		});

		it('should reject non-existent column in pseudo-column path', () => {
			const result = compile('categories | select id, parent.namee', schema);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain(
				"Column 'namee' does not exist on table 'categories'",
			);
		});
	});

	describe('relation filter context validation', () => {
		it('should validate inner scope column in relation filter', () => {
			const result = compile(
				"users | where some(orders as o, o.statusX = 'pending')",
				schema,
			);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain(
				"Column 'statusX' does not exist on table 'orders'",
			);
		});

		it('should validate outer scope (bare column) in relation filter', () => {
			const result = compile(
				"users | where some(orders as o, o.status = 'pending' and activee = true)",
				schema,
			);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain(
				"Column 'activee' does not exist on table 'users'",
			);
		});

		it('should accept valid columns in relation filter', () => {
			const result = compile(
				"users | where some(orders as o, o.status = 'pending' and active = true)",
				schema,
			);
			expect(result.success).toBe(true);
		});

		it('should accept valid column in dot-syntax relation filter', () => {
			const result = compile(
				'users | where some(orders).status = true',
				schema,
			);
			expect(result.success).toBe(true);
		});

		it('should reject invalid column in dot-syntax relation filter', () => {
			const result = compile(
				'users | where some(orders).statusX = true',
				schema,
			);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain(
				"Column 'statusX' does not exist on table 'orders'",
			);
		});
	});

	describe('snake_case ↔ camelCase column name matching', () => {
		it('should accept snake_case equivalent of camelCase schema column', () => {
			const result = compile('users | where created_at is null', schema);
			expect(result.success).toBe(true);
		});

		it('should accept camelCase column directly', () => {
			const result = compile('users | where createdAt is null', schema);
			expect(result.success).toBe(true);
		});

		it('should reject column that matches neither camelCase nor snake_case', () => {
			const result = compile('users | where created_att is null', schema);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain(
				"Column 'created_att' does not exist on table 'users'",
			);
		});

		it('should accept snake_case column in SELECT', () => {
			const result = compile('orders | select id, user_id, created_at', schema);
			expect(result.success).toBe(true);
		});

		it('should accept snake_case column in ORDER BY', () => {
			const result = compile('users | order by created_at desc', schema);
			expect(result.success).toBe(true);
		});
	});

	describe('backward compatibility — no schema', () => {
		it('should accept any column when no schema is provided', () => {
			const result = compile('users | select nonExistent', null);
			expect(result.success).toBe(true);
		});

		it('should accept any column when schema is undefined', () => {
			const result = compile('users | select nonExistent', undefined);
			expect(result.success).toBe(true);
		});

		it('should accept any column when schema lacks getTable', () => {
			const result = compile('users | select nonExistent', { foo: 'bar' });
			expect(result.success).toBe(true);
		});
	});

	describe('unknown table validation', () => {
		it('should reject unknown table in SELECT query', () => {
			const result = compile('unknown_table | select anyColumn', schema);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain(
				"Table 'unknown_table' does not exist",
			);
		});

		it('should reject unknown table in INSERT', () => {
			const result = compile('insert into unknown_table set col = 1', schema);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain(
				"Table 'unknown_table' does not exist",
			);
		});

		it('should reject unknown table in DELETE', () => {
			const result = compile('delete from unknown_table where id = 1', schema);
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toContain(
				"Table 'unknown_table' does not exist",
			);
		});
	});
});
