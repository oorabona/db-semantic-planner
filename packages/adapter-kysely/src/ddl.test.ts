/**
 * DDL Generation Tests
 *
 * Tests that DDL generation respects Kysely plugins (like CamelCasePlugin)
 * for column naming transformations.
 */

import { fk, schema, type ModelIR } from '@dbsp/core';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDDL } from './ddl.js';
import { createKyselyAdapter } from './kysely-adapter.js';

// Simple mock pool for testing (no actual DB connection needed)
const mockPool = new pg.Pool({
	// Invalid connection, but we never actually connect
	connectionString: 'postgresql://user:pass@localhost:5432/test',
});

// Create a simple test schema using ModelIR
function createTestSchema(): ModelIR {
	return schema({
		users: {
			id: { type: 'integer', primaryKey: true },
			firstName: 'string',
			lastName: 'string',
			emailAddress: 'string',
			createdAt: 'timestamp',
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			postTitle: 'string',
			postContent: 'text',
			authorId: fk('users', { as: 'author', inverse: 'posts' }),
			publishedAt: 'timestamp',
		},
	}).model;
}

describe('generateDDL', () => {
	describe('without CamelCasePlugin', () => {
		let db: Kysely<unknown>;

		beforeAll(() => {
			db = new Kysely<unknown>({
				dialect: new PostgresDialect({ pool: mockPool }),
			});
		});

		afterAll(async () => {
			await db.destroy();
		});

		it('generates DDL with camelCase column names (as-is)', () => {
			const schema = createTestSchema();
			const ddl = generateDDL(db, schema);

			// Without CamelCasePlugin, column names should remain camelCase
			expect(ddl.join('\n')).toContain('"firstName"');
			expect(ddl.join('\n')).toContain('"lastName"');
			expect(ddl.join('\n')).toContain('"emailAddress"');
			expect(ddl.join('\n')).toContain('"createdAt"');
			expect(ddl.join('\n')).toContain('"authorId"');
			expect(ddl.join('\n')).toContain('"publishedAt"');
		});

		it('generates proper CREATE TABLE structure', () => {
			const schema = createTestSchema();
			const ddl = generateDDL(db, schema);

			// Should have CREATE TABLE statements
			expect(ddl.some((s) => s.includes('create table "users"'))).toBe(true);
			expect(ddl.some((s) => s.includes('create table "posts"'))).toBe(true);
		});
	});

	describe('with CamelCasePlugin', () => {
		let db: Kysely<unknown>;

		beforeAll(() => {
			db = new Kysely<unknown>({
				dialect: new PostgresDialect({ pool: mockPool }),
				plugins: [new CamelCasePlugin()],
			});
		});

		afterAll(async () => {
			await db.destroy();
		});

		it('transforms camelCase column names to snake_case', () => {
			const schema = createTestSchema();
			const ddl = generateDDL(db, schema);
			const allDdl = ddl.join('\n');

			// With CamelCasePlugin, column names should be snake_case
			expect(allDdl).toContain('"first_name"');
			expect(allDdl).toContain('"last_name"');
			expect(allDdl).toContain('"email_address"');
			expect(allDdl).toContain('"created_at"');
			expect(allDdl).toContain('"author_id"');
			expect(allDdl).toContain('"published_at"');

			// Should NOT contain camelCase versions
			expect(allDdl).not.toContain('"firstName"');
			expect(allDdl).not.toContain('"lastName"');
			expect(allDdl).not.toContain('"emailAddress"');
			expect(allDdl).not.toContain('"createdAt"');
			expect(allDdl).not.toContain('"authorId"');
			expect(allDdl).not.toContain('"publishedAt"');
		});

		it('transforms table names to snake_case', () => {
			// Create schema with multi-word table names
			const testSchema = schema({
				userProfiles: {
					id: { type: 'integer', primaryKey: true },
					profileName: 'string',
				},
			}).model;

			const ddl = generateDDL(db, testSchema);
			const allDdl = ddl.join('\n');

			// Table names should be snake_case
			expect(allDdl).toContain('"user_profiles"');
			expect(allDdl).not.toContain('"userProfiles"');
		});
	});

	describe('KyselyAdapter.generateDDL', () => {
		let adapter: ReturnType<typeof createKyselyAdapter>;

		beforeAll(() => {
			const db = new Kysely<unknown>({
				dialect: new PostgresDialect({ pool: mockPool }),
				plugins: [new CamelCasePlugin()],
			});
			adapter = createKyselyAdapter(db);
		});

		it('generates DDL through adapter interface', () => {
			const schema = createTestSchema();
			const ddl = adapter.generateDDL(schema);

			// Should generate valid DDL with snake_case (CamelCasePlugin applied)
			expect(ddl.length).toBeGreaterThan(0);
			expect(ddl.join('\n')).toContain('"first_name"');
		});

		it('respects includeDropStatements option', () => {
			const schema = createTestSchema();
			const ddl = adapter.generateDDL(schema, { includeDropStatements: true });

			// Should include DROP TABLE ... CASCADE statements
			// CASCADE automatically handles dependent objects (FK constraints, indexes)
			const allDdl = ddl.join('\n').toLowerCase();
			expect(allDdl).toContain('drop table if exists');
			expect(allDdl).toContain('cascade');
		});
	});

	describe('DDL features', () => {
		let db: Kysely<unknown>;

		beforeAll(() => {
			db = new Kysely<unknown>({
				dialect: new PostgresDialect({ pool: mockPool }),
			});
		});

		afterAll(async () => {
			await db.destroy();
		});

		it('generates UNIQUE constraint on column', () => {
			const testSchema = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					email: { type: 'string', unique: true },
				},
			}).model;

			const ddl = generateDDL(db, testSchema);
			const createUser = ddl.find((s) => s.includes('create table "users"'));

			expect(createUser).toContain('unique');
		});

		it.skip('generates autoIncrement column (SERIAL in PostgreSQL)', () => {
			// TODO: autoIncrement not supported in schema() API
			const testSchema = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
				},
			}).model;

			const ddl = generateDDL(db, testSchema);
			const createUser = ddl.find((s) => s.includes('create table "users"'));

			// Kysely generates SERIAL for PostgreSQL when autoIncrement is set
			expect(createUser).toContain('serial');
		});

		it.skip('generates onDelete CASCADE on foreign key', () => {
			// TODO: onDelete not fully supported in schema() API - needs investigation
			const testSchema = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
				},
				posts: {
					id: { type: 'integer', primaryKey: true },
					userId: fk('users', { as: 'user', inverse: 'posts' }),
				},
			}).model;

			const ddl = generateDDL(db, testSchema);
			const fkStatement = ddl.find((s) => s.includes('foreign key'));

			expect(fkStatement).toContain('on delete cascade');
		});

		it.skip('generates CREATE INDEX statement', () => {
			// TODO: column-level index: true not generating CREATE INDEX in schema() API
			const testSchema = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					email: { type: 'string', index: true },
				},
			}).model;

			const ddl = generateDDL(db, testSchema);
			const indexStatement = ddl.find((s) => s.includes('create index'));

			expect(indexStatement).toContain('idx_users_email');
			expect(indexStatement).toContain('"email"');
		});

		it.skip('generates unique index', () => {
			// TODO: indexes config in schema() options needs investigation
			const testSchema = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					email: 'string',
					tenantId: 'string',
				},
			}).model;

			const ddl = generateDDL(db, testSchema);
			const indexStatement = ddl.find((s) =>
				s.includes('uk_users_email_tenant'),
			);

			expect(indexStatement).toContain('create unique index');
		});
	});

	describe('Sequence management', () => {
		let db: Kysely<unknown>;

		beforeAll(() => {
			db = new Kysely<unknown>({
				dialect: new PostgresDialect({ pool: mockPool }),
			});
		});

		afterAll(async () => {
			await db.destroy();
		});

		it.skip('generates sequence reset statements for tables with autoIncrement', async () => {
			// TODO: autoIncrement not supported in schema() API - needs ModelIR direct construction
			// Import dynamically to test the new functions
			const { generateSequenceResetStatements } = await import('./ddl.js');

			const testSchema = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
				},
				posts: {
					id: { type: 'integer', primaryKey: true },
					title: 'string',
				},
			}).model;

			const statements = generateSequenceResetStatements(db, testSchema);

			expect(statements).toHaveLength(2);
			expect(statements[0]).toContain('setval');
			expect(statements[0]).toContain('users_id_seq');
			expect(statements[1]).toContain('posts_id_seq');
		});

		it('generates setval statement with explicit value', async () => {
			const { generateSetvalStatement } = await import('./ddl.js');

			const stmt = generateSetvalStatement(db, 'users', 'id', 100);

			expect(stmt).toContain('setval');
			expect(stmt).toContain('users_id_seq');
			expect(stmt).toContain('100');
			expect(stmt).toContain('false'); // is_called = false so next value is 100
		});

		it('skips tables without autoIncrement columns', async () => {
			const { generateSequenceResetStatements } = await import('./ddl.js');

			const testSchema = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					name: 'string',
				},
			}).model;

			const statements = generateSequenceResetStatements(db, testSchema);

			expect(statements).toHaveLength(0);
		});

		it.skip('supports schema-qualified sequence names', async () => {
			// TODO: autoIncrement not supported in schema() API - needs ModelIR direct construction
			const { generateSequenceResetStatements } = await import('./ddl.js');

			const testSchema = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
				},
			}).model;

			const statements = generateSequenceResetStatements(db, testSchema, {
				schemaName: 'tenant_123',
			});

			expect(statements).toHaveLength(1);
			expect(statements[0]).toContain('"tenant_123"."users_id_seq"');
			expect(statements[0]).toContain('"tenant_123"."users"');
		});
	});
});
