import type { Adapter } from '@db-semantic-planner/core';
import { createOrm, defineSchema } from '@db-semantic-planner/core';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKyselyAdapter } from './kysely-adapter.js';

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

describe('Zero-Config ORM (with adapter)', () => {
	let db: Kysely<TestDatabase>;
	let adapter: Adapter<TestDatabase>;

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

		// Create adapter
		adapter = createKyselyAdapter(db);
	});

	afterAll(async () => {
		await db.destroy();
	});

	// NOTE: Async introspection tests are PostgreSQL-only (uses information_schema)
	// See tests/e2e/introspection.e2e.test.ts for PostgreSQL introspection tests

	describe.skip('createOrm({ adapter }) - async path (auto-introspection)', () => {
		// These tests require PostgreSQL - skipped for SQLite unit tests
		it('returns a Promise when model is not provided', () => {
			const result = createOrm({ adapter });
			expect(result).toBeInstanceOf(Promise);
		});

		it('resolves to an OrmInstance after introspection', async () => {
			const orm = await createOrm({ adapter });

			expect(orm).toBeDefined();
			expect(orm.select).toBeDefined();
			expect(orm.forTenant).toBeDefined();
			expect(typeof orm.strictMode).toBe('boolean');
		});
	});

	describe('createOrm({ model, adapter }) - sync path', () => {
		const explicitModel = defineSchema({
			users: {
				id: 'number',
				name: 'string',
			},
		}).build();

		it('returns OrmInstance synchronously when model is provided', () => {
			const orm = createOrm({ model: explicitModel, adapter });

			// Should NOT be a Promise
			expect(orm).not.toBeInstanceOf(Promise);
			expect(orm.select).toBeDefined();
		});

		it('uses provided model instead of introspecting', () => {
			const orm = createOrm({ model: explicitModel, adapter });
			const dump = orm.select('users').dump();

			// Should work with the explicit model
			expect(dump.sql).toContain('users');
		});
	});

	describe('error handling', () => {
		it('throws when neither model nor adapter is provided', () => {
			// @ts-expect-error - Testing invalid usage
			expect(() => createOrm({})).toThrow(
				'Either model or adapter must be provided',
			);
		});
	});
});
