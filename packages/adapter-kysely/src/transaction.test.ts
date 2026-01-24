import {
	buildModelFromResolvedSchema,
	createOrm,
	defineSchema,
	eq,
} from '@dbsp/core';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKyselyAdapter } from './kysely-adapter.js';

// Create proper ModelIR using schema builder
const testModel = buildModelFromResolvedSchema(
	defineSchema(
		{
			users: {
				id: { type: 'integer', primaryKey: true },
				name: { type: 'string' },
				balance: { type: 'integer' },
			},
			orders: {
				id: { type: 'integer', primaryKey: true },
				userId: { type: 'integer' },
				total: { type: 'integer' },
			},
		},
		{
			relations: {
				'users.orders': { kind: 'hasMany', target: 'orders', foreignKey: 'userId' },
				'orders.user': { kind: 'belongsTo', target: 'users', foreignKey: 'userId' },
			},
		},
	),
);

// Database schema types
interface TestDatabase {
	users: {
		id: number;
		name: string;
		balance: number;
	};
	orders: {
		id: number;
		userId: number;
		total: number;
	};
}

// Create in-memory SQLite database for testing
function createTestDb(): Kysely<TestDatabase> {
	return new Kysely<TestDatabase>({
		dialect: new SqliteDialect({
			database: new Database(':memory:'),
		}),
	});
}

// Setup database tables
async function setupDatabase(db: Kysely<TestDatabase>): Promise<void> {
	await db.schema
		.createTable('users')
		.addColumn('id', 'integer', (col) => col.primaryKey())
		.addColumn('name', 'text', (col) => col.notNull())
		.addColumn('balance', 'integer', (col) => col.notNull())
		.execute();

	await db.schema
		.createTable('orders')
		.addColumn('id', 'integer', (col) => col.primaryKey())
		.addColumn('userId', 'integer', (col) => col.notNull())
		.addColumn('total', 'integer', (col) => col.notNull())
		.execute();
}

// Seed test data
async function seedData(db: Kysely<TestDatabase>): Promise<void> {
	await db
		.insertInto('users')
		.values([
			{ id: 1, name: 'Alice', balance: 1000 },
			{ id: 2, name: 'Bob', balance: 500 },
		])
		.execute();
}

describe('Transaction Support (DX-025)', () => {
	let db: Kysely<TestDatabase>;

	beforeAll(async () => {
		db = createTestDb();
		await setupDatabase(db);
	});

	beforeEach(async () => {
		// Reset data before each test
		await db.deleteFrom('orders').execute();
		await db.deleteFrom('users').execute();
		await seedData(db);
	});

	afterAll(async () => {
		await db.destroy();
	});

	describe('transaction()', () => {
		it('should commit on success', async () => {
			const orm = createOrm<TestDatabase>({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});

			const result = await orm.transaction(async (tx) => {
				// Insert an order
				await tx
					.insert('orders')
					.values({ id: 1, userId: 1, total: 100 })
					.execute();
				// Update user balance
				await tx
					.update('users')
					.set({ balance: 900 })
					.where(eq('id', 1))
					.execute();
				return { success: true };
			});

			expect(result).toEqual({ success: true });

			// Verify changes were committed
			const user = await orm.select('users').where(eq('id', 1)).first();
			expect(user?.balance).toBe(900);

			const orders = await orm.select('orders').all();
			expect(orders).toHaveLength(1);
			expect(orders[0]?.total).toBe(100);
		});

		it('should rollback on exception', async () => {
			const orm = createOrm<TestDatabase>({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});

			// Get initial state
			const initialUser = await orm.select('users').where(eq('id', 1)).first();
			expect(initialUser?.balance).toBe(1000);

			// Transaction that throws
			await expect(
				orm.transaction(async (tx) => {
					// Insert an order
					await tx
						.insert('orders')
						.values({ id: 1, userId: 1, total: 100 })
						.execute();
					// Update user balance
					await tx
						.update('users')
						.set({ balance: 900 })
						.where(eq('id', 1))
						.execute();
					// Throw error before commit
					throw new Error('Validation failed');
				}),
			).rejects.toThrow('Validation failed');

			// Verify changes were rolled back
			const user = await orm.select('users').where(eq('id', 1)).first();
			expect(user?.balance).toBe(1000); // Original balance

			const orders = await orm.select('orders').all();
			expect(orders).toHaveLength(0); // No orders created
		});

		it('should return value from callback', async () => {
			const orm = createOrm<TestDatabase>({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});

			const result = await orm.transaction(async (tx) => {
				const user = await tx.select('users').where(eq('id', 1)).first();
				return { userId: user?.id, name: user?.name };
			});

			expect(result).toEqual({ userId: 1, name: 'Alice' });
		});

		it('should throw error without database connection', async () => {
			const orm = createOrm<TestDatabase>({ model: testModel });

			await expect(
				orm.transaction(async () => {
					return 'should not reach here';
				}),
			).rejects.toThrow('transaction() requires an adapter');
		});

		it('should support nested queries within transaction', async () => {
			const orm = createOrm<TestDatabase>({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});

			const result = await orm.transaction(async (tx) => {
				// Insert order
				await tx
					.insert('orders')
					.values({ id: 1, userId: 1, total: 50 })
					.execute();
				await tx
					.insert('orders')
					.values({ id: 2, userId: 1, total: 75 })
					.execute();

				// Query within transaction sees uncommitted data
				const orders = await tx.select('orders').where(eq('userId', 1)).all();
				return orders.length;
			});

			expect(result).toBe(2);
		});

		it('should work with includes in transaction', async () => {
			const orm = createOrm<TestDatabase>({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});

			// Insert initial order outside transaction
			await orm
				.insert('orders')
				.values({ id: 1, userId: 1, total: 100 })
				.execute();

			const result = await orm.transaction(async (tx) => {
				// Query with include inside transaction
				const user = await tx
					.select('users')
					.where(eq('id', 1))
					.include('orders')
					.first();

				expect(user?.name).toBe('Alice');

				// Insert another order in transaction
				await tx
					.insert('orders')
					.values({ id: 2, userId: 1, total: 200 })
					.execute();

				// Verify transaction sees uncommitted insert
				const orders = await tx.select('orders').where(eq('userId', 1)).all();
				return orders.length;
			});

			// Transaction should see both orders
			expect(result).toBe(2);

			// After commit, both orders should persist
			const allOrders = await orm.select('orders').all();
			expect(allOrders).toHaveLength(2);
		});
	});

	describe('withSchema().transaction()', () => {
		// Note: SQLite doesn't support schemas, so we test that the API works
		// without actually verifying schema isolation (would need PostgreSQL)

		it('should preserve tenant context in transaction', async () => {
			const orm = createOrm<TestDatabase>({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const scopedOrm = orm.withSchema('tenant_acme');

			// The transaction callback receives a tenant-scoped ORM
			// This tests that the API chain works correctly
			await expect(
				scopedOrm.transaction(async (_tx) => {
					// tx should be tenant-scoped
					// In SQLite this won't actually use a schema, but the API should work
					return 'completed';
				}),
			).resolves.toBe('completed');
		});
	});

	// =========================================================================
	// Raw SQL Execution (DX-027)
	// =========================================================================

	describe('raw() - Raw SQL Escape Hatch (DX-027)', () => {
		it('should execute raw SQL with parameters', async () => {
			const orm = createOrm<TestDatabase>({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});

			// Query using raw SQL with parameter
			const results = await orm.raw<{ id: number; name: string }>(
				'SELECT id, name FROM users WHERE balance > ?',
				[600],
			);

			expect(results).toHaveLength(1);
			expect(results[0]?.name).toBe('Alice');
			expect(results[0]?.id).toBe(1);
		});

		it('should execute raw SQL without parameters', async () => {
			const orm = createOrm<TestDatabase>({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});

			const results = await orm.raw<{ total: number }>(
				'SELECT COUNT(*) as total FROM users',
			);

			expect(results).toHaveLength(1);
			expect(results[0]?.total).toBe(2);
		});

		it('should handle complex raw SQL queries', async () => {
			const orm = createOrm<TestDatabase>({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});

			// Insert some orders for testing
			await orm
				.insert('orders')
				.values([
					{ id: 1, userId: 1, total: 100 },
					{ id: 2, userId: 1, total: 200 },
					{ id: 3, userId: 2, total: 50 },
				])
				.execute();

			// Complex query with GROUP BY and aggregation
			const results = await orm.raw<{
				userId: number;
				orderCount: number;
				totalAmount: number;
			}>(
				`SELECT userId,
				        COUNT(*) as orderCount,
				        SUM(total) as totalAmount
				 FROM orders
				 GROUP BY userId
				 ORDER BY totalAmount DESC`,
			);

			expect(results).toHaveLength(2);
			expect(results[0]?.userId).toBe(1);
			expect(results[0]?.orderCount).toBe(2);
			expect(results[0]?.totalAmount).toBe(300);
		});

		it('should throw error without adapter', async () => {
			const orm = createOrm<TestDatabase>({ model: testModel });

			await expect(orm.raw('SELECT * FROM users')).rejects.toThrow(
				'raw() requires an adapter',
			);
		});

		it('should work within transactions', async () => {
			const orm = createOrm<TestDatabase>({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});

			const result = await orm.transaction(async (tx) => {
				// Insert using raw SQL within transaction
				await tx.raw(
					'INSERT INTO orders (id, userId, total) VALUES (?, ?, ?)',
					[10, 1, 999],
				);

				// Query using raw SQL within same transaction
				const orders = await tx.raw<{ total: number }>(
					'SELECT total FROM orders WHERE id = ?',
					[10],
				);

				return orders[0]?.total;
			});

			expect(result).toBe(999);

			// Verify committed
			const order = await orm.select('orders').where(eq('id', 10)).first();
			expect(order?.total).toBe(999);
		});

		it('should handle empty result sets', async () => {
			const orm = createOrm<TestDatabase>({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});

			const results = await orm.raw<{ id: number }>(
				'SELECT id FROM users WHERE balance > ?',
				[999999],
			);

			expect(results).toHaveLength(0);
			expect(results).toEqual([]);
		});

		it('should support multiple parameters', async () => {
			const orm = createOrm<TestDatabase>({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});

			const results = await orm.raw<{ id: number; name: string }>(
				'SELECT id, name FROM users WHERE balance >= ? AND balance <= ?',
				[500, 1000],
			);

			// Both Alice (1000) and Bob (500) should match
			expect(results).toHaveLength(2);
		});
	});
});
