/**
 * @module mutation-builders.test
 * Unit tests for DX-010: Mutation Builders (InsertBuilder, UpdateBuilder, DeleteBuilder)
 */

import {
	and,
	belongsTo,
	createOrm,
	defineSchema,
	eq,
	hasMany,
	inArray,
	UpsertBuilder,
} from '@dbsp/core';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	ExecutionError,
	InvalidOperationError,
	UnsafeOperationError,
} from './errors.js';
import { createKyselyAdapter } from './kysely-adapter.js';

// Test schema
const testModel = defineSchema({
	users: {
		id: 'integer',
		name: { type: 'string' },
		email: { type: 'string' },
		active: { type: 'boolean' },
	},
	posts: {
		id: 'integer',
		title: { type: 'string' },
		content: { type: 'string' },
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
		active: number; // SQLite boolean
	};
	posts: {
		id: number;
		title: string;
		content: string;
		userId: number;
	};
}

// Create in-memory SQLite database
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
		.addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
		.addColumn('name', 'text', (col) => col.notNull())
		.addColumn('email', 'text', (col) => col.notNull())
		.addColumn('active', 'integer', (col) => col.notNull().defaultTo(1))
		.execute();

	await db.schema
		.createTable('posts')
		.addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
		.addColumn('title', 'text', (col) => col.notNull())
		.addColumn('content', 'text', (col) => col.notNull())
		.addColumn('userId', 'integer', (col) => col.notNull())
		.execute();
}

// Seed initial data
async function seedData(db: Kysely<TestDatabase>): Promise<void> {
	await db
		.insertInto('users')
		.values([
			{ id: 1, name: 'Alice', email: 'alice@example.com', active: 1 },
			{ id: 2, name: 'Bob', email: 'bob@example.com', active: 1 },
			{ id: 3, name: 'Charlie', email: 'charlie@example.com', active: 0 },
		])
		.execute();

	await db
		.insertInto('posts')
		.values([
			{ id: 1, title: 'First Post', content: 'Content 1', userId: 1 },
			{ id: 2, title: 'Second Post', content: 'Content 2', userId: 1 },
			{ id: 3, title: 'Bob Post', content: 'Content 3', userId: 2 },
		])
		.execute();
}

// Clear data between tests
async function clearData(db: Kysely<TestDatabase>): Promise<void> {
	await db.deleteFrom('posts').execute();
	await db.deleteFrom('users').execute();
}

describe('Mutation Builders (DX-010)', () => {
	let db: Kysely<TestDatabase>;

	beforeAll(async () => {
		db = createTestDb();
		await setupDatabase(db);
	});

	beforeEach(async () => {
		await clearData(db);
		await seedData(db);
	});

	afterAll(async () => {
		await db.destroy();
	});

	// =========================================================================
	// InsertBuilder Tests
	// =========================================================================

	describe('InsertBuilder', () => {
		describe('values()', () => {
			it('should accept a single object', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.insert('users')
					.values({ name: 'David', email: 'david@example.com' })
					.dump();

				expect(dump.sql).toContain('insert into');
				expect(dump.sql.toLowerCase()).toContain('users');
				expect(dump.intent.type).toBe('insert');
				expect(dump.intent.values).toHaveLength(1);
			});

			it('should accept an array for bulk insert', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.insert('users')
					.values([
						{ name: 'David', email: 'david@example.com' },
						{ name: 'Eve', email: 'eve@example.com' },
					])
					.dump();

				expect(dump.intent.type).toBe('insert');
				expect(dump.intent.values).toHaveLength(2);
			});

			it('should be immutable - return new builder', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const builder1 = orm.insert('users');
				const builder2 = builder1.values({ name: 'David', email: 'd@e.com' });

				expect(builder1).not.toBe(builder2);
			});
		});

		describe('dump()', () => {
			it('should return MutationDump with sql and parameters', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.insert('users')
					.values({ name: 'David', email: 'david@example.com' })
					.dump();

				expect(dump.sql).toBeDefined();
				expect(dump.parameters).toBeDefined();
				expect(dump.intent).toBeDefined();
				expect(dump.meta?.compiledAt).toBeInstanceOf(Date);
			});

			it('should throw InvalidOperationError if no values provided', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				expect(() => orm.insert('users').dump()).toThrow(InvalidOperationError);
			});

			it('should throw ExecutionError if no db configured', () => {
				const orm = createOrm({ model: testModel });
				expect(() =>
					orm.insert('users').values({ name: 'Test', email: 't@e.com' }).dump(),
				).toThrow(ExecutionError);
			});
		});

		describe('execute()', () => {
			it('should insert a single row', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				await orm
					.insert('users')
					.values({ name: 'David', email: 'david@example.com' })
					.execute();

				// Verify insertion
				const rows = await db.selectFrom('users').selectAll().execute();
				expect(rows).toHaveLength(4); // 3 seeded + 1 new
				expect(rows.some((r) => r.name === 'David')).toBe(true);
			});

			it('should insert multiple rows (bulk insert)', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				await orm
					.insert('users')
					.values([
						{ name: 'David', email: 'david@example.com' },
						{ name: 'Eve', email: 'eve@example.com' },
					])
					.execute();

				const rows = await db.selectFrom('users').selectAll().execute();
				expect(rows).toHaveLength(5); // 3 seeded + 2 new
			});

			it('should throw ExecutionError if no db configured', async () => {
				const orm = createOrm({ model: testModel });
				await expect(
					orm
						.insert('users')
						.values({ name: 'Test', email: 't@e.com' })
						.execute(),
				).rejects.toThrow(ExecutionError);
			});
		});
	});

	// =========================================================================
	// UpdateBuilder Tests
	// =========================================================================

	describe('UpdateBuilder', () => {
		describe('set()', () => {
			it('should set fields to update', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.update('users')
					.set({ active: 0 })
					.where(eq('id', 1))
					.dump();

				expect(dump.sql.toLowerCase()).toContain('update');
				expect(dump.intent.type).toBe('update');
				expect((dump.intent as { set: Record<string, unknown> }).set).toEqual({
					active: 0,
				});
			});

			it('should merge multiple set() calls', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.update('users')
					.set({ name: 'NewName' })
					.set({ email: 'new@example.com' })
					.where(eq('id', 1))
					.dump();

				expect((dump.intent as { set: Record<string, unknown> }).set).toEqual({
					name: 'NewName',
					email: 'new@example.com',
				});
			});
		});

		describe('where()', () => {
			it('should add WHERE condition', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.update('users')
					.set({ active: 0 })
					.where(eq('id', 1))
					.dump();

				expect(dump.sql.toLowerCase()).toContain('where');
			});

			it('should support compound conditions', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.update('users')
					.set({ active: 0 })
					.where(and(eq('name', 'Alice'), eq('active', 1)))
					.dump();

				expect(dump.intent.where).toBeDefined();
			});
		});

		describe('safety guards', () => {
			it('should throw UnsafeOperationError without WHERE clause', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				expect(() => orm.update('users').set({ active: 0 }).dump()).toThrow(
					UnsafeOperationError,
				);
			});

			it('should allow updateAll() without WHERE', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm.updateAll('users').set({ active: 0 }).dump();

				expect(dump.sql).toBeDefined();
				expect(dump.intent.allowAll).toBe(true);
			});
		});

		describe('execute()', () => {
			it('should update matching rows', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				await orm
					.update('users')
					.set({ active: 0 })
					.where(eq('id', 1))
					.execute();

				const user = await db
					.selectFrom('users')
					.selectAll()
					.where('id', '=', 1)
					.executeTakeFirst();
				expect(user?.active).toBe(0);
			});

			it('should update all rows with updateAll()', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				await orm.updateAll('users').set({ active: 0 }).execute();

				const users = await db.selectFrom('users').selectAll().execute();
				expect(users.every((u) => u.active === 0)).toBe(true);
			});

			it('should throw InvalidOperationError if no fields to update', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				expect(() => orm.update('users').where(eq('id', 1)).dump()).toThrow(
					InvalidOperationError,
				);
			});
		});
	});

	// =========================================================================
	// DeleteBuilder Tests
	// =========================================================================

	describe('DeleteBuilder', () => {
		describe('where()', () => {
			it('should add WHERE condition', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm.delete('users').where(eq('id', 1)).dump();

				expect(dump.sql.toLowerCase()).toContain('delete');
				expect(dump.sql.toLowerCase()).toContain('where');
			});

			it('should support IN clause', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.delete('users')
					.where(inArray('id', [1, 2]))
					.dump();

				expect(dump.intent.where).toBeDefined();
			});
		});

		describe('safety guards', () => {
			it('should throw UnsafeOperationError without WHERE clause', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				expect(() => orm.delete('users').dump()).toThrow(UnsafeOperationError);
			});

			it('should allow deleteAll() without WHERE', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm.deleteAll('posts').dump();

				expect(dump.sql).toBeDefined();
				expect(dump.intent.allowAll).toBe(true);
			});
		});

		describe('execute()', () => {
			it('should delete matching rows', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				await orm.delete('users').where(eq('id', 1)).execute();

				const users = await db.selectFrom('users').selectAll().execute();
				expect(users).toHaveLength(2);
				expect(users.some((u) => u.id === 1)).toBe(false);
			});

			it('should delete all rows with deleteAll()', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				await orm.deleteAll('posts').execute();

				const posts = await db.selectFrom('posts').selectAll().execute();
				expect(posts).toHaveLength(0);
			});

			it('should delete multiple rows with IN clause', async () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				await orm
					.delete('users')
					.where(inArray('id', [1, 2]))
					.execute();

				const users = await db.selectFrom('users').selectAll().execute();
				expect(users).toHaveLength(1);
				expect(users[0]?.id).toBe(3);
			});
		});

		describe('cascade() (placeholder)', () => {
			it('should set cascade flag', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const builder = orm.delete('users').where(eq('id', 1)).cascade();
				const dump = builder.dump();

				expect(dump.intent.cascade).toBe(true);
			});

			it('should accept specific relations', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const builder = orm
					.delete('users')
					.where(eq('id', 1))
					.cascade(['posts']);
				const dump = builder.dump();

				expect(dump.intent.cascade).toEqual(['posts']);
			});
		});
	});

	// =========================================================================
	// Multi-tenant Tests
	// =========================================================================

	describe('Multi-tenant Mutations', () => {
		it('should include schema prefix in insert dump', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const scopedOrm = orm.withSchema('tenant_123');
			const dump = scopedOrm
				.insert('users')
				.values({ name: 'Test', email: 't@e.com' })
				.dump();

			// SQLite quotes schema.table as "schema"."table"
			expect(dump.sql.toLowerCase()).toMatch(/tenant_123[".].*users/);
			expect(dump.meta?.schema).toBe('tenant_123');
		});

		it('should include schema prefix in update dump', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const scopedOrm = orm.withSchema('tenant_abc');
			const dump = scopedOrm
				.update('users')
				.set({ active: 0 })
				.where(eq('id', 1))
				.dump();

			expect(dump.sql.toLowerCase()).toMatch(/tenant_abc[".].*users/);
			expect(dump.meta?.schema).toBe('tenant_abc');
		});

		it('should include schema prefix in delete dump', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const scopedOrm = orm.withSchema('company_x');
			const dump = scopedOrm.delete('posts').where(eq('id', 1)).dump();

			expect(dump.sql.toLowerCase()).toMatch(/company_x[".].*posts/);
			expect(dump.meta?.schema).toBe('company_x');
		});
	});

	// =========================================================================
	// OrmInstance Factory Method Tests
	// =========================================================================

	describe('OrmInstance factory methods', () => {
		it('should expose insert() method', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			expect(orm.insert).toBeDefined();
			expect(typeof orm.insert).toBe('function');
		});

		it('should expose update() method', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			expect(orm.update).toBeDefined();
			expect(typeof orm.update).toBe('function');
		});

		it('should expose delete() method', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			expect(orm.delete).toBeDefined();
			expect(typeof orm.delete).toBe('function');
		});

		it('should expose updateAll() method', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			expect(orm.updateAll).toBeDefined();
			expect(typeof orm.updateAll).toBe('function');
		});

		it('should expose deleteAll() method', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			expect(orm.deleteAll).toBeDefined();
			expect(typeof orm.deleteAll).toBe('function');
		});

		it('should expose upsert() method', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			expect(orm.upsert).toBeDefined();
			expect(typeof orm.upsert).toBe('function');
		});
	});

	// =========================================================================
	// UpsertBuilder Tests (DX-026)
	// =========================================================================

	describe('UpsertBuilder (DX-026)', () => {
		describe('values()', () => {
			it('should accept a single object', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.upsert('users')
					.values({ name: 'David', email: 'david@example.com' })
					.onConflict(['email'])
					.doNothing()
					.dump();

				expect(dump.sql.toLowerCase()).toContain('insert into');
				expect(dump.intent.type).toBe('upsert');
				expect(dump.intent.values).toHaveLength(1);
			});

			it('should accept an array for bulk upsert', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.upsert('users')
					.values([
						{ name: 'David', email: 'david@example.com' },
						{ name: 'Eve', email: 'eve@example.com' },
					])
					.onConflict(['email'])
					.doNothing()
					.dump();

				expect(dump.intent.type).toBe('upsert');
				expect(dump.intent.values).toHaveLength(2);
			});

			it('should be immutable - return new builder', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const builder1 = orm.upsert('users');
				const builder2 = builder1.values({ name: 'David', email: 'd@e.com' });

				expect(builder1).not.toBe(builder2);
			});
		});

		describe('onConflict()', () => {
			it('should set conflict columns', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.upsert('users')
					.values({ name: 'David', email: 'david@example.com' })
					.onConflict(['email'])
					.doNothing()
					.dump();

				expect(dump.sql.toLowerCase()).toContain('on conflict');
				expect(dump.intent.onConflict).toHaveProperty('columns');
			});

			it('should support multiple conflict columns', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.upsert('posts')
					.values({ title: 'Post', content: 'Content', userId: 1 })
					.onConflict(['title', 'userId'])
					.doNothing()
					.dump();

				expect(dump.intent.onConflict).toEqual({
					columns: ['title', 'userId'],
				});
			});
		});

		describe('onConflictConstraint()', () => {
			it('should set constraint name', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.upsert('users')
					.values({ name: 'David', email: 'david@example.com' })
					.onConflictConstraint('users_email_unique')
					.doNothing()
					.dump();

				expect(dump.intent.onConflict).toEqual({
					constraint: 'users_email_unique',
				});
			});
		});

		describe('doNothing()', () => {
			it('should set DO NOTHING action', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.upsert('users')
					.values({ name: 'David', email: 'david@example.com' })
					.onConflict(['email'])
					.doNothing()
					.dump();

				expect(dump.sql.toLowerCase()).toContain('do nothing');
				expect(dump.intent.action).toEqual({ type: 'doNothing' });
			});
		});

		describe('doUpdate()', () => {
			it('should set DO UPDATE action with explicit SET', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.upsert('users')
					.values({ name: 'David', email: 'david@example.com' })
					.onConflict(['email'])
					.doUpdate({ name: 'Updated David' })
					.dump();

				expect(dump.sql.toLowerCase()).toContain('do update');
				expect(dump.intent.action).toMatchObject({
					type: 'doUpdate',
					set: { name: 'Updated David' },
				});
			});

			it('should set DO UPDATE action with auto-update from excluded', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.upsert('users')
					.values({ name: 'David', email: 'david@example.com' })
					.onConflict(['email'])
					.doUpdate()
					.dump();

				expect(dump.sql.toLowerCase()).toContain('do update');
				expect(dump.sql.toLowerCase()).toContain('excluded');
			});

			it('should support WHERE clause in doUpdate', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.upsert('users')
					.values({ name: 'David', email: 'david@example.com', active: 1 })
					.onConflict(['email'])
					.doUpdate({ name: 'Updated' }, eq('active', 1))
					.dump();

				expect(dump.sql.toLowerCase()).toContain('where');
				expect(dump.intent.action).toMatchObject({
					type: 'doUpdate',
					where: expect.anything(),
				});
			});
		});

		describe('dump()', () => {
			it('should return MutationDump with sql and parameters', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.upsert('users')
					.values({ name: 'David', email: 'david@example.com' })
					.onConflict(['email'])
					.doNothing()
					.dump();

				expect(dump.sql).toBeDefined();
				expect(dump.parameters).toBeDefined();
				expect(dump.intent).toBeDefined();
				expect(dump.meta?.compiledAt).toBeInstanceOf(Date);
			});

			it('should throw InvalidOperationError if no values provided', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				expect(() =>
					orm.upsert('users').onConflict(['email']).doNothing().dump(),
				).toThrow(InvalidOperationError);
			});

			it('should throw InvalidOperationError if no conflict target', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				expect(() =>
					orm.upsert('users').values({ name: 'Test' }).doNothing().dump(),
				).toThrow(InvalidOperationError);
			});

			it('should throw InvalidOperationError if no action specified', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				expect(() =>
					orm
						.upsert('users')
						.values({ name: 'Test' })
						.onConflict(['email'])
						.dump(),
				).toThrow(InvalidOperationError);
			});

			it('should throw ExecutionError if no db configured', () => {
				const orm = createOrm({ model: testModel });
				expect(() =>
					orm
						.upsert('users')
						.values({ name: 'Test', email: 't@e.com' })
						.onConflict(['email'])
						.doNothing()
						.dump(),
				).toThrow(ExecutionError);
			});
		});

		describe('returning()', () => {
			it('should add RETURNING clause to upsert', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.upsert('users')
					.values({ name: 'David', email: 'david@example.com' })
					.onConflict(['email'])
					.doNothing()
					.returning(['id', 'name'])
					.dump();

				expect(dump.sql.toLowerCase()).toContain('returning');
				expect(dump.intent.returning).toEqual(['id', 'name']);
			});

			it('should be chainable', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const builder = orm
					.upsert('users')
					.values({ name: 'David', email: 'david@example.com' })
					.onConflict(['email'])
					.doNothing()
					.returning(['id']);

				expect(builder).toBeInstanceOf(UpsertBuilder);
			});
		});
	});

	// =========================================================================
	// Returning Support Tests (DX-026)
	// =========================================================================

	describe('Returning Support (DX-026)', () => {
		describe('InsertBuilder.returning()', () => {
			it('should add RETURNING clause to insert', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.insert('users')
					.values({ name: 'David', email: 'david@example.com' })
					.returning(['id', 'name'])
					.dump();

				expect(dump.sql.toLowerCase()).toContain('returning');
				expect(dump.intent.returning).toEqual(['id', 'name']);
			});

			it('should be immutable - return new builder', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const builder1 = orm
					.insert('users')
					.values({ name: 'David', email: 'david@example.com' });
				const builder2 = builder1.returning(['id']);

				expect(builder1).not.toBe(builder2);
			});
		});

		describe('UpdateBuilder.returning()', () => {
			it('should add RETURNING clause to update', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.update('users')
					.set({ name: 'Updated' })
					.where(eq('id', 1))
					.returning(['id', 'name', 'email'])
					.dump();

				expect(dump.sql.toLowerCase()).toContain('returning');
				expect(dump.intent.returning).toEqual(['id', 'name', 'email']);
			});

			it('should be immutable - return new builder', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const builder1 = orm
					.update('users')
					.set({ name: 'Updated' })
					.where(eq('id', 1));
				const builder2 = builder1.returning(['id']);

				expect(builder1).not.toBe(builder2);
			});
		});

		describe('DeleteBuilder.returning()', () => {
			it('should add RETURNING clause to delete', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const dump = orm
					.delete('users')
					.where(eq('id', 1))
					.returning(['id', 'name'])
					.dump();

				expect(dump.sql.toLowerCase()).toContain('returning');
				expect(dump.intent.returning).toEqual(['id', 'name']);
			});

			it('should be immutable - return new builder', () => {
				const orm = createOrm({
					model: testModel,
					adapter: createKyselyAdapter(db),
				});
				const builder1 = orm.delete('users').where(eq('id', 1));
				const builder2 = builder1.returning(['id']);

				expect(builder1).not.toBe(builder2);
			});
		});
	});

	// =========================================================================
	// Multi-tenant UpsertBuilder Tests (DX-026)
	// =========================================================================

	describe('Multi-tenant Upsert (DX-026)', () => {
		it('should include schema prefix in upsert dump', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(db),
			});
			const scopedOrm = orm.withSchema('tenant_xyz');
			const dump = scopedOrm
				.upsert('users')
				.values({ name: 'Test', email: 't@e.com' })
				.onConflict(['email'])
				.doNothing()
				.dump();

			expect(dump.sql.toLowerCase()).toMatch(/tenant_xyz[".].*users/);
			expect(dump.meta?.schema).toBe('tenant_xyz');
		});
	});
});
