import { belongsTo, defineSchema, hasMany } from '@db-semantic-planner/core';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExecutionError, NotFoundError } from './errors.js';
import { createOrm } from './orm.js';

// Create proper ModelIR using schema builder
const testModel = defineSchema({
	users: {
		id: 'integer',
		name: 'string',
		email: 'string',
	},
	posts: {
		id: 'integer',
		title: 'string',
		userId: 'integer',
	},
})
	.relations({
		users: {
			posts: hasMany('posts', { foreignKey: 'userId' }),
		},
		posts: {
			author: belongsTo('users', { foreignKey: 'userId' }),
		},
	})
	.build();

// Database schema types
interface TestDatabase {
	users: {
		id: number;
		name: string;
		email: string;
	};
	posts: {
		id: number;
		title: string;
		userId: number;
	};
}

// Create in-memory SQLite database for testing
function createTestDb(): Kysely<TestDatabase> {
	const db = new Kysely<TestDatabase>({
		dialect: new SqliteDialect({
			database: new Database(':memory:'),
		}),
	});

	return db;
}

// Setup database tables and seed data
async function setupDatabase(db: Kysely<TestDatabase>): Promise<void> {
	// Create tables
	await db.schema
		.createTable('users')
		.addColumn('id', 'integer', (col) => col.primaryKey())
		.addColumn('name', 'text', (col) => col.notNull())
		.addColumn('email', 'text', (col) => col.notNull())
		.execute();

	await db.schema
		.createTable('posts')
		.addColumn('id', 'integer', (col) => col.primaryKey())
		.addColumn('title', 'text', (col) => col.notNull())
		.addColumn('userId', 'integer', (col) => col.notNull())
		.execute();
}

// Seed test data
async function seedData(db: Kysely<TestDatabase>): Promise<void> {
	await db
		.insertInto('users')
		.values([
			{ id: 1, name: 'Alice', email: 'alice@example.com' },
			{ id: 2, name: 'Bob', email: 'bob@example.com' },
		])
		.execute();

	await db
		.insertInto('posts')
		.values([
			{ id: 1, title: 'First Post', userId: 1 },
			{ id: 2, title: 'Second Post', userId: 1 },
		])
		.execute();
}

describe('Execution Layer', () => {
	let db: Kysely<TestDatabase>;

	beforeAll(async () => {
		db = createTestDb();
		await setupDatabase(db);
		await seedData(db);
	});

	afterAll(async () => {
		await db.destroy();
	});

	describe('findMany()', () => {
		it('throws ExecutionError when db is not configured', async () => {
			const orm = createOrm({ model: testModel });

			await expect(orm.query('users').findMany()).rejects.toThrow(
				ExecutionError,
			);
			await expect(orm.query('users').findMany()).rejects.toThrow(
				'Database not configured',
			);
		});

		it('executes query and returns rows when db is configured', async () => {
			const orm = createOrm({ model: testModel, db });
			const result = await orm.query('users').findMany();

			expect(result).toHaveLength(2);
			expect(result[0]).toHaveProperty('name');
			expect(result[0]).toHaveProperty('email');
		});

		it('returns empty array when no rows match', async () => {
			// Create fresh DB without data
			const emptyDb = createTestDb();
			await setupDatabase(emptyDb);

			const orm = createOrm({ model: testModel, db: emptyDb });
			const result = await orm.query('users').findMany();

			expect(result).toEqual([]);
			await emptyDb.destroy();
		});
	});

	describe('findFirst()', () => {
		it('throws ExecutionError when db is not configured', async () => {
			const orm = createOrm({ model: testModel });

			await expect(orm.query('users').findFirst()).rejects.toThrow(
				ExecutionError,
			);
		});

		it('returns first row when results exist', async () => {
			const orm = createOrm({ model: testModel, db });
			const result = await orm.query('users').findFirst();

			expect(result).toBeDefined();
			expect(result).toHaveProperty('name');
		});

		it('returns undefined when no rows match', async () => {
			// Create fresh DB without data
			const emptyDb = createTestDb();
			await setupDatabase(emptyDb);

			const orm = createOrm({ model: testModel, db: emptyDb });
			const result = await orm.query('users').findFirst();

			expect(result).toBeUndefined();
			await emptyDb.destroy();
		});
	});

	describe('findFirstOrThrow()', () => {
		it('throws ExecutionError when db is not configured', async () => {
			const orm = createOrm({ model: testModel });

			await expect(orm.query('users').findFirstOrThrow()).rejects.toThrow(
				ExecutionError,
			);
		});

		it('returns first row when results exist', async () => {
			const orm = createOrm({ model: testModel, db });
			const result = await orm.query('users').findFirstOrThrow();

			expect(result).toBeDefined();
			expect(result).toHaveProperty('name');
		});

		it('throws NotFoundError when no rows match', async () => {
			// Create fresh DB without data
			const emptyDb = createTestDb();
			await setupDatabase(emptyDb);

			const orm = createOrm({ model: testModel, db: emptyDb });

			await expect(orm.query('users').findFirstOrThrow()).rejects.toThrow(
				NotFoundError,
			);
			await expect(orm.query('users').findFirstOrThrow()).rejects.toThrow(
				"No record found for 'users'",
			);
			await emptyDb.destroy();
		});

		it('NotFoundError includes table name', async () => {
			// Create fresh DB without data
			const emptyDb = createTestDb();
			await setupDatabase(emptyDb);

			const orm = createOrm({ model: testModel, db: emptyDb });

			try {
				await orm.query('posts').findFirstOrThrow();
				expect.fail('Should have thrown');
			} catch (error) {
				expect(error).toBeInstanceOf(NotFoundError);
				expect((error as NotFoundError).table).toBe('posts');
			}
			await emptyDb.destroy();
		});
	});

	describe('forTenant()', () => {
		it('returns a new ORM instance scoped to tenant schema', () => {
			const orm = createOrm({ model: testModel, db });

			const tenantOrm = orm.forTenant('tenant_123');

			// Verify it returns a new ORM instance
			expect(tenantOrm).toBeDefined();
			expect(tenantOrm).not.toBe(orm);
			expect(tenantOrm.strictMode).toBe(orm.strictMode);
		});

		it('preserves strictMode setting', () => {
			const orm = createOrm({ model: testModel, db, strictMode: true });

			const tenantOrm = orm.forTenant('tenant_123');

			expect(tenantOrm.strictMode).toBe(true);
		});

		it('can chain forTenant with query operations', () => {
			const orm = createOrm({ model: testModel, db });

			const tenantOrm = orm.forTenant('tenant_abc');
			const builder = tenantOrm.query('users');

			// Should be able to build a plan
			const planReport = builder.plan();
			expect(planReport).toBeDefined();
			expect(planReport.intent.from).toBe('users');
		});
	});

	describe('execution with builder chain', () => {
		it('executes query with where clause', async () => {
			const orm = createOrm({ model: testModel, db });
			const result = await orm
				.query('users')
				.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
				.findMany();

			expect(result).toHaveLength(1);
		});

		it('executes query with select', async () => {
			const orm = createOrm({ model: testModel, db });
			const result = await orm.query('users').select(['name']).findMany();

			expect(result).toHaveLength(2);
			// Result contains at least the selected field
			expect(result[0]).toHaveProperty('name');
		});

		it('maintains db through builder chain', async () => {
			const orm = createOrm({ model: testModel, db });

			// Chain multiple operations
			const result = await orm
				.query('users')
				.select(['id', 'name'])
				.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
				.withStrictMode(true)
				.findFirst();

			expect(result).toBeDefined();
		});
	});
});
