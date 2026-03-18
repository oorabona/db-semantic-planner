/**
 * Tests for migration SQL generation from SchemaDiff.
 *
 * Covers:
 * - Topological ordering of statements
 * - SQL generation for each ChangeKind
 * - Schema-qualified identifiers
 * - Destructive change filtering
 */

import { ModelIRImpl } from '@dbsp/core';
import type { ColumnIR, ForeignKeyIR, IndexIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { generateDownSQL, generateMigrationSQL } from './migration-sql.js';
import {
	compareSchemata,
	type SchemaChange,
	type SchemaDiff,
} from './schema-diff.js';

// ============================================================================
// Test helpers
// ============================================================================

function makeDiff(changes: SchemaChange[]): SchemaDiff {
	return {
		changes,
		hasDestructive: changes.some((c) => c.destructive),
		summary: {
			tables: { added: 0, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 0, dropped: 0 },
			constraints: { added: 0, dropped: 0, altered: 0 },
		},
	};
}

function makeCol(overrides: Partial<ColumnIR> & { name: string }): ColumnIR {
	return {
		type: 'string',
		nullable: false,
		...overrides,
	};
}

function makeTable(
	name: string,
	columns: ColumnIR[],
	pk?: string | string[],
): TableIR {
	return {
		name,
		columns,
		...(pk !== undefined ? { primaryKey: pk } : {}),
		foreignKeys: [],
		indexes: [],
	};
}

// ============================================================================
// Tests
// ============================================================================

describe('generateMigrationSQL', () => {
	describe('CREATE TABLE', () => {
		it('should generate CREATE TABLE with columns and PK', () => {
			const table = makeTable(
				'users',
				[
					makeCol({ name: 'id', type: 'integer', autoIncrement: true }),
					makeCol({ name: 'name', type: 'string' }),
					makeCol({ name: 'email', type: 'string', unique: true }),
				],
				'id',
			);

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_table',
						table: 'users',
						destructive: false,
						details: '',
						meta: { table },
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain('CREATE TABLE "users"');
			expect(sql[0]).toContain('"id" SERIAL');
			expect(sql[0]).toContain('"name" VARCHAR(255) NOT NULL');
			expect(sql[0]).toContain('"email" VARCHAR(255) NOT NULL UNIQUE');
			expect(sql[0]).toContain('CONSTRAINT "pk_users" PRIMARY KEY ("id")');
		});

		it('should generate schema-qualified table name', () => {
			const table = makeTable('users', [
				makeCol({ name: 'id', type: 'integer' }),
			]);

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_table',
						table: 'users',
						destructive: false,
						details: '',
						meta: { table },
					},
				]),
				{ schemaName: 'tenant_1' },
			);

			expect(sql[0]).toContain('"tenant_1"."users"');
		});
	});

	describe('DROP TABLE', () => {
		it('should generate DROP TABLE with CASCADE', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'drop_table',
						table: 'old_table',
						destructive: true,
						details: '',
					},
				]),
			);

			expect(sql).toEqual(['DROP TABLE IF EXISTS "old_table" CASCADE;']);
		});
	});

	describe('ADD COLUMN', () => {
		it('should generate ADD COLUMN with type, NOT NULL, default, unique', () => {
			const col = makeCol({
				name: 'status',
				type: 'string',
				nullable: false,
				default: 'active',
				unique: true,
			});

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_column',
						table: 'users',
						column: 'status',
						destructive: false,
						details: '',
						meta: { column: col },
					},
				]),
			);

			expect(sql[0]).toBe(
				`ALTER TABLE "users" ADD COLUMN "status" VARCHAR(255) NOT NULL DEFAULT 'active' UNIQUE;`,
			);
		});

		it('should handle nullable columns without NOT NULL', () => {
			const col = makeCol({
				name: 'bio',
				type: 'text',
				nullable: true,
			});

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_column',
						table: 'users',
						column: 'bio',
						destructive: false,
						details: '',
						meta: { column: col },
					},
				]),
			);

			expect(sql[0]).toBe('ALTER TABLE "users" ADD COLUMN "bio" TEXT;');
		});
	});

	describe('DROP COLUMN', () => {
		it('should generate DROP COLUMN with CASCADE', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'drop_column',
						table: 'users',
						column: 'old_col',
						destructive: true,
						details: '',
					},
				]),
			);

			expect(sql).toEqual([
				'ALTER TABLE "users" DROP COLUMN "old_col" CASCADE;',
			]);
		});
	});

	describe('ALTER COLUMN', () => {
		it('should generate ALTER COLUMN TYPE', () => {
			const col = makeCol({ name: 'age', type: 'bigint' });

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'alter_column_type',
						table: 'users',
						column: 'age',
						destructive: true,
						details: '',
						meta: { fromType: 'integer', toType: 'bigint', column: col },
					},
				]),
			);

			expect(sql[0]).toBe(
				'ALTER TABLE "users" ALTER COLUMN "age" TYPE BIGINT;',
			);
		});

		it('should generate SET NOT NULL', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'alter_column_nullable',
						table: 'users',
						column: 'name',
						destructive: false,
						details: '',
						meta: { nullable: false },
					},
				]),
			);

			expect(sql[0]).toBe(
				'ALTER TABLE "users" ALTER COLUMN "name" SET NOT NULL;',
			);
		});

		it('should generate DROP NOT NULL', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'alter_column_nullable',
						table: 'users',
						column: 'name',
						destructive: false,
						details: '',
						meta: { nullable: true },
					},
				]),
			);

			expect(sql[0]).toBe(
				'ALTER TABLE "users" ALTER COLUMN "name" DROP NOT NULL;',
			);
		});

		it('should generate SET DEFAULT', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'alter_column_default',
						table: 'users',
						column: 'role',
						destructive: false,
						details: '',
						meta: { default: 'user' },
					},
				]),
			);

			expect(sql[0]).toBe(
				`ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'user';`,
			);
		});

		it('should generate DROP DEFAULT', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'alter_column_default',
						table: 'users',
						column: 'role',
						destructive: false,
						details: '',
						meta: { default: undefined },
					},
				]),
			);

			expect(sql[0]).toBe(
				'ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;',
			);
		});

		it('should handle SQL expression defaults', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'alter_column_default',
						table: 'users',
						column: 'created_at',
						destructive: false,
						details: '',
						meta: { default: { sql: 'now()' } },
					},
				]),
			);

			expect(sql[0]).toBe(
				'ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT now();',
			);
		});
	});

	describe('PRIMARY KEY', () => {
		it('should generate ADD PRIMARY KEY', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_primary_key',
						table: 'users',
						destructive: false,
						details: '',
						meta: { columns: ['id'] },
					},
				]),
			);

			expect(sql[0]).toBe(
				'ALTER TABLE "users" ADD CONSTRAINT "pk_users" PRIMARY KEY ("id");',
			);
		});

		it('should generate DROP PRIMARY KEY', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'drop_primary_key',
						table: 'users',
						destructive: true,
						details: '',
					},
				]),
			);

			expect(sql[0]).toBe(
				'ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "pk_users" CASCADE;',
			);
		});
	});

	describe('FOREIGN KEY', () => {
		it('should generate ADD FOREIGN KEY with ON DELETE', () => {
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				onDelete: 'CASCADE',
			};

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_foreign_key',
						table: 'posts',
						destructive: false,
						details: '',
						meta: { fk },
					},
				]),
			);

			expect(sql[0]).toBe(
				'ALTER TABLE "posts" ADD CONSTRAINT "fk_posts_user_id" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE;',
			);
		});

		it('should generate DROP FOREIGN KEY', () => {
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
			};

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'drop_foreign_key',
						table: 'posts',
						destructive: true,
						details: '',
						meta: { fk },
					},
				]),
			);

			expect(sql[0]).toBe(
				'ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "fk_posts_user_id";',
			);
		});

		it('should generate ALTER FOREIGN KEY as drop+add', () => {
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				onDelete: 'SET NULL',
			};

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'alter_foreign_key',
						table: 'posts',
						destructive: false,
						details: '',
						meta: { fk, previousOnDelete: 'CASCADE' },
					},
				]),
			);

			expect(sql).toHaveLength(1);
			// Single statement with drop + add (joined by newline)
			expect(sql[0]).toContain('DROP CONSTRAINT IF EXISTS "fk_posts_user_id"');
			expect(sql[0]).toContain('ADD CONSTRAINT "fk_posts_user_id"');
			expect(sql[0]).toContain('ON DELETE SET NULL');
		});
	});

	describe('INDEX', () => {
		it('should generate CREATE INDEX IF NOT EXISTS', () => {
			const idx: IndexIR = {
				name: 'idx_users_email',
				columns: ['email'],
				unique: false,
			};

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_index',
						table: 'users',
						destructive: false,
						details: '',
						meta: { index: idx },
					},
				]),
			);

			expect(sql[0]).toBe(
				'CREATE INDEX IF NOT EXISTS "idx_users_email" ON "users" ("email");',
			);
		});

		it('should generate CREATE UNIQUE INDEX', () => {
			const idx: IndexIR = {
				name: 'idx_users_email_unique',
				columns: ['email'],
				unique: true,
			};

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_index',
						table: 'users',
						destructive: false,
						details: '',
						meta: { index: idx },
					},
				]),
			);

			expect(sql[0]).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
		});

		it('should generate DROP INDEX', () => {
			const idx: IndexIR = {
				name: 'idx_old',
				columns: ['old_col'],
				unique: false,
			};

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'drop_index',
						table: 'users',
						destructive: false,
						details: '',
						meta: { index: idx },
					},
				]),
			);

			expect(sql[0]).toBe('DROP INDEX IF EXISTS "idx_old";');
		});

		it('should generate schema-qualified DROP INDEX', () => {
			const idx: IndexIR = {
				name: 'idx_old',
				columns: ['old_col'],
				unique: false,
			};

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'drop_index',
						table: 'users',
						destructive: false,
						details: '',
						meta: { index: idx },
					},
				]),
				{ schemaName: 'tenant_1' },
			);

			expect(sql[0]).toBe('DROP INDEX IF EXISTS "tenant_1"."idx_old";');
		});

		describe('Index enhancements', () => {
			it('should generate CREATE INDEX USING gin', () => {
				const idx: IndexIR = {
					name: 'idx_posts_body_gin',
					columns: ['body'],
					method: 'gin',
				};
				const sql = generateMigrationSQL(
					makeDiff([
						{
							kind: 'create_index',
							table: 'posts',
							destructive: false,
							details: '',
							meta: { index: idx },
						},
					]),
				);
				expect(sql[0]).toBe(
					'CREATE INDEX IF NOT EXISTS "idx_posts_body_gin" ON "posts" USING gin ("body");',
				);
			});

			it('should generate CREATE INDEX with WHERE (partial index)', () => {
				const idx: IndexIR = {
					name: 'idx_users_active',
					columns: ['email'],
					where: 'active = true',
				};
				const sql = generateMigrationSQL(
					makeDiff([
						{
							kind: 'create_index',
							table: 'users',
							destructive: false,
							details: '',
							meta: { index: idx },
						},
					]),
				);
				expect(sql[0]).toBe(
					'CREATE INDEX IF NOT EXISTS "idx_users_active" ON "users" ("email") WHERE active = true;',
				);
			});

			it('should generate CREATE INDEX with opclass', () => {
				const idx: IndexIR = {
					name: 'idx_posts_title_trgm',
					columns: ['title'],
					method: 'gin',
					opclass: { title: 'gin_trgm_ops' },
				};
				const sql = generateMigrationSQL(
					makeDiff([
						{
							kind: 'create_index',
							table: 'posts',
							destructive: false,
							details: '',
							meta: { index: idx },
						},
					]),
				);
				expect(sql[0]).toBe(
					'CREATE INDEX IF NOT EXISTS "idx_posts_title_trgm" ON "posts" USING gin ("title" gin_trgm_ops);',
				);
			});

			it('should generate CREATE INDEX with WITH params', () => {
				const idx: IndexIR = {
					name: 'idx_embeddings_hnsw',
					columns: ['embedding'],
					method: 'hnsw',
					with: { m: '16', ef_construction: '200' },
				};
				const sql = generateMigrationSQL(
					makeDiff([
						{
							kind: 'create_index',
							table: 'embeddings',
							destructive: false,
							details: '',
							meta: { index: idx },
						},
					]),
				);
				expect(sql[0]).toBe(
					'CREATE INDEX IF NOT EXISTS "idx_embeddings_hnsw" ON "embeddings" USING hnsw ("embedding") WITH (m = 16, ef_construction = 200);',
				);
			});

			it('should generate CREATE INDEX with INCLUDE columns', () => {
				const idx: IndexIR = {
					name: 'idx_users_email_include',
					columns: ['email'],
					include: ['id', 'name'],
				};
				const sql = generateMigrationSQL(
					makeDiff([
						{
							kind: 'create_index',
							table: 'users',
							destructive: false,
							details: '',
							meta: { index: idx },
						},
					]),
				);
				expect(sql[0]).toBe(
					'CREATE INDEX IF NOT EXISTS "idx_users_email_include" ON "users" ("email") INCLUDE ("id", "name");',
				);
			});

			it('should generate expression index', () => {
				const idx: IndexIR = {
					name: 'idx_users_lower_email',
					columns: [],
					expressions: ['lower("email")'],
				};
				const sql = generateMigrationSQL(
					makeDiff([
						{
							kind: 'create_index',
							table: 'users',
							destructive: false,
							details: '',
							meta: { index: idx },
						},
					]),
				);
				expect(sql[0]).toBe(
					'CREATE INDEX IF NOT EXISTS "idx_users_lower_email" ON "users" (lower("email"));',
				);
			});

			it('should generate combined: method + opclass + where + with', () => {
				const idx: IndexIR = {
					name: 'idx_docs_content_trgm',
					columns: ['content'],
					method: 'gin',
					opclass: { content: 'gin_trgm_ops' },
					where: 'published = true',
					with: { fastupdate: 'on' },
				};
				const sql = generateMigrationSQL(
					makeDiff([
						{
							kind: 'create_index',
							table: 'docs',
							destructive: false,
							details: '',
							meta: { index: idx },
						},
					]),
				);
				expect(sql[0]).toBe(
					'CREATE INDEX IF NOT EXISTS "idx_docs_content_trgm" ON "docs" USING gin ("content" gin_trgm_ops) WITH (fastupdate = on) WHERE published = true;',
				);
			});
		});
	});

	describe('topological ordering', () => {
		it('should order DROP FK before DROP TABLE', () => {
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
			};

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'drop_table',
						table: 'users',
						destructive: true,
						details: '',
					},
					{
						kind: 'drop_foreign_key',
						table: 'posts',
						destructive: true,
						details: '',
						meta: { fk },
					},
				]),
			);

			const dropFKIdx = sql.findIndex((s) => s.includes('DROP CONSTRAINT'));
			const dropTableIdx = sql.findIndex((s) => s.includes('DROP TABLE'));
			expect(dropFKIdx).toBeLessThan(dropTableIdx);
		});

		it('should order CREATE TABLE before ADD FK', () => {
			const table = makeTable('users', [
				makeCol({ name: 'id', type: 'integer' }),
			]);
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
			};

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_foreign_key',
						table: 'posts',
						destructive: false,
						details: '',
						meta: { fk },
					},
					{
						kind: 'create_table',
						table: 'users',
						destructive: false,
						details: '',
						meta: { table },
					},
				]),
			);

			const createTableIdx = sql.findIndex((s) => s.includes('CREATE TABLE'));
			const addFKIdx = sql.findIndex((s) => s.includes('ADD CONSTRAINT'));
			expect(createTableIdx).toBeLessThan(addFKIdx);
		});

		it('should order CREATE INDEX after ADD FK', () => {
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
			};
			const idx: IndexIR = {
				name: 'idx_posts_user_id',
				columns: ['user_id'],
				unique: false,
			};

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_index',
						table: 'posts',
						destructive: false,
						details: '',
						meta: { index: idx },
					},
					{
						kind: 'add_foreign_key',
						table: 'posts',
						destructive: false,
						details: '',
						meta: { fk },
					},
				]),
			);

			const addFKIdx = sql.findIndex((s) => s.includes('ADD CONSTRAINT'));
			const createIndexIdx = sql.findIndex((s) => s.includes('CREATE INDEX'));
			expect(addFKIdx).toBeLessThan(createIndexIdx);
		});
	});

	describe('destructive filtering', () => {
		it('should exclude destructive changes when includeDestructive=false', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'drop_table',
						table: 'old_table',
						destructive: true,
						details: '',
					},
					{
						kind: 'add_column',
						table: 'users',
						column: 'bio',
						destructive: false,
						details: '',
						meta: {
							column: makeCol({
								name: 'bio',
								type: 'text',
								nullable: true,
							}),
						},
					},
				]),
				{ includeDestructive: false },
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain('ADD COLUMN');
			expect(sql.some((s) => s.includes('DROP'))).toBe(false);
		});

		it('should include destructive changes by default', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'drop_table',
						table: 'old_table',
						destructive: true,
						details: '',
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain('DROP TABLE');
		});
	});

	describe('empty diff', () => {
		it('should return empty array for no changes', () => {
			const sql = generateMigrationSQL(makeDiff([]));
			expect(sql).toEqual([]);
		});
	});
});

// ============================================================================
// generateDownSQL
// ============================================================================

describe('generateDownSQL', () => {
	describe('reversible changes', () => {
		it('SC-01: create_table → DROP TABLE', () => {
			const table = makeTable('users', [
				makeCol({ name: 'id', type: 'integer' }),
			]);

			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'create_table',
						table: 'users',
						destructive: false,
						details: '',
						meta: { table },
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toBe('DROP TABLE IF EXISTS "users" CASCADE;');
		});

		it('SC-01: create_table → DROP TABLE with schema', () => {
			const table = makeTable('users', [
				makeCol({ name: 'id', type: 'integer' }),
			]);

			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'create_table',
						table: 'users',
						destructive: false,
						details: '',
						meta: { table },
					},
				]),
				{ schemaName: 'tenant_1' },
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toBe('DROP TABLE IF EXISTS "tenant_1"."users" CASCADE;');
		});

		it('SC-02: add_column → DROP COLUMN', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'add_column',
						table: 'users',
						column: 'email',
						destructive: false,
						details: '',
						meta: {
							column: makeCol({
								name: 'email',
								type: 'string',
							}),
						},
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toBe('ALTER TABLE "users" DROP COLUMN "email" CASCADE;');
		});

		it('SC-03: alter_column_type with fromType → ALTER TYPE back', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'alter_column_type',
						table: 'users',
						column: 'age',
						destructive: true,
						details: '',
						meta: {
							fromType: 'integer',
							toType: 'bigint',
							column: makeCol({
								name: 'age',
								type: 'bigint',
							}),
						},
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toBe(
				'ALTER TABLE "users" ALTER COLUMN "age" TYPE integer;',
			);
		});

		it('SC-03b: uses originalDbType in ALTER COLUMN TYPE rollback (vector precision)', () => {
			// Simulates: schema has vector(1024), DB has vector(768).
			// compareColumnDetails() sets meta.fromType = db.originalDbType = 'vector(768)'.
			// DOWN SQL must revert to the original DB type, not the base type.
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'alter_column_type',
						table: 'embeddings',
						column: 'embedding',
						destructive: true,
						details: '',
						meta: {
							fromType: 'vector(768)',
							toType: 'vector(1024)',
							column: makeCol({
								name: 'embedding',
								type: 'string',
								originalDbType: 'vector(1024)',
							}),
						},
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toBe(
				'ALTER TABLE "embeddings" ALTER COLUMN "embedding" TYPE vector(768);',
			);
		});

		it('SC-05: alter_column_nullable SET NOT NULL → DOWN DROP NOT NULL', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'alter_column_nullable',
						table: 'users',
						column: 'name',
						destructive: false,
						details: '',
						meta: { nullable: false, oldNullable: true },
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toBe(
				'ALTER TABLE "users" ALTER COLUMN "name" DROP NOT NULL;',
			);
		});

		it('SC-05: alter_column_nullable DROP NOT NULL → DOWN SET NOT NULL', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'alter_column_nullable',
						table: 'users',
						column: 'name',
						destructive: false,
						details: '',
						meta: { nullable: true, oldNullable: false },
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toBe(
				'ALTER TABLE "users" ALTER COLUMN "name" SET NOT NULL;',
			);
		});

		it('alter_column_default with oldDefault → SET DEFAULT back', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'alter_column_default',
						table: 'users',
						column: 'status',
						destructive: false,
						details: '',
						meta: { default: 'active', oldDefault: 'pending' },
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toBe(
				`ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'pending';`,
			);
		});

		it('alter_column_default with null oldDefault → DROP DEFAULT', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'alter_column_default',
						table: 'users',
						column: 'status',
						destructive: false,
						details: '',
						meta: { default: 'active', oldDefault: null },
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toBe(
				'ALTER TABLE "users" ALTER COLUMN "status" DROP DEFAULT;',
			);
		});

		it('add_primary_key → DROP CONSTRAINT', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'add_primary_key',
						table: 'users',
						destructive: false,
						details: '',
						meta: { columns: ['id'] },
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toBe(
				'ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "pk_users" CASCADE;',
			);
		});

		it('SC-06: add_foreign_key → DROP CONSTRAINT', () => {
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				onDelete: 'CASCADE',
			};

			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'add_foreign_key',
						table: 'orders',
						destructive: false,
						details: '',
						meta: { fk },
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toBe(
				'ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "fk_orders_user_id" CASCADE;',
			);
		});

		it('SC-06: create_index → DROP INDEX', () => {
			const idx: IndexIR = {
				name: 'idx_users_email',
				columns: ['email'],
				unique: true,
			};

			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'create_index',
						table: 'users',
						destructive: false,
						details: '',
						meta: { index: idx },
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toBe('DROP INDEX IF EXISTS "idx_users_email";');
		});

		it('SC-06: create_index with schema → DROP INDEX schema-qualified', () => {
			const idx: IndexIR = {
				name: 'idx_users_email',
				columns: ['email'],
				unique: true,
			};

			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'create_index',
						table: 'users',
						destructive: false,
						details: '',
						meta: { index: idx },
					},
				]),
				{ schemaName: 'tenant_1' },
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toBe('DROP INDEX IF EXISTS "tenant_1"."idx_users_email";');
		});

		it('SC-07: alter_foreign_key with oldFk → DROP + re-add old', () => {
			const newFk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				onDelete: 'CASCADE',
			};
			const oldFk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				onDelete: 'SET NULL',
			};

			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'alter_foreign_key',
						table: 'orders',
						destructive: false,
						details: '',
						meta: {
							fk: newFk,
							previousOnDelete: 'SET NULL',
							oldFk,
						},
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain('DROP CONSTRAINT IF EXISTS "fk_orders_user_id"');
			expect(sql[0]).toContain('ON DELETE SET NULL');
		});
	});

	describe('irreversible changes (warnings)', () => {
		it('SC-04: drop_table → WARNING comment', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'drop_table',
						table: 'old_table',
						destructive: true,
						details: '',
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain('-- WARNING');
			expect(sql[0]).toContain('drop_table');
			expect(sql[0]).toContain('"old_table"');
		});

		it('drop_column → WARNING comment', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'drop_column',
						table: 'users',
						column: 'legacy',
						destructive: true,
						details: '',
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain('-- WARNING');
			expect(sql[0]).toContain('drop_column');
		});

		it('drop_primary_key → WARNING comment', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'drop_primary_key',
						table: 'users',
						destructive: true,
						details: '',
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain('-- WARNING');
			expect(sql[0]).toContain('drop_primary_key');
		});

		it('drop_foreign_key → WARNING comment', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'drop_foreign_key',
						table: 'orders',
						destructive: true,
						details: '',
						meta: {
							fk: {
								columns: ['user_id'],
								references: { table: 'users', columns: ['id'] },
							},
						},
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain('-- WARNING');
			expect(sql[0]).toContain('drop_foreign_key');
		});

		it('drop_index → WARNING comment', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'drop_index',
						table: 'users',
						destructive: false,
						details: '',
						meta: {
							index: {
								name: 'idx_users_email',
								columns: ['email'],
								unique: false,
							},
						},
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain('-- WARNING');
			expect(sql[0]).toContain('drop_index');
		});
	});

	describe('missing meta → warnings', () => {
		it('alter_column_type without fromType → WARNING', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'alter_column_type',
						table: 'users',
						column: 'age',
						destructive: true,
						details: '',
						meta: { toType: 'bigint' },
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain('-- WARNING');
			expect(sql[0]).toContain('missing migration metadata');
		});

		it('alter_column_nullable without oldNullable → WARNING', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'alter_column_nullable',
						table: 'users',
						column: 'name',
						destructive: false,
						details: '',
						meta: { nullable: false },
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain('-- WARNING');
			expect(sql[0]).toContain('missing migration metadata');
		});

		it('alter_column_default without oldDefault → WARNING', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'alter_column_default',
						table: 'users',
						column: 'status',
						destructive: false,
						details: '',
						meta: { default: 'active' },
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain('-- WARNING');
			expect(sql[0]).toContain('missing migration metadata');
		});

		it('alter_foreign_key without oldFk → WARNING', () => {
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				onDelete: 'CASCADE',
			};

			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'alter_foreign_key',
						table: 'orders',
						destructive: false,
						details: '',
						meta: { fk, previousOnDelete: 'SET NULL' },
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain('-- WARNING');
			expect(sql[0]).toContain('missing migration metadata');
		});
	});

	describe('topological order', () => {
		it('SC-08: should reverse phase order (index first, then FK, then table)', () => {
			const table = makeTable('users', [
				makeCol({ name: 'id', type: 'integer' }),
			]);
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				onDelete: 'CASCADE',
			};
			const idx: IndexIR = {
				name: 'idx_orders_user_id',
				columns: ['user_id'],
				unique: false,
			};

			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'create_table',
						table: 'users',
						destructive: false,
						details: '',
						meta: { table },
					},
					{
						kind: 'add_column',
						table: 'orders',
						column: 'notes',
						destructive: false,
						details: '',
						meta: {
							column: makeCol({ name: 'notes', type: 'text' }),
						},
					},
					{
						kind: 'add_primary_key',
						table: 'users',
						destructive: false,
						details: '',
						meta: { columns: ['id'] },
					},
					{
						kind: 'add_foreign_key',
						table: 'orders',
						destructive: false,
						details: '',
						meta: { fk },
					},
					{
						kind: 'create_index',
						table: 'orders',
						destructive: false,
						details: '',
						meta: { index: idx },
					},
				]),
			);

			// Reversed order: index(11) → FK(9) → PK(8) → alter(7) → column(6) → table(5)
			expect(sql.length).toBe(5);
			// Index DROP first
			expect(sql[0]).toContain('DROP INDEX');
			// FK DROP second
			expect(sql[1]).toContain('DROP CONSTRAINT IF EXISTS "fk_orders_user_id"');
			// PK DROP third
			expect(sql[2]).toContain('DROP CONSTRAINT IF EXISTS "pk_users"');
			// Column DROP fourth
			expect(sql[3]).toContain('DROP COLUMN "notes"');
			// Table DROP last
			expect(sql[4]).toContain('DROP TABLE IF EXISTS "users"');
		});
	});

	describe('compareSchemata + generateMigrationSQL (end-to-end, new table FK/index)', () => {
		// Helper to build a minimal ModelIR from a list of TableIR
		function makeModel(tables: TableIR[]): ModelIRImpl {
			return new ModelIRImpl(
				new Map(tables.map((t) => [t.name, t])),
				new Map(),
			);
		}

		// Helper to build a TableIR with optional FK/index arrays
		function makeFullTable(
			name: string,
			columns: ColumnIR[],
			opts: {
				pk?: string | string[];
				foreignKeys?: ForeignKeyIR[];
				indexes?: IndexIR[];
			} = {},
		): TableIR {
			return {
				name,
				columns,
				...(opts.pk !== undefined ? { primaryKey: opts.pk } : {}),
				foreignKeys: opts.foreignKeys ?? [],
				indexes: opts.indexes ?? [],
			};
		}

		it('emits add_foreign_key for a new table with a FK (CREATE TABLE before ALTER TABLE)', () => {
			const usersTable = makeFullTable(
				'users',
				[makeCol({ name: 'id', type: 'integer', autoIncrement: true })],
				{ pk: 'id' },
			);
			const schema = makeModel([
				usersTable,
				makeFullTable(
					'orders',
					[
						makeCol({ name: 'id', type: 'integer', autoIncrement: true }),
						makeCol({ name: 'user_id', type: 'integer', nullable: false }),
					],
					{
						pk: 'id',
						foreignKeys: [
							{
								columns: ['user_id'],
								references: { table: 'users', columns: ['id'] },
							},
						],
					},
				),
			]);
			const db = makeModel([]); // empty DB

			const diff = compareSchemata(schema, db);
			const sql = generateMigrationSQL(diff);

			// Must have CREATE TABLE and ADD CONSTRAINT ... FOREIGN KEY
			const createIdx = sql.findIndex((s) =>
				s.startsWith('CREATE TABLE "orders"'),
			);
			const fkIdx = sql.findIndex((s) => s.includes('FOREIGN KEY'));

			expect(createIdx).toBeGreaterThanOrEqual(0);
			expect(fkIdx).toBeGreaterThanOrEqual(0);
			// CREATE TABLE (phase 5) must come before ADD FK (phase 9)
			expect(fkIdx).toBeGreaterThan(createIdx);
			// Exact FK statement
			expect(sql[fkIdx]).toBe(
				'ALTER TABLE "orders" ADD CONSTRAINT "fk_orders_user_id" FOREIGN KEY ("user_id") REFERENCES "users" ("id");',
			);
		});

		it('emits create_index for a new table with an index (CREATE TABLE before CREATE INDEX)', () => {
			const schema = makeModel([
				makeFullTable(
					'users',
					[
						makeCol({ name: 'id', type: 'integer', autoIncrement: true }),
						makeCol({ name: 'email', type: 'string', nullable: false }),
					],
					{
						pk: 'id',
						indexes: [
							{ name: 'idx_users_email', columns: ['email'], unique: true },
						],
					},
				),
			]);
			const db = makeModel([]);

			const diff = compareSchemata(schema, db);
			const sql = generateMigrationSQL(diff);

			const createIdx = sql.findIndex((s) =>
				s.startsWith('CREATE TABLE "users"'),
			);
			const idxIdx = sql.findIndex((s) => s.includes('CREATE UNIQUE INDEX'));

			expect(createIdx).toBeGreaterThanOrEqual(0);
			expect(idxIdx).toBeGreaterThanOrEqual(0);
			// CREATE TABLE (phase 5) must come before CREATE INDEX (phase 11)
			expect(idxIdx).toBeGreaterThan(createIdx);
			expect(sql[idxIdx]).toBe(
				'CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_email" ON "users" ("email");',
			);
		});

		it('emits CREATE TABLE → FK (phase 9) → INDEX (phase 11) in topological order', () => {
			const usersTable = makeFullTable(
				'users',
				[makeCol({ name: 'id', type: 'integer', autoIncrement: true })],
				{ pk: 'id' },
			);
			const schema = makeModel([
				usersTable,
				makeFullTable(
					'orders',
					[
						makeCol({ name: 'id', type: 'integer', autoIncrement: true }),
						makeCol({ name: 'user_id', type: 'integer', nullable: false }),
						makeCol({ name: 'sku', type: 'string', nullable: false }),
					],
					{
						pk: 'id',
						foreignKeys: [
							{
								columns: ['user_id'],
								references: { table: 'users', columns: ['id'] },
							},
						],
						indexes: [{ columns: ['sku'], unique: false }],
					},
				),
			]);
			const db = makeModel([]);

			const diff = compareSchemata(schema, db);
			const sql = generateMigrationSQL(diff);

			const createIdx = sql.findIndex((s) =>
				s.startsWith('CREATE TABLE "orders"'),
			);
			const fkIdx = sql.findIndex((s) => s.includes('FOREIGN KEY'));
			const idxIdx = sql.findIndex((s) => s.includes('CREATE INDEX'));

			expect(createIdx).toBeGreaterThanOrEqual(0);
			expect(fkIdx).toBeGreaterThanOrEqual(0);
			expect(idxIdx).toBeGreaterThanOrEqual(0);
			// Phase order: 5 (create_table) < 9 (add_foreign_key) < 11 (create_index)
			expect(fkIdx).toBeGreaterThan(createIdx);
			expect(idxIdx).toBeGreaterThan(fkIdx);
		});

		it('does not emit FK/index changes for existing tables (regression: existing diff path unchanged)', () => {
			const existingTable = makeFullTable(
				'users',
				[makeCol({ name: 'id', type: 'integer', autoIncrement: true })],
				{
					pk: 'id',
					foreignKeys: [],
					indexes: [{ name: 'idx_users_id', columns: ['id'], unique: false }],
				},
			);
			// DB already has the table with the same index
			const schema = makeModel([existingTable]);
			const db = makeModel([existingTable]);

			const diff = compareSchemata(schema, db);
			const sql = generateMigrationSQL(diff);

			// No changes needed when schema matches DB exactly
			expect(sql).toHaveLength(0);
		});

		it('emits FK with onDelete for a new table', () => {
			const postsTable = makeFullTable(
				'posts',
				[makeCol({ name: 'id', type: 'integer', autoIncrement: true })],
				{ pk: 'id' },
			);
			const schema = makeModel([
				postsTable,
				makeFullTable(
					'comments',
					[
						makeCol({ name: 'id', type: 'integer', autoIncrement: true }),
						makeCol({ name: 'post_id', type: 'integer', nullable: false }),
					],
					{
						pk: 'id',
						foreignKeys: [
							{
								columns: ['post_id'],
								references: { table: 'posts', columns: ['id'] },
								onDelete: 'CASCADE',
							},
						],
					},
				),
			]);
			const db = makeModel([]);

			const diff = compareSchemata(schema, db);
			const sql = generateMigrationSQL(diff);

			const fkIdx = sql.findIndex((s) => s.includes('FOREIGN KEY'));
			expect(fkIdx).toBeGreaterThanOrEqual(0);
			expect(sql[fkIdx]).toBe(
				'ALTER TABLE "comments" ADD CONSTRAINT "fk_comments_post_id" FOREIGN KEY ("post_id") REFERENCES "posts" ("id") ON DELETE CASCADE;',
			);
		});
	});

	describe('options', () => {
		it('should filter out destructive changes when includeDestructive is false', () => {
			const table = makeTable('users', [
				makeCol({ name: 'id', type: 'integer' }),
			]);

			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'create_table',
						table: 'users',
						destructive: false,
						details: '',
						meta: { table },
					},
					{
						kind: 'drop_table',
						table: 'old_table',
						destructive: true,
						details: '',
					},
				]),
				{ includeDestructive: false },
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain('DROP TABLE IF EXISTS "users"');
		});

		it('should return empty array for no changes', () => {
			const sql = generateDownSQL(makeDiff([]));
			expect(sql).toEqual([]);
		});
	});
});

describe('CHECK constraints migration SQL', () => {
	it('should generate idempotent ADD CHECK CONSTRAINT', () => {
		const diff = makeDiff([
			{
				kind: 'add_check_constraint',
				table: 'users',
				destructive: false,
				details: 'Add CHECK',
				meta: {
					check: { name: 'users_age_check', expression: 'CHECK ((age > 0))' },
				},
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toBe(
			'DO $$ BEGIN ALTER TABLE "users" ADD CONSTRAINT "users_age_check" CHECK ((age > 0)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;',
		);
	});

	it('should generate DROP CHECK CONSTRAINT IF EXISTS', () => {
		const diff = makeDiff([
			{
				kind: 'drop_check_constraint',
				table: 'users',
				destructive: true,
				details: 'Drop CHECK',
				meta: {
					check: { name: 'users_age_check', expression: 'CHECK ((age > 0))' },
				},
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toBe(
			'ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_age_check";',
		);
	});

	it('should order CHECK drops before column drops and CHECK adds after indexes', () => {
		const diff = makeDiff([
			{
				kind: 'add_check_constraint',
				table: 'users',
				destructive: false,
				details: '',
				meta: { check: { name: 'ck1', expression: 'CHECK (true)' } },
			},
			{
				kind: 'create_index',
				table: 'users',
				destructive: false,
				details: '',
				meta: { index: { name: 'idx_users_a', columns: ['a'], unique: false } },
			},
			{
				kind: 'drop_check_constraint',
				table: 'users',
				destructive: true,
				details: '',
				meta: { check: { name: 'ck2', expression: 'CHECK (true)' } },
			},
			{
				kind: 'drop_column',
				table: 'users',
				destructive: true,
				details: '',
				column: 'old_col',
			},
		]);
		const sql = generateMigrationSQL(diff);
		// drop_check (phase 0) → drop_column (phase 2) → create_index (phase 11) → add_check (phase 12)
		expect(sql[0]).toContain('DROP CONSTRAINT');
		expect(sql[1]).toContain('DROP COLUMN');
		expect(sql[2]).toContain('CREATE');
		expect(sql[3]).toContain('DO $$');
	});
});


// ============================================================================
// ENUM types
// ============================================================================

describe('ENUM types', () => {
	it('should generate CREATE TYPE for new enum', () => {
		const diff = makeDiff([{
			kind: 'create_enum',
			table: '',
			destructive: false,
			details: 'Create enum',
			meta: { enum: { name: 'status', values: ['active', 'inactive'] } },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toBe("CREATE TYPE \"status\" AS ENUM ('active', 'inactive');");
	});

	it('should generate CREATE TYPE with schema prefix', () => {
		const diff = makeDiff([{
			kind: 'create_enum',
			table: '',
			destructive: false,
			details: 'Create enum',
			meta: { enum: { name: 'status', values: ['active', 'inactive'] } },
		}]);
		const sql = generateMigrationSQL(diff, { schemaName: 'myschema' });
		expect(sql[0]).toBe("CREATE TYPE \"myschema\".\"status\" AS ENUM ('active', 'inactive');");
	});

	it('should escape single quotes in enum values', () => {
		const diff = makeDiff([{
			kind: 'create_enum',
			table: '',
			destructive: false,
			details: 'Create enum',
			meta: { enum: { name: 'mood', values: ["it's fine", 'bad'] } },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toBe("CREATE TYPE \"mood\" AS ENUM ('it''s fine', 'bad');");
	});

	it('should generate ALTER TYPE ADD VALUE with position', () => {
		const diff = makeDiff([{
			kind: 'alter_enum_add_value',
			table: '',
			destructive: false,
			details: 'Add value',
			meta: { enum: { name: 'status', values: ['active', 'inactive', 'pending'] }, value: 'pending', after: 'inactive' },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toBe("ALTER TYPE \"status\" ADD VALUE IF NOT EXISTS 'pending' AFTER 'inactive';");
	});

	it('should generate ALTER TYPE ADD VALUE without position', () => {
		const diff = makeDiff([{
			kind: 'alter_enum_add_value',
			table: '',
			destructive: false,
			details: 'Add value',
			meta: { enum: { name: 'status', values: ['active', 'pending'] }, value: 'pending', after: undefined },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toBe("ALTER TYPE \"status\" ADD VALUE IF NOT EXISTS 'pending';");
	});

	it('should generate DROP TYPE for removed enum', () => {
		const diff = makeDiff([{
			kind: 'drop_enum',
			table: '',
			destructive: true,
			details: 'Drop enum',
			meta: { enum: { name: 'status', values: ['active', 'inactive'] } },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toBe('DROP TYPE IF EXISTS "status" CASCADE;');
	});

	it('should order create_enum BEFORE create_table', () => {
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'users',
				destructive: false,
				details: '',
				meta: {
					table: makeTable('users', [makeCol({ name: 'id', type: 'integer' })]),
				},
			},
			{
				kind: 'create_enum',
				table: '',
				destructive: false,
				details: '',
				meta: { enum: { name: 'status', values: ['a'] } },
			},
		]);
		const sql = generateMigrationSQL(diff);
		const typeIdx = sql.findIndex((s) => s.includes('CREATE TYPE'));
		const tableIdx = sql.findIndex((s) => s.includes('CREATE TABLE'));
		expect(typeIdx).toBeGreaterThanOrEqual(0);
		expect(typeIdx).toBeLessThan(tableIdx);
	});

	it('should order alter_enum_add_value AFTER create_index', () => {
		const diff = makeDiff([
			{
				kind: 'alter_enum_add_value',
				table: '',
				destructive: false,
				details: '',
				meta: { enum: { name: 'status', values: ['a', 'b'] }, value: 'b', after: 'a' },
			},
			{
				kind: 'create_index',
				table: 'users',
				destructive: false,
				details: '',
				meta: { index: { name: 'idx_users_name', columns: ['name'], unique: false } },
			},
		]);
		const sql = generateMigrationSQL(diff);
		const indexIdx = sql.findIndex((s) => s.includes('INDEX'));
		const addValueIdx = sql.findIndex((s) => s.includes('ADD VALUE'));
		expect(indexIdx).toBeGreaterThanOrEqual(0);
		expect(addValueIdx).toBeGreaterThan(indexIdx);
	});

	it('should order drop_enum BEFORE create_enum in same diff', () => {
		const diff = makeDiff([
			{
				kind: 'create_enum',
				table: '',
				destructive: false,
				details: '',
				meta: { enum: { name: 'new_status', values: ['a'] } },
			},
			{
				kind: 'drop_enum',
				table: '',
				destructive: true,
				details: '',
				meta: { enum: { name: 'old_status', values: ['x'] } },
			},
		]);
		const sql = generateMigrationSQL(diff);
		const dropIdx = sql.findIndex((s) => s.includes('DROP TYPE'));
		const createIdx = sql.findIndex((s) => s.includes('CREATE TYPE'));
		expect(dropIdx).toBeGreaterThanOrEqual(0);
		expect(dropIdx).toBeLessThan(createIdx);
	});

	describe('DOWN SQL for ENUM types', () => {
		it('create_enum DOWN should DROP the type', () => {
			const diff = makeDiff([{
				kind: 'create_enum',
				table: '',
				destructive: false,
				details: '',
				meta: { enum: { name: 'status', values: ['a', 'b'] } },
			}]);
			const sql = generateDownSQL(diff);
			expect(sql[0]).toBe('DROP TYPE IF EXISTS "status" CASCADE;');
		});

		it('drop_enum DOWN should recreate the type', () => {
			const diff = makeDiff([{
				kind: 'drop_enum',
				table: '',
				destructive: true,
				details: '',
				meta: { enum: { name: 'status', values: ['active', 'inactive'] } },
			}]);
			const sql = generateDownSQL(diff);
			expect(sql[0]).toBe("CREATE TYPE \"status\" AS ENUM ('active', 'inactive');");
		});

		it('alter_enum_add_value DOWN should emit a comment', () => {
			const diff = makeDiff([{
				kind: 'alter_enum_add_value',
				table: '',
				destructive: false,
				details: '',
				meta: { enum: { name: 'status', values: ['a', 'b'] }, value: 'b', after: 'a' },
			}]);
			const sql = generateDownSQL(diff);
			expect(sql[0]).toContain('cannot be reversed');
		});
	});
});


// ============================================================================
// FK Enhancements: onUpdate + deferred + auto-index
// ============================================================================

describe('FK enhancements — migration SQL', () => {
	const baseFk: ForeignKeyIR = {
		columns: ['user_id'],
		references: { table: 'users', columns: ['id'] },
	};

	it('should generate ON UPDATE CASCADE', () => {
		const diff = makeDiff([{
			kind: 'add_foreign_key',
			table: 'orders',
			destructive: false,
			details: '',
			meta: { fk: { ...baseFk, onUpdate: 'CASCADE' } },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toContain('ON UPDATE CASCADE');
	});

	it('should generate DEFERRABLE INITIALLY DEFERRED', () => {
		const diff = makeDiff([{
			kind: 'add_foreign_key',
			table: 'orders',
			destructive: false,
			details: '',
			meta: { fk: { ...baseFk, deferred: true } },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toContain('DEFERRABLE INITIALLY DEFERRED');
	});

	it('should generate combined ON DELETE + ON UPDATE + DEFERRABLE', () => {
		const diff = makeDiff([{
			kind: 'add_foreign_key',
			table: 'orders',
			destructive: false,
			details: '',
			meta: { fk: { ...baseFk, onDelete: 'CASCADE', onUpdate: 'SET NULL', deferred: true } },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toContain('ON DELETE CASCADE');
		expect(sql[0]).toContain('ON UPDATE SET NULL');
		expect(sql[0]).toContain('DEFERRABLE INITIALLY DEFERRED');
	});

	it('should NOT emit ON UPDATE when onUpdate is absent', () => {
		const diff = makeDiff([{
			kind: 'add_foreign_key',
			table: 'orders',
			destructive: false,
			details: '',
			meta: { fk: baseFk },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).not.toContain('ON UPDATE');
		expect(sql[0]).not.toContain('DEFERRABLE');
	});

	it('should generate FK auto-index for new tables', () => {
		const table = makeTable('orders', [
			makeCol({ name: 'user_id', type: 'integer' }),
		]);
		const tableWithFk: TableIR = {
			...table,
			foreignKeys: [baseFk],
		};
		const diff = makeDiff([{
			kind: 'create_table',
			table: 'orders',
			destructive: false,
			details: '',
			meta: { table: tableWithFk },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql.some((s) => s.includes('CREATE INDEX') && s.includes('"user_id"'))).toBe(true);
	});

	it('should NOT generate FK auto-index when fkAutoIndex=false', () => {
		const table = makeTable('orders', [
			makeCol({ name: 'user_id', type: 'integer' }),
		]);
		const tableWithFk: TableIR = {
			...table,
			foreignKeys: [baseFk],
		};
		const diff = makeDiff([{
			kind: 'create_table',
			table: 'orders',
			destructive: false,
			details: '',
			meta: { table: tableWithFk },
		}]);
		const sql = generateMigrationSQL(diff, { fkAutoIndex: false });
		expect(sql.some((s) => s.includes('CREATE INDEX') && s.includes('"user_id"'))).toBe(false);
	});

	it('should NOT generate FK auto-index when explicit index covers the FK column', () => {
		const table = makeTable('orders', [
			makeCol({ name: 'user_id', type: 'integer' }),
		]);
		const tableWithFk: TableIR = {
			...table,
			foreignKeys: [baseFk],
			indexes: [{ name: 'idx_orders_user_id', columns: ['user_id'] }],
		};
		const diff = makeDiff([{
			kind: 'create_table',
			table: 'orders',
			destructive: false,
			details: '',
			meta: { table: tableWithFk },
		}]);
		const sql = generateMigrationSQL(diff);
		const autoIndexCount = sql.filter((s) =>
			s.includes('CREATE INDEX') && s.includes('"user_id"'),
		).length;
		// Only the explicit index from create_index phase (none here), no duplicates
		expect(autoIndexCount).toBe(0);
	});
});

// ============================================================================
// Block 5: Column Enhancements — collation, identity, comments
// ============================================================================

describe('Column enhancements — migration SQL', () => {
	it('should generate ALTER COLUMN TYPE with COLLATE', () => {
		const col = makeCol({ name: 'name', type: 'string', collation: 'en_US' });
		const diff = makeDiff([{
			kind: 'alter_column_collation',
			table: 'users',
			column: 'name',
			destructive: false,
			details: '',
			meta: { column: col },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toContain('ALTER COLUMN "name" TYPE');
		expect(sql[0]).toContain('COLLATE "en_US"');
	});

	it('should generate ADD GENERATED ALWAYS AS IDENTITY', () => {
		const col = makeCol({ name: 'id', type: 'integer', identity: 'always' });
		const diff = makeDiff([{
			kind: 'alter_column_identity',
			table: 'users',
			column: 'id',
			destructive: false,
			details: '',
			meta: { column: col, previousIdentity: undefined },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toContain('ADD GENERATED ALWAYS AS IDENTITY');
	});

	it('should generate DROP IDENTITY IF EXISTS', () => {
		const col = makeCol({ name: 'id', type: 'integer' });
		const diff = makeDiff([{
			kind: 'alter_column_identity',
			table: 'users',
			column: 'id',
			destructive: false,
			details: '',
			meta: { column: col, previousIdentity: 'always' },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toContain('DROP IDENTITY IF EXISTS');
	});

	it('should generate SET GENERATED BY DEFAULT for identity type change', () => {
		const col = makeCol({ name: 'id', type: 'integer', identity: 'byDefault' });
		const diff = makeDiff([{
			kind: 'alter_column_identity',
			table: 'users',
			column: 'id',
			destructive: false,
			details: '',
			meta: { column: col, previousIdentity: 'always' },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toContain('SET GENERATED BY DEFAULT');
	});

	it('should generate COMMENT ON TABLE', () => {
		const diff = makeDiff([{
			kind: 'add_comment',
			table: 'users',
			destructive: false,
			details: '',
			meta: { comment: 'User accounts', target: 'table' },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toMatch(/COMMENT ON TABLE "users" IS 'User accounts'/);
	});

	it('should generate COMMENT ON COLUMN', () => {
		const diff = makeDiff([{
			kind: 'add_comment',
			table: 'users',
			column: 'email',
			destructive: false,
			details: '',
			meta: { comment: 'Primary email', target: 'column' },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toMatch(/COMMENT ON COLUMN "users"\."email" IS 'Primary email'/);
	});

	it('should generate COMMENT IS NULL for drop_comment on table', () => {
		const diff = makeDiff([{
			kind: 'drop_comment',
			table: 'users',
			destructive: false,
			details: '',
			meta: { target: 'table' },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toMatch(/COMMENT ON TABLE "users" IS NULL/);
	});

	it('should generate COMMENT IS NULL for drop_comment on column', () => {
		const diff = makeDiff([{
			kind: 'drop_comment',
			table: 'users',
			column: 'email',
			destructive: false,
			details: '',
			meta: { target: 'column' },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toMatch(/COMMENT ON COLUMN "users"\."email" IS NULL/);
	});

	it('should order comments at phase 15 (after alter_column)', () => {
		const col = makeCol({ name: 'id', type: 'integer', identity: 'always' });
		const diff = makeDiff([
			{
				kind: 'add_comment',
				table: 'users',
				destructive: false,
				details: '',
				meta: { comment: 'A table', target: 'table' },
			},
			{
				kind: 'alter_column_identity',
				table: 'users',
				column: 'id',
				destructive: false,
				details: '',
				meta: { column: col, previousIdentity: undefined },
			},
		]);
		const sql = generateMigrationSQL(diff);
		const identityIdx = sql.findIndex((s) => s.includes('GENERATED'));
		const commentIdx = sql.findIndex((s) => s.includes('COMMENT ON TABLE'));
		expect(identityIdx).toBeLessThan(commentIdx);
	});

	it('should escape single quotes in comments', () => {
		const diff = makeDiff([{
			kind: 'add_comment',
			table: 'users',
			destructive: false,
			details: '',
			meta: { comment: "O'Brien's table", target: 'table' },
		}]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toContain("O''Brien''s table");
	});

	it('should apply schema prefix to comment statements', () => {
		const diff = makeDiff([{
			kind: 'add_comment',
			table: 'users',
			destructive: false,
			details: '',
			meta: { comment: 'Scoped table', target: 'table' },
		}]);
		const sql = generateMigrationSQL(diff, { schemaName: 'myschema' });
		expect(sql[0]).toContain('"myschema"."users"');
	});
});
