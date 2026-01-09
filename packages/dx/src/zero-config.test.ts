import { defineSchema } from '@db-semantic-planner/core';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrm } from './orm.js';

// Mock the introspect function
vi.mock('@db-semantic-planner/adapter-kysely', async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import('@db-semantic-planner/adapter-kysely')
		>();
	return {
		...original,
		introspect: vi.fn().mockResolvedValue(
			defineSchema({
				users: {
					id: 'number',
					name: 'string',
					email: 'string',
				},
				posts: {
					id: 'number',
					title: 'string',
					user_id: 'number',
				},
			}).build(),
		),
	};
});

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
		user_id: number;
	};
}

describe('Zero-Config ORM (auto-introspection)', () => {
	let db: Kysely<TestDatabase>;

	beforeAll(async () => {
		db = new Kysely<TestDatabase>({
			dialect: new SqliteDialect({
				database: new Database(':memory:'),
			}),
		});

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
			.addColumn('user_id', 'integer', (col) => col.notNull())
			.execute();

		// Seed data
		await db
			.insertInto('users')
			.values([
				{ id: 1, name: 'Alice', email: 'alice@test.com' },
				{ id: 2, name: 'Bob', email: 'bob@test.com' },
			])
			.execute();

		await db
			.insertInto('posts')
			.values([
				{ id: 1, title: 'First Post', user_id: 1 },
				{ id: 2, title: 'Second Post', user_id: 1 },
			])
			.execute();
	});

	afterAll(async () => {
		await db.destroy();
	});

	describe('createOrm({ db }) - async path', () => {
		it('returns a Promise when model is not provided', () => {
			const result = createOrm({ db });
			expect(result).toBeInstanceOf(Promise);
		});

		it('resolves to an OrmInstance after introspection', async () => {
			const orm = await createOrm({ db });

			expect(orm).toBeDefined();
			expect(orm.query).toBeDefined();
			expect(orm.forTenant).toBeDefined();
			expect(typeof orm.strictMode).toBe('boolean');
		});

		it('can query tables discovered via introspection', async () => {
			const orm = await createOrm({ db });
			const users = await orm.query('users').findMany();

			expect(users).toHaveLength(2);
			expect(users[0]).toHaveProperty('name');
		});

		it('can use where clause on introspected schema', async () => {
			const orm = await createOrm({ db });
			const users = await orm
				.query('users')
				.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
				.findMany();

			expect(users).toHaveLength(1);
			expect((users[0] as { name: string }).name).toBe('Alice');
		});

		it('can use select on introspected schema', async () => {
			const orm = await createOrm({ db });
			const users = await orm.query('users').select(['name']).findMany();

			expect(users).toHaveLength(2);
			// Should only have name field selected
			expect(users[0]).toHaveProperty('name');
		});

		it('passes strictMode option through', async () => {
			const orm = await createOrm({ db, strictMode: true });
			expect(orm.strictMode).toBe(true);
		});

		it('passes relationHints option through', async () => {
			const orm = await createOrm({
				db,
				relationHints: { posts: 'authoredPosts' },
			});
			// ORM should be created successfully with hints
			expect(orm).toBeDefined();
		});

		it('supports forTenant on introspected ORM', async () => {
			const orm = await createOrm({ db });
			const tenantOrm = orm.forTenant('acme');

			expect(tenantOrm).toBeDefined();
			const dump = tenantOrm.query('users').dump();
			expect(dump.meta?.tenant).toBe('acme');
		});
	});

	describe('createOrm({ model, db }) - sync path', () => {
		const explicitModel = defineSchema({
			users: {
				id: 'number',
				name: 'string',
			},
		}).build();

		it('returns OrmInstance synchronously when model is provided', () => {
			const orm = createOrm({ model: explicitModel, db });

			// Should NOT be a Promise
			expect(orm).not.toBeInstanceOf(Promise);
			expect(orm.query).toBeDefined();
		});

		it('uses provided model instead of introspecting', () => {
			const orm = createOrm({ model: explicitModel, db });
			const dump = orm.query('users').dump();

			// Should work with the explicit model
			expect(dump.sql).toContain('users');
		});
	});

	describe('error handling', () => {
		it('throws when neither model nor db is provided', () => {
			// @ts-expect-error - Testing invalid usage
			expect(() => createOrm({})).toThrow(
				'Either model or db must be provided',
			);
		});
	});
});
