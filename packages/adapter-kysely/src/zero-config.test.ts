import type { Adapter } from '@dbsp/core';
import { createOrm, schema } from '@dbsp/core';
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

	// NOTE: Async introspection tests require PostgreSQL
	// See tests/e2e/introspection.test.ts

	describe('createOrm({ schema, adapter }) - ARCH-006 API', () => {
		const testSchema = schema({
			users: {
				id: { type: 'integer', primaryKey: true },
				name: 'string',
			},
		});

		it('returns OrmInstance when schema is provided', () => {
			const orm = createOrm({ schema: testSchema, adapter });

			// Should NOT be a Promise
			expect(orm).not.toBeInstanceOf(Promise);
			expect(orm.select).toBeDefined();
		});

		it('uses provided schema for queries', () => {
			const orm = createOrm({ schema: testSchema, adapter });
			const dump = orm.select('users').dump();

			// Should work with the explicit schema
			expect(dump.sql).toContain('users');
		});
	});

	describe('error handling', () => {
		it('throws when neither schema nor model is provided', () => {
			// Both schema and model are optional in types, but runtime validation requires at least one
			expect(() => createOrm({} as any)).toThrow(
				'Invalid options: must provide either schema (from schema() function) or model (ModelIR)',
			);
		});
	});
});
