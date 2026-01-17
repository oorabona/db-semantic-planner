import {
	belongsTo,
	createOrm,
	defineSchema,
	ExecutionError,
	eq,
	hasMany,
	NotFoundError,
} from '@dbsp/core';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InvalidIdentifierError } from './errors.js';
import { createKyselyAdapter } from './kysely-adapter.js';

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
				'Adapter not configured',
			);
		});

		it('executes query and returns rows when db is configured', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const result = await orm.select('users').all();

			expect(result).toHaveLength(2);
			expect(result[0]).toHaveProperty('name');
			expect(result[0]).toHaveProperty('email');
		});

		it('returns empty array when no rows match', async () => {
			// Create fresh DB without data
			const emptyDb = createTestDb();
			await setupDatabase(emptyDb);

			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(emptyDb),
			});
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
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const result = await orm.select('users').first();

			expect(result).toBeDefined();
			expect(result).toHaveProperty('name');
		});

		it('returns undefined when no rows match', async () => {
			// Create fresh DB without data
			const emptyDb = createTestDb();
			await setupDatabase(emptyDb);

			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(emptyDb),
			});
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
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const result = await orm.select('users').firstOrThrow();

			expect(result).toBeDefined();
			expect(result).toHaveProperty('name');
		});

		it('throws NotFoundError when no rows match', async () => {
			// Create fresh DB without data
			const emptyDb = createTestDb();
			await setupDatabase(emptyDb);

			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(emptyDb),
			});

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

			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(emptyDb),
			});

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

	describe('withSchema()', () => {
		it('returns a new ORM instance scoped to tenant schema', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});

			const scopedOrm = orm.withSchema('tenant_123');

			// Verify it returns a new ORM instance
			expect(scopedOrm).toBeDefined();
			expect(scopedOrm).not.toBe(orm);
			expect(scopedOrm.strictMode).toBe(orm.strictMode);
		});

		it('preserves strictMode setting', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
				strictMode: true,
			});

			const scopedOrm = orm.withSchema('tenant_123');

			expect(scopedOrm.strictMode).toBe(true);
		});

		it('can chain withSchema with query operations', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});

			const scopedOrm = orm.withSchema('tenant_abc');
			const builder = scopedOrm.select('users');

			// Should be able to build a plan
			const planReport = builder.plan();
			expect(planReport).toBeDefined();
			expect(planReport.intent.from).toBe('users');
		});

		describe('schema name validation (F-001 security fix)', () => {
			it('accepts valid schema names', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});

				expect(() => orm.withSchema('tenant_123')).not.toThrow();
				expect(() => orm.withSchema('acme')).not.toThrow();
				expect(() => orm.withSchema('_private')).not.toThrow();
				expect(() => orm.withSchema('MySchema')).not.toThrow();
			});

			it('rejects schema names with hyphens', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});

				expect(() => orm.withSchema('my-schema')).toThrow(
					InvalidIdentifierError,
				);
			});

			it('rejects schema names starting with numbers', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});

				expect(() => orm.withSchema('123tenant')).toThrow(
					InvalidIdentifierError,
				);
			});

			it('rejects schema names with special characters', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});

				expect(() => orm.withSchema('schema!')).toThrow(InvalidIdentifierError);
				expect(() => orm.withSchema('schema@tenant')).toThrow(
					InvalidIdentifierError,
				);
			});

			it('rejects SQL injection attempts', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});

				expect(() => orm.withSchema("'; DROP TABLE users;--")).toThrow(
					InvalidIdentifierError,
				);
				expect(() => orm.withSchema('public.users')).toThrow(
					InvalidIdentifierError,
				);
			});

			it('rejects empty schema names', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});

				expect(() => orm.withSchema('')).toThrow(InvalidIdentifierError);
			});
		});
	});

	describe('dump()', () => {
		it('throws ExecutionError when db is not configured', () => {
			const orm = createOrm({ model: testModel });

			expect(() => orm.select('users').dump()).toThrow(ExecutionError);
			expect(() => orm.select('users').dump()).toThrow(
				'Adapter not configured',
			);
		});

		it('returns complete Dump object when db is configured', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
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
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const dump = orm
				.select('users')
				.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 42 })
				.dump();

			expect(dump.params).toContain(42);
		});

		it('includes tenant in meta for withSchema()', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const dump = orm.withSchema('acme').select('users').dump();

			expect(dump.meta?.schema).toBe('acme');
			// SQL should include schema qualification
			expect(dump.sql).toContain('"acme"');
		});

		it('does not include tenant in meta when no tenant', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const dump = orm.select('users').dump();

			expect(dump.meta?.schema).toBeUndefined();
		});

		it('works with complex query chain', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
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
				'Adapter not configured',
			);
		});

		it('is an alias for findMany()', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});

			const executeResult = await orm.select('users').execute();
			const findManyResult = await orm.select('users').all();

			expect(executeResult).toEqual(findManyResult);
		});

		it('returns all rows', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const result = await orm.select('users').execute();

			expect(result).toHaveLength(2);
		});

		it('returns empty array when no rows match', async () => {
			// Create fresh DB without data
			const emptyDb = createTestDb();
			await setupDatabase(emptyDb);

			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(emptyDb),
			});
			const result = await orm.select('users').execute();

			expect(result).toEqual([]);
			await emptyDb.destroy();
		});

		it('works with where clause', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const result = await orm
				.select('users')
				.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
				.execute();

			expect(result).toHaveLength(1);
		});
	});

	describe('execution with builder chain', () => {
		it('executes query with where clause', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const result = await orm
				.select('users')
				.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
				.all();

			expect(result).toHaveLength(1);
		});

		it('executes query with select', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const result = await orm.select('users').columns(['name']).all();

			expect(result).toHaveLength(2);
			// Result contains at least the selected field
			expect(result[0]).toHaveProperty('name');
		});

		it('maintains db through builder chain', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});

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
				'Adapter not configured',
			);
		});

		it('returns an AsyncIterableIterator', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const iterator = orm.select('users').stream();

			expect(typeof iterator[Symbol.asyncIterator]).toBe('function');
			expect(typeof iterator.next).toBe('function');
		});

		it('yields rows one at a time', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const results: unknown[] = [];

			for await (const row of orm.select('users').stream()) {
				results.push(row);
			}

			expect(results).toHaveLength(2);
			expect(results[0]).toHaveProperty('name');
		});

		it('supports early break from iteration', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const results: unknown[] = [];

			for await (const row of orm.select('users').stream()) {
				results.push(row);
				break; // Stop after first row
			}

			expect(results).toHaveLength(1);
		});

		it('invokes onStart callback before streaming', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
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
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const results: unknown[] = [];

			for await (const row of orm.select('users').stream({ chunkSize: 1 })) {
				results.push(row);
			}

			expect(results).toHaveLength(2);
		});

		it('works with where clause', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
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

			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(emptyDb),
			});
			const results: unknown[] = [];

			for await (const row of orm.select('users').stream()) {
				results.push(row);
			}

			expect(results).toHaveLength(0);
			await emptyDb.destroy();
		});

		it('works with multi-tenant withSchema()', async () => {
			// Note: SQLite doesn't support schemas, so this tests the API works
			// Real schema isolation is tested in E2E with PostgreSQL
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const scopedOrm = orm.withSchema('tenant_123');
			const onStart = vi.fn();

			// The stream() call should work (will fail on execution due to missing schema)
			const iterator = scopedOrm.select('users').stream({ onStart });

			// Verify the iterator is created correctly
			expect(typeof iterator[Symbol.asyncIterator]).toBe('function');
		});

		it('preserves query builder state through stream()', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
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
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const dump = orm.select('users').orderBy('name').dump();

			expect(dump.sql.toLowerCase()).toContain('order by');
			expect(dump.sql.toLowerCase()).toContain('name');
		});

		it('defaults to ascending order', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const dump = orm.select('users').orderBy('name').dump();

			expect(dump.sql.toLowerCase()).toContain('asc');
		});

		it('supports descending order', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const dump = orm.select('users').orderBy('name', 'desc').dump();

			expect(dump.sql.toLowerCase()).toContain('desc');
		});

		it('supports chaining multiple orderBy calls', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
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
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const results = (await orm
				.select('users')
				.orderBy('name', 'asc')
				.all()) as { name: string }[];

			// Alice should come before Bob alphabetically
			expect(results[0].name).toBe('Alice');
			expect(results[1].name).toBe('Bob');
		});

		it('returns results in descending order', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const results = (await orm
				.select('users')
				.orderBy('name', 'desc')
				.all()) as { name: string }[];

			// Bob should come before Alice in descending order
			expect(results[0].name).toBe('Bob');
			expect(results[1].name).toBe('Alice');
		});

		// DX-024: Object form tests
		it('supports object form with multiple fields', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const dump = orm
				.select('users')
				.orderBy({ name: 'asc', id: 'desc' })
				.dump();

			// Both fields should be in ORDER BY
			expect(dump.sql.toLowerCase()).toContain('order by');
			expect(dump.sql.toLowerCase()).toContain('name');
			expect(dump.sql.toLowerCase()).toContain('id');
			expect(dump.sql.toLowerCase()).toContain('asc');
			expect(dump.sql.toLowerCase()).toContain('desc');
		});

		it('object form produces correct ordering', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const results = (await orm
				.select('users')
				.orderBy({ name: 'desc' })
				.all()) as { name: string }[];

			// Bob should come before Alice in descending order
			expect(results[0].name).toBe('Bob');
			expect(results[1].name).toBe('Alice');
		});

		// DX-024: Array form tests
		it('supports array form with OrderBySpec', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const dump = orm
				.select('users')
				.orderBy([{ column: 'name', direction: 'desc' }])
				.dump();

			expect(dump.sql.toLowerCase()).toContain('order by');
			expect(dump.sql.toLowerCase()).toContain('name');
			expect(dump.sql.toLowerCase()).toContain('desc');
		});

		it('array form supports nulls option in intent', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const dump = orm
				.select('users')
				.orderBy([{ column: 'name', direction: 'asc', nulls: 'last' }])
				.dump();

			// Verify the intent includes nulls (compiler support is separate)
			expect(dump.sql.toLowerCase()).toContain('order by');
			expect(dump.plan.intent.orderBy).toBeDefined();
			expect(dump.plan.intent.orderBy?.[0]?.nulls).toBe('last');
		});

		it('array form with multiple specs', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const dump = orm
				.select('users')
				.orderBy([
					{ column: 'name', direction: 'asc' },
					{ column: 'id', direction: 'desc', nulls: 'first' },
				])
				.dump();

			expect(dump.sql.toLowerCase()).toContain('order by');
			expect(dump.sql.toLowerCase()).toContain('name');
			expect(dump.sql.toLowerCase()).toContain('id');
		});

		it('array form produces correct ordering', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const results = (await orm
				.select('users')
				.orderBy([{ column: 'name', direction: 'desc' }])
				.all()) as { name: string }[];

			// Bob should come before Alice in descending order
			expect(results[0].name).toBe('Bob');
			expect(results[1].name).toBe('Alice');
		});
	});

	describe('limit()', () => {
		it('generates LIMIT clause in SQL', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const dump = orm.select('users').limit(10).dump();

			expect(dump.sql.toLowerCase()).toContain('limit');
		});

		it('limits the number of results', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const results = await orm.select('users').limit(1).all();

			expect(results).toHaveLength(1);
		});

		it('returns all results when limit exceeds count', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const results = await orm.select('users').limit(100).all();

			expect(results).toHaveLength(2); // Only 2 users in test data
		});
	});

	describe('offset()', () => {
		it('generates OFFSET clause in SQL', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const dump = orm.select('users').offset(5).dump();

			expect(dump.sql.toLowerCase()).toContain('offset');
		});

		it('skips the specified number of results', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
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
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			// Note: SQLite requires LIMIT when using OFFSET
			const results = await orm.select('users').limit(100).offset(100).all();

			expect(results).toHaveLength(0);
		});
	});

	describe('pagination (limit + offset)', () => {
		it('supports pagination with limit and offset', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
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
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
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
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
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

	describe('include() with hydration (DX-033)', () => {
		// These tests use SEPARATE strategy to test multi-query hydration
		// JOIN is now the default, but SEPARATE is still supported via defaultIncludeStrategy
		it('hydrates hasMany relation with separate query', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
				defaultIncludeStrategy: 'separate', // Use SEPARATE for multi-query hydration test
			});
			const results = (await orm
				.select('users')
				.include('posts')
				.orderBy('id')
				.all()) as Array<{
				id: number;
				name: string;
				posts?: Array<{ id: number; title: string }>;
			}>;

			expect(results).toHaveLength(2);

			// Alice (id=1) has 2 posts
			expect(results[0].name).toBe('Alice');
			expect(results[0].posts).toBeDefined();
			expect(results[0].posts).toHaveLength(2);
			expect(results[0].posts?.[0].title).toBe('First Post');
			expect(results[0].posts?.[1].title).toBe('Second Post');

			// Bob (id=2) has 0 posts
			expect(results[1].name).toBe('Bob');
			expect(results[1].posts).toBeDefined();
			expect(results[1].posts).toHaveLength(0);
		});

		it('returns empty array for parent with no children', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
				defaultIncludeStrategy: 'separate', // Use SEPARATE for multi-query hydration test
			});
			const results = (await orm
				.select('users')
				.where(eq('id', 2)) // Bob has no posts
				.include('posts')
				.all()) as Array<{
				id: number;
				name: string;
				posts?: Array<{ id: number; title: string }>;
			}>;

			expect(results).toHaveLength(1);
			expect(results[0].name).toBe('Bob');
			expect(results[0].posts).toBeDefined();
			expect(results[0].posts).toHaveLength(0);
		});

		it('handles empty parent results gracefully', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const results = (await orm
				.select('users')
				.where(eq('id', 999)) // Non-existent user
				.include('posts')
				.all()) as Array<{
				id: number;
				posts?: Array<{ id: number }>;
			}>;

			expect(results).toHaveLength(0);
		});

		it('works with first() returning single hydrated result', async () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
				defaultIncludeStrategy: 'separate', // Use SEPARATE for multi-query hydration test
			});
			const result = (await orm
				.select('users')
				.where(eq('id', 1))
				.include('posts')
				.first()) as
				| {
						id: number;
						name: string;
						posts?: Array<{ id: number; title: string }>;
				  }
				| undefined;

			expect(result).toBeDefined();
			expect(result?.name).toBe('Alice');
			expect(result?.posts).toBeDefined();
			expect(result?.posts).toHaveLength(2);
		});

		it('groups children correctly by foreign key', async () => {
			// Add a third user with posts to test grouping
			const testDb = createTestDb();
			await setupDatabase(testDb);

			// Seed with more data for grouping test
			await testDb
				.insertInto('users')
				.values([
					{ id: 1, name: 'Alice', email: 'alice@example.com' },
					{ id: 2, name: 'Bob', email: 'bob@example.com' },
					{ id: 3, name: 'Charlie', email: 'charlie@example.com' },
				])
				.execute();

			await testDb
				.insertInto('posts')
				.values([
					{ id: 1, title: 'Alice Post 1', userId: 1 },
					{ id: 2, title: 'Alice Post 2', userId: 1 },
					{ id: 3, title: 'Charlie Post 1', userId: 3 },
					{ id: 4, title: 'Charlie Post 2', userId: 3 },
					{ id: 5, title: 'Charlie Post 3', userId: 3 },
				])
				.execute();

			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(testDb),
				defaultIncludeStrategy: 'separate', // Use SEPARATE for multi-query hydration test
			});

			const results = (await orm
				.select('users')
				.include('posts')
				.orderBy('id')
				.all()) as Array<{
				id: number;
				name: string;
				posts?: Array<{ id: number; title: string }>;
			}>;

			expect(results).toHaveLength(3);

			// Alice has 2 posts
			expect(results[0].posts).toHaveLength(2);
			expect(results[0].posts?.every((p) => p.title.startsWith('Alice'))).toBe(
				true,
			);

			// Bob has 0 posts
			expect(results[1].posts).toHaveLength(0);

			// Charlie has 3 posts
			expect(results[2].posts).toHaveLength(3);
			expect(
				results[2].posts?.every((p) => p.title.startsWith('Charlie')),
			).toBe(true);

			await testDb.destroy();
		});

		it('include does not affect query without execution', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});

			// Just building the query should not throw
			const builder = orm.select('users').include('posts');

			// Plan should be valid
			const plan = builder.plan();
			expect(plan).toBeDefined();
			expect(plan.intent.from).toBe('users');
		});
	});
});
