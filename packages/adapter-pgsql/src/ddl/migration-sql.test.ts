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
import { generateMigrationSQL } from './migration-sql.js';
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
