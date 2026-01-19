/**
 * DDL Generation Tests
 *
 * Tests that DDL generation respects Kysely plugins (like CamelCasePlugin)
 * for column naming transformations.
 */

import { defineSchema, type ModelIR } from '@dbsp/core';
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
	return defineSchema({
		users: {
			id: { type: 'number' },
			firstName: { type: 'string' },
			lastName: { type: 'string' },
			emailAddress: { type: 'string' },
			createdAt: { type: 'datetime' },
		},
		posts: {
			id: { type: 'number' },
			postTitle: { type: 'string' },
			postContent: { type: 'string' },
			authorId: { type: 'number' },
			publishedAt: { type: 'datetime' },
		},
	}).build();
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
			const schema = defineSchema({
				userProfiles: {
					id: { type: 'number' },
					profileName: { type: 'string' },
				},
			}).build();

			const ddl = generateDDL(db, schema);
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

			// Should include DROP statements
			expect(ddl.some((s) => s.includes('DROP TABLE IF EXISTS'))).toBe(true);
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
			const schema = defineSchema({
				users: {
					id: { type: 'integer', primaryKey: true },
					email: { type: 'string', unique: true },
				},
			}).build();

			const ddl = generateDDL(db, schema);
			const createUser = ddl.find((s) => s.includes('create table "users"'));

			expect(createUser).toContain('unique');
		});

		it('generates onDelete CASCADE on foreign key', () => {
			const schema = defineSchema({
				users: {
					id: { type: 'integer', primaryKey: true },
				},
				posts: {
					id: { type: 'integer', primaryKey: true },
					userId: {
						type: 'integer',
						references: { table: 'users', onDelete: 'CASCADE' },
					},
				},
			}).build();

			const ddl = generateDDL(db, schema);
			const fkStatement = ddl.find((s) => s.includes('foreign key'));

			expect(fkStatement).toContain('on delete cascade');
		});

		it('generates CREATE INDEX statement', () => {
			const schema = defineSchema({
				users: {
					id: { type: 'integer', primaryKey: true },
					email: { type: 'string', index: true },
				},
			}).build();

			const ddl = generateDDL(db, schema);
			const indexStatement = ddl.find((s) => s.includes('create index'));

			expect(indexStatement).toContain('idx_users_email');
			expect(indexStatement).toContain('"email"');
		});

		it('generates unique index', () => {
			// Use TableDefWithConfig syntax for schema-builder.ts
			const schema = defineSchema({
				users: {
					columns: {
						id: { type: 'integer', primaryKey: true },
						email: { type: 'string' },
						tenantId: { type: 'string' },
					},
					indexes: [
						{
							columns: ['email', 'tenantId'],
							unique: true,
							name: 'uk_users_email_tenant',
						},
					],
				},
			}).build();

			const ddl = generateDDL(db, schema);
			const indexStatement = ddl.find((s) =>
				s.includes('uk_users_email_tenant'),
			);

			expect(indexStatement).toContain('create unique index');
		});
	});
});
