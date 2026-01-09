import { InvalidIdentifierError } from '@db-semantic-planner/adapter-kysely';
import { belongsTo, defineSchema, hasMany } from '@db-semantic-planner/core';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ExecutionError, NotFoundError } from './errors.js';
import { eq } from './filters.js';
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

			await expect(orm.select('users').all()).rejects.toThrow(ExecutionError);
			await expect(orm.select('users').all()).rejects.toThrow(
				'Database not configured',
			);
		});

		it('executes query and returns rows when db is configured', async () => {
			const orm = createOrm({ model: testModel, db });
			const result = await orm.select('users').all();

			expect(result).toHaveLength(2);
			expect(result[0]).toHaveProperty('name');
			expect(result[0]).toHaveProperty('email');
		});

		it('returns empty array when no rows match', async () => {
			// Create fresh DB without data
			const emptyDb = createTestDb();
			await setupDatabase(emptyDb);

			const orm = createOrm({ model: testModel, db: emptyDb });
			const result = await orm.select('users').all();

			expect(result).toEqual([]);
			await emptyDb.destroy();
		});
	});

	describe('findFirst()', () => {
		it('throws ExecutionError when db is not configured', async () => {
			const orm = createOrm({ model: testModel });

			await expect(orm.select('users').first()).rejects.toThrow(ExecutionError);
		});

		it('returns first row when results exist', async () => {
			const orm = createOrm({ model: testModel, db });
			const result = await orm.select('users').first();

			expect(result).toBeDefined();
			expect(result).toHaveProperty('name');
		});

		it('returns undefined when no rows match', async () => {
			// Create fresh DB without data
			const emptyDb = createTestDb();
			await setupDatabase(emptyDb);

			const orm = createOrm({ model: testModel, db: emptyDb });
			const result = await orm.select('users').first();

			expect(result).toBeUndefined();
			await emptyDb.destroy();
		});
	});

	describe('findFirstOrThrow()', () => {
		it('throws ExecutionError when db is not configured', async () => {
			const orm = createOrm({ model: testModel });

			await expect(orm.select('users').firstOrThrow()).rejects.toThrow(
				ExecutionError,
			);
		});

		it('returns first row when results exist', async () => {
			const orm = createOrm({ model: testModel, db });
			const result = await orm.select('users').firstOrThrow();

			expect(result).toBeDefined();
			expect(result).toHaveProperty('name');
		});

		it('throws NotFoundError when no rows match', async () => {
			// Create fresh DB without data
			const emptyDb = createTestDb();
			await setupDatabase(emptyDb);

			const orm = createOrm({ model: testModel, db: emptyDb });

			await expect(orm.select('users').firstOrThrow()).rejects.toThrow(
				NotFoundError,
			);
			await expect(orm.select('users').firstOrThrow()).rejects.toThrow(
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
				await orm.select('posts').firstOrThrow();
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
			const builder = tenantOrm.select('users');

			// Should be able to build a plan
			const planReport = builder.plan();
			expect(planReport).toBeDefined();
			expect(planReport.intent.from).toBe('users');
		});

		describe('schema name validation (F-001 security fix)', () => {
			it('accepts valid schema names', () => {
				const orm = createOrm({ model: testModel, db });

				expect(() => orm.forTenant('tenant_123')).not.toThrow();
				expect(() => orm.forTenant('acme')).not.toThrow();
				expect(() => orm.forTenant('_private')).not.toThrow();
				expect(() => orm.forTenant('MySchema')).not.toThrow();
			});

			it('rejects schema names with hyphens', () => {
				const orm = createOrm({ model: testModel, db });

				expect(() => orm.forTenant('my-schema')).toThrow(
					InvalidIdentifierError,
				);
			});

			it('rejects schema names starting with numbers', () => {
				const orm = createOrm({ model: testModel, db });

				expect(() => orm.forTenant('123tenant')).toThrow(
					InvalidIdentifierError,
				);
			});

			it('rejects schema names with special characters', () => {
				const orm = createOrm({ model: testModel, db });

				expect(() => orm.forTenant('schema!')).toThrow(InvalidIdentifierError);
				expect(() => orm.forTenant('schema@tenant')).toThrow(
					InvalidIdentifierError,
				);
			});

			it('rejects SQL injection attempts', () => {
				const orm = createOrm({ model: testModel, db });

				expect(() => orm.forTenant("'; DROP TABLE users;--")).toThrow(
					InvalidIdentifierError,
				);
				expect(() => orm.forTenant('public.users')).toThrow(
					InvalidIdentifierError,
				);
			});

			it('rejects empty schema names', () => {
				const orm = createOrm({ model: testModel, db });

				expect(() => orm.forTenant('')).toThrow(InvalidIdentifierError);
			});
		});
	});

	describe('dump()', () => {
		it('throws ExecutionError when db is not configured', () => {
			const orm = createOrm({ model: testModel });

			expect(() => orm.select('users').dump()).toThrow(ExecutionError);
			expect(() => orm.select('users').dump()).toThrow(
				'Database not configured',
			);
		});

		it('returns complete Dump object when db is configured', () => {
			const orm = createOrm({ model: testModel, db });
			const dump = orm.select('users').dump();

			// Verify structure
			expect(dump).toHaveProperty('plan');
			expect(dump).toHaveProperty('sql');
			expect(dump).toHaveProperty('params');
			expect(dump).toHaveProperty('meta');

			// Verify plan
			expect(dump.plan.intent.from).toBe('users');

			// Verify SQL (SQLite uses lowercase)
			expect(dump.sql.toLowerCase()).toContain('select');
			expect(dump.sql.toLowerCase()).toContain('users');

			// Verify params is array
			expect(Array.isArray(dump.params)).toBe(true);

			// Verify meta
			expect(dump.meta?.compiledAt).toBeInstanceOf(Date);
		});

		it('includes params for where clause', () => {
			const orm = createOrm({ model: testModel, db });
			const dump = orm
				.select('users')
				.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 42 })
				.dump();

			expect(dump.params).toContain(42);
		});

		it('includes tenant in meta for forTenant()', () => {
			const orm = createOrm({ model: testModel, db });
			const dump = orm.forTenant('acme').select('users').dump();

			expect(dump.meta?.tenant).toBe('acme');
			// SQL should include schema qualification
			expect(dump.sql).toContain('"acme"');
		});

		it('does not include tenant in meta when no tenant', () => {
			const orm = createOrm({ model: testModel, db });
			const dump = orm.select('users').dump();

			expect(dump.meta?.tenant).toBeUndefined();
		});

		it('works with complex query chain', () => {
			const orm = createOrm({ model: testModel, db });
			const dump = orm
				.select('users')
				.columns(['id', 'name'])
				.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
				.dump();

			expect(dump.plan).toBeDefined();
			expect(dump.sql.toLowerCase()).toContain('select');
			expect(dump.params).toContain(1);
		});
	});

	describe('execute()', () => {
		it('throws ExecutionError when db is not configured', async () => {
			const orm = createOrm({ model: testModel });

			await expect(orm.select('users').execute()).rejects.toThrow(
				ExecutionError,
			);
			await expect(orm.select('users').execute()).rejects.toThrow(
				'Database not configured',
			);
		});

		it('is an alias for findMany()', async () => {
			const orm = createOrm({ model: testModel, db });

			const executeResult = await orm.select('users').execute();
			const findManyResult = await orm.select('users').all();

			expect(executeResult).toEqual(findManyResult);
		});

		it('returns all rows', async () => {
			const orm = createOrm({ model: testModel, db });
			const result = await orm.select('users').execute();

			expect(result).toHaveLength(2);
		});

		it('returns empty array when no rows match', async () => {
			// Create fresh DB without data
			const emptyDb = createTestDb();
			await setupDatabase(emptyDb);

			const orm = createOrm({ model: testModel, db: emptyDb });
			const result = await orm.select('users').execute();

			expect(result).toEqual([]);
			await emptyDb.destroy();
		});

		it('works with where clause', async () => {
			const orm = createOrm({ model: testModel, db });
			const result = await orm
				.select('users')
				.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
				.execute();

			expect(result).toHaveLength(1);
		});
	});

	describe('execution with builder chain', () => {
		it('executes query with where clause', async () => {
			const orm = createOrm({ model: testModel, db });
			const result = await orm
				.select('users')
				.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
				.all();

			expect(result).toHaveLength(1);
		});

		it('executes query with select', async () => {
			const orm = createOrm({ model: testModel, db });
			const result = await orm.select('users').columns(['name']).all();

			expect(result).toHaveLength(2);
			// Result contains at least the selected field
			expect(result[0]).toHaveProperty('name');
		});

		it('maintains db through builder chain', async () => {
			const orm = createOrm({ model: testModel, db });

			// Chain multiple operations
			const result = await orm
				.select('users')
				.columns(['id', 'name'])
				.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
				.withStrictMode(true)
				.first();

			expect(result).toBeDefined();
		});
	});

	describe('stream()', () => {
		it('throws ExecutionError when db is not configured', () => {
			const orm = createOrm({ model: testModel });

			// stream() throws immediately because it needs db for dump()
			expect(() => orm.select('users').stream()).toThrow(ExecutionError);
			expect(() => orm.select('users').stream()).toThrow(
				'Database not configured',
			);
		});

		it('returns an AsyncIterableIterator', () => {
			const orm = createOrm({ model: testModel, db });
			const iterator = orm.select('users').stream();

			expect(typeof iterator[Symbol.asyncIterator]).toBe('function');
			expect(typeof iterator.next).toBe('function');
		});

		it('yields rows one at a time', async () => {
			const orm = createOrm({ model: testModel, db });
			const results: unknown[] = [];

			for await (const row of orm.select('users').stream()) {
				results.push(row);
			}

			expect(results).toHaveLength(2);
			expect(results[0]).toHaveProperty('name');
		});

		it('supports early break from iteration', async () => {
			const orm = createOrm({ model: testModel, db });
			const results: unknown[] = [];

			for await (const row of orm.select('users').stream()) {
				results.push(row);
				break; // Stop after first row
			}

			expect(results).toHaveLength(1);
		});

		it('invokes onStart callback before streaming', async () => {
			const orm = createOrm({ model: testModel, db });
			const onStart = vi.fn();

			const iterator = orm.select('users').stream({ onStart });
			await iterator.next();

			expect(onStart).toHaveBeenCalledOnce();
			expect(onStart).toHaveBeenCalledWith(
				expect.objectContaining({
					plan: expect.any(Object),
					sql: expect.any(String),
					params: expect.any(Array),
				}),
			);
		});

		it('accepts chunkSize option', async () => {
			const orm = createOrm({ model: testModel, db });
			const results: unknown[] = [];

			for await (const row of orm.select('users').stream({ chunkSize: 1 })) {
				results.push(row);
			}

			expect(results).toHaveLength(2);
		});

		it('works with where clause', async () => {
			const orm = createOrm({ model: testModel, db });
			const results: unknown[] = [];

			for await (const row of orm.select('users').where(eq('id', 1)).stream()) {
				results.push(row);
			}

			expect(results).toHaveLength(1);
		});

		it('handles empty result set', async () => {
			// Create fresh DB without data
			const emptyDb = createTestDb();
			await setupDatabase(emptyDb);

			const orm = createOrm({ model: testModel, db: emptyDb });
			const results: unknown[] = [];

			for await (const row of orm.select('users').stream()) {
				results.push(row);
			}

			expect(results).toHaveLength(0);
			await emptyDb.destroy();
		});

		it('works with multi-tenant forTenant()', async () => {
			// Note: SQLite doesn't support schemas, so this tests the API works
			// Real schema isolation is tested in E2E with PostgreSQL
			const orm = createOrm({ model: testModel, db });
			const tenantOrm = orm.forTenant('tenant_123');
			const onStart = vi.fn();

			// The stream() call should work (will fail on execution due to missing schema)
			const iterator = tenantOrm.select('users').stream({ onStart });

			// Verify the iterator is created correctly
			expect(typeof iterator[Symbol.asyncIterator]).toBe('function');
		});

		it('preserves query builder state through stream()', async () => {
			const orm = createOrm({ model: testModel, db });
			const onStart = vi.fn();

			// Chain operations then stream
			const results: unknown[] = [];
			for await (const row of orm
				.select('users')
				.columns(['id', 'name'])
				.where(eq('id', 1))
				.stream({ onStart })) {
				results.push(row);
			}

			expect(results).toHaveLength(1);
			expect(onStart).toHaveBeenCalledOnce();
		});
	});

	describe('orderBy()', () => {
		it('generates ORDER BY clause in SQL', () => {
			const orm = createOrm({ model: testModel, db });
			const dump = orm.select('users').orderBy('name').dump();

			expect(dump.sql.toLowerCase()).toContain('order by');
			expect(dump.sql.toLowerCase()).toContain('name');
		});

		it('defaults to ascending order', () => {
			const orm = createOrm({ model: testModel, db });
			const dump = orm.select('users').orderBy('name').dump();

			expect(dump.sql.toLowerCase()).toContain('asc');
		});

		it('supports descending order', () => {
			const orm = createOrm({ model: testModel, db });
			const dump = orm.select('users').orderBy('name', 'desc').dump();

			expect(dump.sql.toLowerCase()).toContain('desc');
		});

		it('supports chaining multiple orderBy calls', () => {
			const orm = createOrm({ model: testModel, db });
			const dump = orm
				.select('users')
				.orderBy('name', 'asc')
				.orderBy('id', 'desc')
				.dump();

			// Both fields should be in ORDER BY
			expect(dump.sql.toLowerCase()).toContain('order by');
			expect(dump.sql.toLowerCase()).toContain('name');
			expect(dump.sql.toLowerCase()).toContain('id');
		});

		it('returns results in correct order', async () => {
			const orm = createOrm({ model: testModel, db });
			const results = (await orm
				.select('users')
				.orderBy('name', 'asc')
				.all()) as { name: string }[];

			// Alice should come before Bob alphabetically
			expect(results[0].name).toBe('Alice');
			expect(results[1].name).toBe('Bob');
		});

		it('returns results in descending order', async () => {
			const orm = createOrm({ model: testModel, db });
			const results = (await orm
				.select('users')
				.orderBy('name', 'desc')
				.all()) as { name: string }[];

			// Bob should come before Alice in descending order
			expect(results[0].name).toBe('Bob');
			expect(results[1].name).toBe('Alice');
		});
	});

	describe('limit()', () => {
		it('generates LIMIT clause in SQL', () => {
			const orm = createOrm({ model: testModel, db });
			const dump = orm.select('users').limit(10).dump();

			expect(dump.sql.toLowerCase()).toContain('limit');
		});

		it('limits the number of results', async () => {
			const orm = createOrm({ model: testModel, db });
			const results = await orm.select('users').limit(1).all();

			expect(results).toHaveLength(1);
		});

		it('returns all results when limit exceeds count', async () => {
			const orm = createOrm({ model: testModel, db });
			const results = await orm.select('users').limit(100).all();

			expect(results).toHaveLength(2); // Only 2 users in test data
		});
	});

	describe('offset()', () => {
		it('generates OFFSET clause in SQL', () => {
			const orm = createOrm({ model: testModel, db });
			const dump = orm.select('users').offset(5).dump();

			expect(dump.sql.toLowerCase()).toContain('offset');
		});

		it('skips the specified number of results', async () => {
			const orm = createOrm({ model: testModel, db });
			// Note: SQLite requires LIMIT when using OFFSET
			const results = await orm
				.select('users')
				.orderBy('id')
				.limit(100)
				.offset(1)
				.all();

			expect(results).toHaveLength(1);
			expect((results[0] as { id: number }).id).toBe(2); // Second user
		});

		it('returns empty array when offset exceeds count', async () => {
			const orm = createOrm({ model: testModel, db });
			// Note: SQLite requires LIMIT when using OFFSET
			const results = await orm.select('users').limit(100).offset(100).all();

			expect(results).toHaveLength(0);
		});
	});

	describe('pagination (limit + offset)', () => {
		it('supports pagination with limit and offset', () => {
			const orm = createOrm({ model: testModel, db });
			const dump = orm
				.select('users')
				.orderBy('id')
				.limit(10)
				.offset(20)
				.dump();

			expect(dump.sql.toLowerCase()).toContain('limit');
			expect(dump.sql.toLowerCase()).toContain('offset');
			expect(dump.sql.toLowerCase()).toContain('order by');
		});

		it('returns correct page of results', async () => {
			const orm = createOrm({ model: testModel, db });
			// Page 2 with page size 1
			const results = await orm
				.select('users')
				.orderBy('id')
				.limit(1)
				.offset(1)
				.all();

			expect(results).toHaveLength(1);
			expect((results[0] as { id: number }).id).toBe(2);
		});

		it('combines with where clause', async () => {
			const orm = createOrm({ model: testModel, db });
			const results = await orm
				.select('posts')
				.where(eq('userId', 1))
				.orderBy('id')
				.limit(1)
				.all();

			expect(results).toHaveLength(1);
			expect((results[0] as { title: string }).title).toBe('First Post');
		});
	});
});
