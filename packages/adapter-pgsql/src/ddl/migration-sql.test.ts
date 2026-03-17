/**
 * Tests for migration SQL generation from SchemaDiff.
 *
 * Covers:
 * - Topological ordering of statements
 * - SQL generation for each ChangeKind
 * - Schema-qualified identifiers
 * - Destructive change filtering
 */

import type { ColumnIR, ForeignKeyIR, IndexIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { generateDownSQL, generateMigrationSQL } from './migration-sql.js';
import type { SchemaChange, SchemaDiff } from './schema-diff.js';

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
