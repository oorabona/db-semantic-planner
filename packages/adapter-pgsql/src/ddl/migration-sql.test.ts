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
import type {
	ColumnIR,
	DialectCapabilities,
	EnumIR,
	ForeignKeyIR,
	IndexIR,
	PartitionIR,
	PolicyIR,
	SequenceIR,
	TableIR,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { camelCaseNaming } from '../naming-plugin.js';
import { generateDDL } from './ddl-generator.js';
import {
	generateDownMigrationSQL,
	generateDownSQL,
	generateMigrationSQL,
} from './migration-sql.js';
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

function makeModel(tables: readonly TableIR[]): ModelIRImpl {
	return new ModelIRImpl(
		new Map(tables.map((table) => [table.name, table] as const)),
		new Map(),
	);
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

		it('should generate ADD CONSTRAINT for alter_column_unique true', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'alter_column_unique',
						table: 'users',
						column: 'email',
						destructive: false,
						details: '',
						meta: { unique: true },
					},
				]),
			);

			expect(sql).toEqual([
				'ALTER TABLE "users" ADD CONSTRAINT "users_email_key" UNIQUE ("email");',
			]);
		});

		it('should generate DROP CONSTRAINT for alter_column_unique false', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'alter_column_unique',
						table: 'users',
						column: 'email',
						destructive: false,
						details: '',
						meta: { unique: false },
					},
				]),
			);

			expect(sql).toEqual([
				'ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_key";',
			]);
		});

		it('should use the real DB constraint name when dropping column unique', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'alter_column_unique',
						table: 'users',
						column: 'email',
						destructive: false,
						details: '',
						meta: {
							unique: false,
							constraintName: 'users_email_custom_uq',
						},
					},
				]),
			);

			expect(sql).toEqual([
				'ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_custom_uq";',
			]);
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

		it('should use an explicit FK constraint name when adding', () => {
			const fk: ForeignKeyIR = {
				constraintName: 'posts_author_id_fkey',
				columns: ['author_id'],
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
				]),
			);

			expect(sql[0]).toBe(
				'ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users" ("id");',
			);
		});

		it('should qualify a declared referenced schema for ADD FOREIGN KEY', () => {
			const fk: ForeignKeyIR = {
				columns: ['ext_id'],
				references: { schema: 'other', table: 'ext', columns: ['id'] },
			};

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_foreign_key',
						table: 'orders',
						destructive: false,
						details: '',
						meta: { fk },
					},
				]),
				{ schemaName: 'app' },
			);

			expect(sql).toEqual([
				'ALTER TABLE "app"."orders" ADD CONSTRAINT "fk_orders_ext_id" FOREIGN KEY ("ext_id") REFERENCES "other"."ext" ("id");',
			]);
		});

		it('should reject an invalid declared referenced schema for ADD FOREIGN KEY', () => {
			const fk: ForeignKeyIR = {
				columns: ['ext_id'],
				references: {
					schema: 'a"; DROP TABLE x',
					table: 'ext',
					columns: ['id'],
				},
			};

			expect(() =>
				generateMigrationSQL(
					makeDiff([
						{
							kind: 'add_foreign_key',
							table: 'orders',
							destructive: false,
							details: '',
							meta: { fk },
						},
					]),
					{ schemaName: 'app' },
				),
			).toThrow();
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

		it('should use an explicit FK constraint name when dropping', () => {
			const fk: ForeignKeyIR = {
				constraintName: 'posts_author_id_fkey',
				columns: ['author_id'],
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
				'ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_author_id_fkey";',
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

		it('should drop the old named FK when altering', () => {
			const fk: ForeignKeyIR = {
				columns: ['author_id'],
				references: { table: 'users', columns: ['id'] },
				onDelete: 'SET NULL',
			};
			const oldFk: ForeignKeyIR = {
				...fk,
				constraintName: 'posts_author_id_fkey',
				onDelete: 'CASCADE',
			};

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'alter_foreign_key',
						table: 'posts',
						destructive: false,
						details: '',
						meta: { fk, oldFk },
					},
				]),
			);

			expect(sql[0]).toContain(
				'DROP CONSTRAINT IF EXISTS "posts_author_id_fkey"',
			);
			expect(sql[0]).toContain('ADD CONSTRAINT "fk_posts_author_id"');
			expect(sql[0]).toContain('ON DELETE SET NULL');
		});

		it('should generate RENAME CONSTRAINT for an FK rename', () => {
			const oldFk: ForeignKeyIR = {
				constraintName: 'posts_author_id_fkey',
				columns: ['author_id'],
				references: { table: 'users', columns: ['id'] },
			};
			const fk: ForeignKeyIR = {
				...oldFk,
				constraintName: 'custom_posts_author_fk',
			};

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'rename_foreign_key',
						table: 'posts',
						destructive: false,
						details: '',
						meta: { fk, oldFk },
					},
				]),
			);

			expect(sql).toEqual([
				'ALTER TABLE "posts" RENAME CONSTRAINT "posts_author_id_fkey" TO "custom_posts_author_fk";',
			]);
		});

		it('should reverse an FK rename in DOWN SQL', () => {
			const oldFk: ForeignKeyIR = {
				constraintName: 'posts_author_id_fkey',
				columns: ['author_id'],
				references: { table: 'users', columns: ['id'] },
			};
			const fk: ForeignKeyIR = {
				...oldFk,
				constraintName: 'custom_posts_author_fk',
			};

			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'rename_foreign_key',
						table: 'posts',
						destructive: false,
						details: '',
						meta: { fk, oldFk },
					},
				]),
			);

			expect(sql).toEqual([
				'ALTER TABLE "posts" RENAME CONSTRAINT "custom_posts_author_fk" TO "posts_author_id_fkey";',
			]);
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

		it('should generate NULLS NOT DISTINCT only for unique indexes', () => {
			const uniqueWithNulls: IndexIR = {
				name: 'idx_users_email_unique',
				columns: ['email'],
				unique: true,
				nullsNotDistinct: true,
				where: 'deleted_at IS NULL',
			};
			const uniqueWithoutNulls: IndexIR = {
				name: 'idx_users_email_unique_plain',
				columns: ['email'],
				unique: true,
				where: 'deleted_at IS NULL',
			};
			const nonUniqueWithNulls: IndexIR = {
				name: 'idx_users_email_plain',
				columns: ['email'],
				nullsNotDistinct: true,
			};

			const withNullsSql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_index',
						table: 'users',
						destructive: false,
						details: '',
						meta: { index: uniqueWithNulls },
					},
				]),
			);
			const withoutNullsSql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_index',
						table: 'users',
						destructive: false,
						details: '',
						meta: { index: uniqueWithoutNulls },
					},
				]),
			);
			const nonUniqueSql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_index',
						table: 'users',
						destructive: false,
						details: '',
						meta: { index: nonUniqueWithNulls },
					},
				]),
			);

			expect(withNullsSql[0]).toBe(
				'CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_email_unique" ON "users" ("email") NULLS NOT DISTINCT WHERE deleted_at IS NULL;',
			);
			expect(withoutNullsSql[0]).toBe(
				'CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_email_unique_plain" ON "users" ("email") WHERE deleted_at IS NULL;',
			);
			expect(nonUniqueSql[0]).toBe(
				'CREATE INDEX IF NOT EXISTS "idx_users_email_plain" ON "users" ("email");',
			);
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

			it('still rejects semicolon in index WHERE predicate', () => {
				const idx: IndexIR = {
					name: 'idx_users_active',
					columns: ['email'],
					where: 'active = true; DROP TABLE users',
				};

				let error: unknown;
				try {
					generateMigrationSQL(
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
				} catch (caught) {
					error = caught;
				}

				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toBe(
					'Unsafe SQL expression in index WHERE predicate: contains forbidden characters (;, --, /*, */, "$$" (dollar-quoted strings), \\). Value: "active = true; DROP TABLE users"',
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

			it('should place INCLUDE before NULLS NOT DISTINCT for unique indexes', () => {
				const idx: IndexIR = {
					name: 'idx_users_email_include_nulls',
					columns: ['email'],
					unique: true,
					nullsNotDistinct: true,
					include: ['id'],
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
					'CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_email_include_nulls" ON "users" ("email") INCLUDE ("id") NULLS NOT DISTINCT;',
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

		it('leaves expression-index drops unmanaged and emits no SQL', () => {
			const schemaTable = makeTable('users', [
				makeCol({ name: 'email', type: 'string' }),
			]);
			const dbTable: TableIR = {
				...schemaTable,
				indexes: [
					{
						name: 'idx_users_lower_email',
						columns: [],
						expressions: ['lower(email)'],
					},
				],
			};
			const diff = compareSchemata(
				new ModelIRImpl(new Map([['users', schemaTable]]), new Map()),
				new ModelIRImpl(new Map([['users', dbTable]]), new Map()),
			);

			expect(diff.changes).toEqual([]);
			expect(generateMigrationSQL(diff, { includeDestructive: false })).toEqual(
				[],
			);
			expect(generateMigrationSQL(diff, { includeDestructive: true })).toEqual(
				[],
			);
			expect(generateDownSQL(diff, { includeDestructive: false })).toEqual([]);
			expect(generateDownSQL(diff, { includeDestructive: true })).toEqual([]);
		});

		it('filters both halves of a unique NULLS NOT DISTINCT index replacement with the same name', () => {
			const schemaTable: TableIR = {
				...makeTable('users', [makeCol({ name: 'email', type: 'string' })]),
				indexes: [
					{
						name: 'idx_users_email',
						columns: ['email'],
						unique: true,
						nullsNotDistinct: true,
					},
				],
			};
			const dbTable: TableIR = {
				...makeTable('users', [makeCol({ name: 'email', type: 'string' })]),
				indexes: [
					{
						name: 'idx_users_email',
						columns: ['email'],
						unique: true,
					},
				],
			};

			const diff = compareSchemata(
				makeModel([schemaTable]),
				makeModel([dbTable]),
			);

			expect(diff.changes).toEqual([
				expect.objectContaining({
					kind: 'create_index',
					destructive: true,
				}),
				expect.objectContaining({
					kind: 'drop_index',
					destructive: true,
				}),
			]);
			expect(generateMigrationSQL(diff, { includeDestructive: false })).toEqual(
				[],
			);
			expect(generateDownSQL(diff, { includeDestructive: false })).toEqual([]);
			expect(generateMigrationSQL(diff, { includeDestructive: true })).toEqual([
				'DROP INDEX IF EXISTS "idx_users_email";',
				'CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_email" ON "users" ("email") NULLS NOT DISTINCT;',
			]);
		});

		it('keeps a differently named safe index create when a destructive drop is skipped', () => {
			const schemaTable: TableIR = {
				...makeTable('users', [
					makeCol({ name: 'email', type: 'string' }),
					makeCol({ name: 'active', type: 'boolean' }),
				]),
				indexes: [
					{
						name: 'idx_users_email_active',
						columns: ['email'],
						unique: false,
						where: 'active = true',
					},
				],
			};
			const dbTable: TableIR = {
				...makeTable('users', [
					makeCol({ name: 'email', type: 'string' }),
					makeCol({ name: 'active', type: 'boolean' }),
				]),
				indexes: [
					{
						name: 'idx_users_email_unique',
						columns: ['email'],
						unique: true,
					},
				],
			};

			const diff = compareSchemata(
				makeModel([schemaTable]),
				makeModel([dbTable]),
			);

			expect(diff.changes).toEqual([
				expect.objectContaining({
					kind: 'create_index',
					destructive: false,
				}),
				expect.objectContaining({
					kind: 'drop_index',
					destructive: true,
				}),
			]);
			expect(generateMigrationSQL(diff, { includeDestructive: false })).toEqual(
				[
					'CREATE INDEX IF NOT EXISTS "idx_users_email_active" ON "users" ("email") WHERE active = true;',
				],
			);
			expect(generateMigrationSQL(diff, { includeDestructive: true })).toEqual([
				'DROP INDEX IF EXISTS "idx_users_email_unique";',
				'CREATE INDEX IF NOT EXISTS "idx_users_email_active" ON "users" ("email") WHERE active = true;',
			]);
		});

		it('filters neither half of a non-unique index replacement when destructive changes are disabled', () => {
			const schemaTable: TableIR = {
				...makeTable('users', [makeCol({ name: 'email', type: 'string' })]),
				indexes: [
					{
						name: 'idx_users_email',
						columns: ['email'],
						method: 'hash',
					},
				],
			};
			const dbTable: TableIR = {
				...makeTable('users', [makeCol({ name: 'email', type: 'string' })]),
				indexes: [
					{
						name: 'idx_users_email',
						columns: ['email'],
					},
				],
			};

			const diff = compareSchemata(
				makeModel([schemaTable]),
				makeModel([dbTable]),
			);

			expect(diff.changes).toEqual([
				expect.objectContaining({
					kind: 'create_index',
					destructive: false,
				}),
				expect.objectContaining({
					kind: 'drop_index',
					destructive: false,
				}),
			]);
			expect(generateMigrationSQL(diff, { includeDestructive: false })).toEqual(
				[
					'DROP INDEX IF EXISTS "idx_users_email";',
					'CREATE INDEX IF NOT EXISTS "idx_users_email" ON "users" USING hash ("email");',
				],
			);
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
	describe('structured destructiveness', () => {
		it.each([
			{
				name: 'create_enum DOWN drops a type',
				change: {
					kind: 'create_enum',
					table: '',
					destructive: false,
					details: '',
					meta: { enum: { name: 'status', values: ['active'] } },
				},
				expectedSql: 'DROP TYPE IF EXISTS "status" CASCADE;',
			},
			{
				name: 'create_extension DOWN drops an extension',
				change: {
					kind: 'create_extension',
					table: '',
					destructive: false,
					details: '',
					meta: { extension: 'uuid-ossp' },
				},
				expectedSql: 'DROP EXTENSION IF EXISTS "uuid-ossp" CASCADE;',
			},
			{
				name: 'create_sequence DOWN drops a sequence',
				change: {
					kind: 'create_sequence',
					table: '',
					destructive: false,
					details: '',
					meta: { sequence: { name: 'order_seq' } },
				},
				expectedSql: 'DROP SEQUENCE IF EXISTS "order_seq" CASCADE;',
			},
			{
				name: 'enable_rls DOWN disables a security control',
				change: {
					kind: 'enable_rls',
					table: 'documents',
					destructive: false,
					details: '',
				},
				expectedSql: 'ALTER TABLE "documents" DISABLE ROW LEVEL SECURITY;',
			},
			{
				name: 'create_policy DOWN drops a security policy',
				change: {
					kind: 'create_policy',
					table: 'documents',
					destructive: false,
					details: '',
					meta: { policy: { name: 'tenant_isolation' } },
				},
				expectedSql: 'DROP POLICY IF EXISTS "tenant_isolation" ON "documents";',
			},
			{
				name: 'add_check_constraint DOWN removes a control',
				change: {
					kind: 'add_check_constraint',
					table: 'users',
					destructive: false,
					details: '',
					meta: {
						check: {
							name: 'users_age_check',
							expression: 'CHECK ((age > 0))',
						},
					},
				},
				expectedSql:
					'ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_age_check";',
			},
			{
				name: 'alter_column_unique true DOWN drops the unique constraint',
				change: {
					kind: 'alter_column_unique',
					table: 'users',
					column: 'email',
					destructive: false,
					details: '',
					meta: { unique: true },
				},
				expectedSql:
					'ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_key";',
			},
			{
				name: 'alter_column_unique true DOWN drops the recorded unique constraint',
				change: {
					kind: 'alter_column_unique',
					table: 'users',
					column: 'email',
					destructive: false,
					details: '',
					meta: {
						unique: true,
						constraintName: 'users_email_custom_uq',
					},
				},
				expectedSql:
					'ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_custom_uq";',
			},
		] satisfies Array<{
			name: string;
			change: SchemaChange;
			expectedSql: string;
		}>)('$name', ({ change, expectedSql }) => {
			const down = generateDownMigrationSQL(makeDiff([change]));

			expect(down.statements).toEqual([expectedSql]);
			expect(down.destructive).toBe(true);
		});

		it.each([
			{
				name: 'drop_comment DOWN re-adds the recorded comment',
				change: {
					kind: 'drop_comment',
					table: 'users',
					destructive: false,
					details: '',
					meta: { target: 'table', comment: 'User accounts' },
				},
				expectedSql: `COMMENT ON TABLE "users" IS 'User accounts';`,
			},
			{
				name: 'disable_rls DOWN re-enables a security control',
				change: {
					kind: 'disable_rls',
					table: 'documents',
					destructive: false,
					details: '',
				},
				expectedSql: 'ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;',
			},
			{
				name: 'drop_policy DOWN re-creates the recorded policy',
				change: {
					kind: 'drop_policy',
					table: 'documents',
					destructive: false,
					details: '',
					meta: { policy: { name: 'tenant_isolation' } },
				},
				expectedSql:
					'CREATE POLICY "tenant_isolation" ON "documents" FOR ALL AS PERMISSIVE;',
			},
			{
				name: 'alter_column_unique false DOWN adds the unique constraint',
				change: {
					kind: 'alter_column_unique',
					table: 'users',
					column: 'email',
					destructive: false,
					details: '',
					meta: { unique: false },
				},
				expectedSql:
					'ALTER TABLE "users" ADD CONSTRAINT "users_email_key" UNIQUE ("email");',
			},
			{
				name: 'alter_column_unique false DOWN restores the recorded unique constraint',
				change: {
					kind: 'alter_column_unique',
					table: 'users',
					column: 'email',
					destructive: false,
					details: '',
					meta: {
						unique: false,
						constraintName: 'users_email_custom_uq',
					},
				},
				expectedSql:
					'ALTER TABLE "users" ADD CONSTRAINT "users_email_custom_uq" UNIQUE ("email");',
			},
		] satisfies Array<{
			name: string;
			change: SchemaChange;
			expectedSql: string;
		}>)('$name', ({ change, expectedSql }) => {
			const down = generateDownMigrationSQL(makeDiff([change]));

			expect(down.statements).toEqual([expectedSql]);
			expect(down.destructive).toBe(false);
		});
	});

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

		it('rolls back a column type+default change restoring type before default', () => {
			// compareColumnDetails emits alter_column_type before alter_column_default.
			// The DOWN must restore the OLD type before the OLD default, or SET DEFAULT
			// would run against the still-new column type (e.g. SET DEFAULT 0 on a
			// boolean). Down-migration keeps forward order within the column phase.
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'alter_column_type',
						table: 'flags',
						column: 'enabled',
						destructive: true,
						details: '',
						meta: {
							fromType: 'integer',
							toType: 'boolean',
							column: makeCol({ name: 'enabled', type: 'boolean' }),
						},
					},
					{
						kind: 'alter_column_default',
						table: 'flags',
						column: 'enabled',
						destructive: false,
						details: '',
						meta: { default: 'false', oldDefault: '0' },
					},
				]),
			);

			expect(sql).toEqual([
				'ALTER TABLE "flags" ALTER COLUMN "enabled" TYPE integer;',
				`ALTER TABLE "flags" ALTER COLUMN "enabled" SET DEFAULT '0';`,
			]);
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

		it('compareSchemata PK change down restores previous primary key', () => {
			const schemaTable = makeTable(
				'users',
				[
					makeCol({ name: 'id', type: 'integer' }),
					makeCol({ name: 'code', type: 'string' }),
				],
				'code',
			);
			const dbTable = makeTable(
				'users',
				[
					makeCol({ name: 'id', type: 'integer' }),
					makeCol({ name: 'code', type: 'string' }),
				],
				'id',
			);
			const schema = new ModelIRImpl(
				new Map([['users', schemaTable]]),
				new Map(),
			);
			const db = new ModelIRImpl(new Map([['users', dbTable]]), new Map());

			const diff = compareSchemata(schema, db);
			const down = generateDownMigrationSQL(diff);

			expect(down.statements).toEqual([
				'ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "pk_users" CASCADE;',
				'ALTER TABLE "users" ADD CONSTRAINT "pk_users" PRIMARY KEY ("id");',
			]);
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

		it('drop_index with metadata recreates NULLS NOT DISTINCT only for unique indexes', () => {
			const uniqueWithNulls: IndexIR = {
				name: 'idx_users_email_unique',
				columns: ['email'],
				unique: true,
				nullsNotDistinct: true,
				where: 'deleted_at IS NULL',
			};
			const uniqueWithoutNulls: IndexIR = {
				name: 'idx_users_email_unique_plain',
				columns: ['email'],
				unique: true,
				where: 'deleted_at IS NULL',
			};
			const nonUniqueWithNulls: IndexIR = {
				name: 'idx_users_email_plain',
				columns: ['email'],
				nullsNotDistinct: true,
			};

			const withNullsSql = generateDownSQL(
				makeDiff([
					{
						kind: 'drop_index',
						table: 'users',
						destructive: false,
						details: '',
						meta: { index: uniqueWithNulls },
					},
				]),
			);
			const withoutNullsSql = generateDownSQL(
				makeDiff([
					{
						kind: 'drop_index',
						table: 'users',
						destructive: false,
						details: '',
						meta: { index: uniqueWithoutNulls },
					},
				]),
			);
			const nonUniqueSql = generateDownSQL(
				makeDiff([
					{
						kind: 'drop_index',
						table: 'users',
						destructive: false,
						details: '',
						meta: { index: nonUniqueWithNulls },
					},
				]),
			);

			expect(withNullsSql).toEqual([
				'CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_email_unique" ON "users" ("email") NULLS NOT DISTINCT WHERE deleted_at IS NULL;',
			]);
			expect(withoutNullsSql).toEqual([
				'CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_email_unique_plain" ON "users" ("email") WHERE deleted_at IS NULL;',
			]);
			expect(nonUniqueSql).toEqual([
				'CREATE INDEX IF NOT EXISTS "idx_users_email_plain" ON "users" ("email");',
			]);
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

		it('sanitizes newline payloads in DOWN warning comments', () => {
			const payload = 'x"\nDROP TABLE pwn;--';
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'drop_table',
						table: payload,
						destructive: true,
						details: '',
					},
					{
						kind: 'drop_column',
						table: payload,
						column: payload,
						destructive: true,
						details: '',
					},
				]),
			);

			const dropTableWarning = sql.find((statement) =>
				statement.includes('drop_table'),
			);
			const dropColumnWarning = sql.find((statement) =>
				statement.includes('drop_column'),
			);

			expect(dropTableWarning).toContain('x"DROP TABLE pwn;--');
			expect(dropColumnWarning).toContain(
				'"x"DROP TABLE pwn;--"."x"DROP TABLE pwn;--"',
			);
			for (const statement of sql) {
				expect(statement).not.toContain('\n');
				expect(statement).not.toContain('\r');
				for (const line of statement.split(/\r?\n/)) {
					expect(
						line.startsWith('--') || !line.includes('DROP TABLE pwn'),
					).toBe(true);
				}
			}

			const normalSql = generateDownSQL(
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
			expect(normalSql[0]).toContain('"users"."legacy"');
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

		it('drop_foreign_key without metadata → WARNING comment', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'drop_foreign_key',
						table: 'orders',
						destructive: true,
						details: '',
					},
				]),
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain('-- WARNING');
			expect(sql[0]).toContain('drop_foreign_key');
		});

		it('drop_index without metadata → WARNING comment', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'drop_index',
						table: 'users',
						destructive: false,
						details: '',
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

		it('emits an FK to a declared external table without creating that table', () => {
			const ordersTable = makeFullTable(
				'orders',
				[
					makeCol({ name: 'id', type: 'integer', autoIncrement: true }),
					makeCol({ name: 'tenant_id', type: 'integer', nullable: false }),
				],
				{
					pk: 'id',
					foreignKeys: [
						{
							columns: ['tenant_id'],
							references: { table: 'tenants', columns: ['id'] },
						},
					],
				},
			);
			const schema = new ModelIRImpl(
				new Map([['orders', ordersTable]]),
				new Map(),
				undefined,
				undefined,
				undefined,
				['tenants'],
			);
			const db = makeModel([]);

			const diff = compareSchemata(schema, db);
			const sql = generateMigrationSQL(diff);

			const fkSql = sql.find((statement) =>
				statement.startsWith('ALTER TABLE "orders" ADD CONSTRAINT'),
			);
			expect(fkSql).toBe(
				'ALTER TABLE "orders" ADD CONSTRAINT "fk_orders_tenant_id" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id");',
			);
			expect(
				sql.some((statement) => statement.includes('CREATE TABLE "tenants"')),
			).toBe(false);
		});

		it('wraps a bare CHECK predicate for a new table constraint', () => {
			const schema = makeModel([
				{
					...makeFullTable('payments', [
						makeCol({ name: 'id', type: 'integer', autoIncrement: true }),
						makeCol({ name: 'amount', type: 'number' }),
					]),
					checkConstraints: [
						{ name: 'payments_amount_check', expression: 'amount > 0' },
					],
				},
			]);
			const db = makeModel([]);

			const diff = compareSchemata(schema, db);
			const sql = generateMigrationSQL(diff);
			const checkSql = sql.find((statement) =>
				statement.includes('payments_amount_check'),
			);

			expect(checkSql).toBe(
				'DO $$ BEGIN ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_check" CHECK (amount > 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;',
			);
		});

		it('emits an FK to a declared referenced schema while keeping the owning table in the migration schema', () => {
			const ordersTable = makeFullTable(
				'orders',
				[
					makeCol({ name: 'id', type: 'integer', autoIncrement: true }),
					makeCol({ name: 'ext_id', type: 'integer', nullable: false }),
				],
				{
					pk: 'id',
					foreignKeys: [
						{
							columns: ['ext_id'],
							references: {
								schema: 'other',
								table: 'ext',
								columns: ['id'],
							},
						},
					],
				},
			);
			const schema = new ModelIRImpl(
				new Map([['orders', ordersTable]]),
				new Map(),
				undefined,
				undefined,
				undefined,
				['ext'],
			);
			const db = makeModel([]);

			const diff = compareSchemata(schema, db);
			const sql = generateMigrationSQL(diff, { schemaName: 'app' });
			const fkSql = sql.find((statement) =>
				statement.startsWith('ALTER TABLE "app"."orders" ADD CONSTRAINT'),
			);

			expect(fkSql).toBe(
				'ALTER TABLE "app"."orders" ADD CONSTRAINT "fk_orders_ext_id" FOREIGN KEY ("ext_id") REFERENCES "other"."ext" ("id");',
			);
		});

		it('keeps same-schema FK targets qualified with the migration schema', () => {
			const usersTable = makeFullTable(
				'users',
				[makeCol({ name: 'id', type: 'integer', autoIncrement: true })],
				{ pk: 'id' },
			);
			const ordersTable = makeFullTable(
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
			);
			const schema = makeModel([usersTable, ordersTable]);
			const db = makeModel([]);

			const diff = compareSchemata(schema, db);
			const sql = generateMigrationSQL(diff, { schemaName: 'app' });
			const fkSql = sql.find((statement) =>
				statement.startsWith('ALTER TABLE "app"."orders" ADD CONSTRAINT'),
			);

			expect(fkSql).toBe(
				'ALTER TABLE "app"."orders" ADD CONSTRAINT "fk_orders_user_id" FOREIGN KEY ("user_id") REFERENCES "app"."users" ("id");',
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
		it('should filter out destructive down statements when includeDestructive is false', () => {
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
						kind: 'alter_column_nullable',
						table: 'profiles',
						column: 'bio',
						destructive: false,
						details: '',
						meta: { oldNullable: true },
					},
				]),
				{ includeDestructive: false },
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toBe(
				'ALTER TABLE "profiles" ALTER COLUMN "bio" DROP NOT NULL;',
			);
		});

		it('skips DOWN for destructive drop_index changes skipped by UP', () => {
			const idx: IndexIR = {
				name: 'uq_users_email',
				columns: ['email'],
				unique: true,
			};
			const diff = makeDiff([
				{
					kind: 'drop_index',
					table: 'users',
					destructive: true,
					details: '',
					meta: { index: idx },
				},
			]);

			expect(generateMigrationSQL(diff, { includeDestructive: false })).toEqual(
				[],
			);
			expect(generateDownSQL(diff, { includeDestructive: false })).toEqual([]);
		});

		it('recreates a destructive dropped index when destructive changes are included', () => {
			const idx: IndexIR = {
				name: 'uq_users_email',
				columns: ['email'],
				unique: true,
			};
			const diff = makeDiff([
				{
					kind: 'drop_index',
					table: 'users',
					destructive: true,
					details: '',
					meta: { index: idx },
				},
			]);

			expect(generateMigrationSQL(diff, { includeDestructive: true })).toEqual([
				'DROP INDEX IF EXISTS "uq_users_email";',
			]);
			expect(generateDownSQL(diff, { includeDestructive: true })).toEqual([
				'CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_email" ON "users" ("email");',
			]);
		});

		it('skips DOWN for destructive drop_column changes skipped by UP', () => {
			const diff = makeDiff([
				{
					kind: 'drop_column',
					table: 'users',
					column: 'legacy',
					destructive: true,
					details: '',
				},
			]);

			expect(generateMigrationSQL(diff, { includeDestructive: false })).toEqual(
				[],
			);
			expect(generateDownSQL(diff, { includeDestructive: false })).toEqual([]);
		});

		it('filters alter_column_unique add from DOWN unless destructive changes are included', () => {
			const change: SchemaChange = {
				kind: 'alter_column_unique',
				table: 'users',
				column: 'email',
				destructive: false,
				details: '',
				meta: { unique: true },
			};

			const filtered = generateDownMigrationSQL(makeDiff([change]), {
				includeDestructive: false,
			});
			const included = generateDownMigrationSQL(makeDiff([change]), {
				includeDestructive: true,
			});

			expect(filtered.statements).toEqual([]);
			expect(filtered.destructive).toBe(false);
			expect(included.statements).toEqual([
				'ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_key";',
			]);
			expect(included.destructive).toBe(true);
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

	it('should generate ADD CHECK CONSTRAINT with escaped semicolon and comment literals', () => {
		const diff = makeDiff([
			{
				kind: 'add_check_constraint',
				table: 'users',
				destructive: false,
				details: 'Add CHECK',
				meta: {
					check: {
						name: 'users_status_check',
						expression: "CHECK (status IN ('a;b', 'c--d'))",
					},
				},
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toEqual([
			`DO $$ BEGIN ALTER TABLE "users" ADD CONSTRAINT "users_status_check" CHECK (status IN ('a;b', 'c--d')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
		]);
	});

	it('should generate ADD CHECK CONSTRAINT with canonical ANY array string literals', () => {
		const diff = makeDiff([
			{
				kind: 'add_check_constraint',
				table: 'users',
				destructive: false,
				details: 'Add CHECK',
				meta: {
					check: {
						name: 'users_status_any_check',
						expression:
							"CHECK (status = ANY (ARRAY['a;b'::text, 'c/*x*/d'::text]))",
					},
				},
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toEqual([
			`DO $$ BEGIN ALTER TABLE "users" ADD CONSTRAINT "users_status_any_check" CHECK (status = ANY (ARRAY['a;b'::text, 'c/*x*/d'::text])); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
		]);
	});

	it('should generate ADD CHECK CONSTRAINT with doubled single quote literal', () => {
		const diff = makeDiff([
			{
				kind: 'add_check_constraint',
				table: 'users',
				destructive: false,
				details: 'Add CHECK',
				meta: {
					check: {
						name: 'users_note_check',
						expression: "CHECK (note = 'it''s')",
					},
				},
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toEqual([
			`DO $$ BEGIN ALTER TABLE "users" ADD CONSTRAINT "users_note_check" CHECK (note = 'it''s'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
		]);
	});

	it('should generate ADD CHECK CONSTRAINT with safe dollar-quoted literal', () => {
		const diff = makeDiff([
			{
				kind: 'add_check_constraint',
				table: 'users',
				destructive: false,
				details: 'Add CHECK',
				meta: {
					check: {
						name: 'users_note_check',
						expression: 'CHECK (note = $$a;b$$)',
					},
				},
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toEqual([
			'DO $dbsp_check$ BEGIN ALTER TABLE "users" ADD CONSTRAINT "users_note_check" CHECK (note = $$a;b$$); EXCEPTION WHEN duplicate_object THEN NULL; END $dbsp_check$;',
		]);
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
		const diff = makeDiff([
			{
				kind: 'create_enum',
				table: '',
				destructive: false,
				details: 'Create enum',
				meta: { enum: { name: 'status', values: ['active', 'inactive'] } },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toBe(
			"CREATE TYPE \"status\" AS ENUM ('active', 'inactive');",
		);
	});

	it('should generate CREATE TYPE with schema prefix', () => {
		const diff = makeDiff([
			{
				kind: 'create_enum',
				table: '',
				destructive: false,
				details: 'Create enum',
				meta: { enum: { name: 'status', values: ['active', 'inactive'] } },
			},
		]);
		const sql = generateMigrationSQL(diff, { schemaName: 'myschema' });
		expect(sql[0]).toBe(
			'CREATE TYPE "myschema"."status" AS ENUM (\'active\', \'inactive\');',
		);
	});

	it('should let schemaName win over EnumIR.schema for schema-qualified enum operations', () => {
		const diff = makeDiff([
			{
				kind: 'create_enum',
				table: '',
				destructive: false,
				details: 'Create enum',
				meta: {
					enum: {
						name: 'status',
						schema: 'select',
						values: ['active', 'inactive'],
					},
				},
			},
			{
				kind: 'alter_enum_add_value',
				table: '',
				destructive: false,
				details: 'Add enum value',
				meta: {
					enum: {
						name: 'status',
						schema: 'select',
						values: ['active', 'inactive', 'pending'],
					},
					value: 'pending',
					after: 'inactive',
				},
			},
			{
				kind: 'drop_enum',
				table: '',
				destructive: true,
				details: 'Drop enum',
				meta: {
					enum: {
						name: 'status',
						schema: 'select',
						values: ['active', 'inactive'],
					},
				},
			},
		]);

		const sql = generateMigrationSQL(diff, { schemaName: 'ignored' });
		expect(sql).toEqual([
			'DROP TYPE IF EXISTS "ignored"."status" CASCADE;',
			'CREATE TYPE "ignored"."status" AS ENUM (\'active\', \'inactive\');',
			'ALTER TYPE "ignored"."status" ADD VALUE IF NOT EXISTS \'pending\' AFTER \'inactive\';',
		]);
	});

	it('should use explicit schemaName for enum DOWN SQL', () => {
		const diff = makeDiff([
			{
				kind: 'create_enum',
				table: '',
				destructive: false,
				details: 'Create enum',
				meta: {
					enum: {
						name: 'status',
						schema: 'tenant_1',
						values: ['active', 'inactive'],
					},
				},
			},
		]);

		expect(generateDownSQL(diff, { schemaName: 'tenant_1' })).toEqual([
			'DROP TYPE IF EXISTS "tenant_1"."status" CASCADE;',
		]);
	});

	it('should escape single quotes in enum values', () => {
		const diff = makeDiff([
			{
				kind: 'create_enum',
				table: '',
				destructive: false,
				details: 'Create enum',
				meta: { enum: { name: 'mood', values: ["it's fine", 'bad'] } },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toBe("CREATE TYPE \"mood\" AS ENUM ('it''s fine', 'bad');");
	});

	it('should generate ALTER TYPE ADD VALUE with position', () => {
		const diff = makeDiff([
			{
				kind: 'alter_enum_add_value',
				table: '',
				destructive: false,
				details: 'Add value',
				meta: {
					enum: { name: 'status', values: ['active', 'inactive', 'pending'] },
					value: 'pending',
					after: 'inactive',
				},
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toBe(
			"ALTER TYPE \"status\" ADD VALUE IF NOT EXISTS 'pending' AFTER 'inactive';",
		);
	});

	it('should generate ALTER TYPE ADD VALUE without position', () => {
		const diff = makeDiff([
			{
				kind: 'alter_enum_add_value',
				table: '',
				destructive: false,
				details: 'Add value',
				meta: {
					enum: { name: 'status', values: ['active', 'pending'] },
					value: 'pending',
					after: undefined,
				},
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toBe(
			'ALTER TYPE "status" ADD VALUE IF NOT EXISTS \'pending\';',
		);
	});

	it('should generate DROP TYPE for removed enum', () => {
		const diff = makeDiff([
			{
				kind: 'drop_enum',
				table: '',
				destructive: true,
				details: 'Drop enum',
				meta: { enum: { name: 'status', values: ['active', 'inactive'] } },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toBe('DROP TYPE IF EXISTS "status" CASCADE;');
	});

	it('should emit ALTER TABLE ... TYPE text before DROP TYPE when columns reference the enum', () => {
		const diff = makeDiff([
			{
				kind: 'drop_enum',
				table: '',
				destructive: true,
				details: 'Drop enum "status"',
				meta: {
					enum: { name: 'status', values: ['active', 'inactive'] },
					referencingColumns: [
						{ table: 'users', column: 'status' },
						{ table: 'orders', column: 'state' },
					],
				},
			},
		]);
		const sql = generateMigrationSQL(diff);
		// Single statement entry (joined with \n)
		expect(sql).toHaveLength(1);
		const lines = sql[0]!.split('\n');
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe(
			'ALTER TABLE "users" ALTER COLUMN "status" TYPE text;',
		);
		expect(lines[1]).toBe(
			'ALTER TABLE "orders" ALTER COLUMN "state" TYPE text;',
		);
		expect(lines[2]).toBe('DROP TYPE IF EXISTS "status" CASCADE;');
	});

	it('should cast an array-typed referencing column to text[] with USING before DROP TYPE', () => {
		const diff = makeDiff([
			{
				kind: 'drop_enum',
				table: '',
				destructive: true,
				details: 'Drop enum "status"',
				meta: {
					enum: { name: 'status', values: ['active', 'inactive'] },
					referencingColumns: [
						{ table: 'users', column: 'status' },
						{ table: 'users', column: 'history', isArray: true },
					],
				},
			},
		]);
		const sql = generateMigrationSQL(diff);
		const lines = sql[0]!.split('\n');
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe(
			'ALTER TABLE "users" ALTER COLUMN "status" TYPE text;',
		);
		expect(lines[1]).toBe(
			'ALTER TABLE "users" ALTER COLUMN "history" TYPE text[] USING "history"::text[];',
		);
		expect(lines[2]).toBe('DROP TYPE IF EXISTS "status" CASCADE;');
	});

	it('should emit ALTER TABLE with schema prefix before DROP TYPE when schema is set', () => {
		const diff = makeDiff([
			{
				kind: 'drop_enum',
				table: '',
				destructive: true,
				details: 'Drop enum "status"',
				meta: {
					enum: { name: 'status', values: ['active'] },
					referencingColumns: [{ table: 'users', column: 'status' }],
				},
			},
		]);
		const sql = generateMigrationSQL(diff, { schemaName: 'myschema' });
		const lines = sql[0]!.split('\n');
		expect(lines[0]).toBe(
			'ALTER TABLE "myschema"."users" ALTER COLUMN "status" TYPE text;',
		);
		expect(lines[1]).toBe('DROP TYPE IF EXISTS "myschema"."status" CASCADE;');
	});

	it('should emit plain DROP TYPE when referencingColumns is empty', () => {
		const diff = makeDiff([
			{
				kind: 'drop_enum',
				table: '',
				destructive: true,
				details: 'Drop enum "status"',
				meta: {
					enum: { name: 'status', values: ['active'] },
					referencingColumns: [],
				},
			},
		]);
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
				meta: {
					enum: { name: 'status', values: ['a', 'b'] },
					value: 'b',
					after: 'a',
				},
			},
			{
				kind: 'create_index',
				table: 'users',
				destructive: false,
				details: '',
				meta: {
					index: { name: 'idx_users_name', columns: ['name'], unique: false },
				},
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
			const diff = makeDiff([
				{
					kind: 'create_enum',
					table: '',
					destructive: false,
					details: '',
					meta: { enum: { name: 'status', values: ['a', 'b'] } },
				},
			]);
			const sql = generateDownSQL(diff);
			expect(sql[0]).toBe('DROP TYPE IF EXISTS "status" CASCADE;');
		});

		it('drop_enum DOWN should recreate the type', () => {
			const diff = makeDiff([
				{
					kind: 'drop_enum',
					table: '',
					destructive: true,
					details: '',
					meta: { enum: { name: 'status', values: ['active', 'inactive'] } },
				},
			]);
			const sql = generateDownSQL(diff);
			expect(sql[0]).toBe(
				"CREATE TYPE \"status\" AS ENUM ('active', 'inactive');",
			);
		});

		it('alter_enum_add_value DOWN should emit a comment', () => {
			const diff = makeDiff([
				{
					kind: 'alter_enum_add_value',
					table: '',
					destructive: false,
					details: '',
					meta: {
						enum: { name: 'status', values: ['a', 'b'] },
						value: 'b',
						after: 'a',
					},
				},
			]);
			const sql = generateDownSQL(diff);
			expect(sql[0]).toContain('cannot be reversed');
		});
	});

	describe('drop_enum column dependency check (end-to-end via compareSchemata)', () => {
		function makeModelWithEnumsAndTables(
			tables: TableIR[],
			enums: Map<string, EnumIR>,
		): ModelIRImpl {
			return new ModelIRImpl(
				new Map(tables.map((t) => [t.name, t])),
				new Map(),
				enums,
			);
		}

		it('emits ALTER TABLE TYPE text before DROP TYPE when a DB column references the enum', () => {
			// Schema has no enum "status" → DB still has it with a referencing column
			const dbTable = makeTable('users', [
				makeCol({ name: 'id', type: 'integer' }),
				makeCol({ name: 'status', type: 'string', originalDbType: 'status' }),
			]);
			const schemaModel = new ModelIRImpl(new Map(), new Map());
			const dbModel = makeModelWithEnumsAndTables(
				[dbTable],
				new Map<string, EnumIR>([
					['status', { name: 'status', values: ['active', 'inactive'] }],
				]),
			);

			const diff = compareSchemata(schemaModel, dbModel);
			const sql = generateMigrationSQL(diff);

			const dropTypeIdx = sql.findIndex((s) => s.includes('DROP TYPE'));
			expect(dropTypeIdx).toBeGreaterThanOrEqual(0);

			// The DROP TYPE statement entry must contain an ALTER TABLE before it
			const dropEntry = sql[dropTypeIdx]!;
			const lines = dropEntry.split('\n');
			expect(lines.length).toBeGreaterThan(1);
			expect(lines[0]).toBe(
				'ALTER TABLE "users" ALTER COLUMN "status" TYPE text;',
			);
			expect(lines[lines.length - 1]).toBe(
				'DROP TYPE IF EXISTS "status" CASCADE;',
			);
		});

		it('emits plain DROP TYPE when no DB column references the enum', () => {
			const dbTable = makeTable('users', [
				makeCol({ name: 'id', type: 'integer' }),
				makeCol({ name: 'name', type: 'string' }),
			]);
			const schemaModel = new ModelIRImpl(new Map(), new Map());
			const dbModel = makeModelWithEnumsAndTables(
				[dbTable],
				new Map<string, EnumIR>([
					['old_status', { name: 'old_status', values: ['x'] }],
				]),
			);

			const diff = compareSchemata(schemaModel, dbModel);
			const sql = generateMigrationSQL(diff);

			const dropTypeIdx = sql.findIndex((s) => s.includes('DROP TYPE'));
			expect(dropTypeIdx).toBeGreaterThanOrEqual(0);
			expect(sql[dropTypeIdx]).toBe(
				'DROP TYPE IF EXISTS "old_status" CASCADE;',
			);
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
		const diff = makeDiff([
			{
				kind: 'add_foreign_key',
				table: 'orders',
				destructive: false,
				details: '',
				meta: { fk: { ...baseFk, onUpdate: 'CASCADE' } },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toContain('ON UPDATE CASCADE');
	});

	it('should generate DEFERRABLE INITIALLY DEFERRED', () => {
		const diff = makeDiff([
			{
				kind: 'add_foreign_key',
				table: 'orders',
				destructive: false,
				details: '',
				meta: { fk: { ...baseFk, deferred: true } },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toContain('DEFERRABLE INITIALLY DEFERRED');
	});

	it('should generate combined ON DELETE + ON UPDATE + DEFERRABLE', () => {
		const diff = makeDiff([
			{
				kind: 'add_foreign_key',
				table: 'orders',
				destructive: false,
				details: '',
				meta: {
					fk: {
						...baseFk,
						onDelete: 'CASCADE',
						onUpdate: 'SET NULL',
						deferred: true,
					},
				},
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toContain('ON DELETE CASCADE');
		expect(sql[0]).toContain('ON UPDATE SET NULL');
		expect(sql[0]).toContain('DEFERRABLE INITIALLY DEFERRED');
	});

	it('should NOT emit ON UPDATE when onUpdate is absent', () => {
		const diff = makeDiff([
			{
				kind: 'add_foreign_key',
				table: 'orders',
				destructive: false,
				details: '',
				meta: { fk: baseFk },
			},
		]);
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
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'orders',
				destructive: false,
				details: '',
				meta: { table: tableWithFk },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(
			sql.some((s) => s.includes('CREATE INDEX') && s.includes('"user_id"')),
		).toBe(true);
	});

	it('should use the same database-form FK auto-index name as generateDDL', () => {
		const usersTable: TableIR = {
			name: 'users',
			columns: [makeCol({ name: 'id', type: 'integer' })],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
		};
		const postsTable: TableIR = {
			name: 'posts',
			columns: [
				makeCol({ name: 'id', type: 'integer' }),
				makeCol({ name: 'authorId', type: 'integer' }),
			],
			primaryKey: 'id',
			foreignKeys: [
				{
					columns: ['authorId'],
					references: { table: 'users', columns: ['id'] },
				},
			],
			indexes: [],
		};
		const schema = new ModelIRImpl(
			new Map([
				['users', usersTable],
				['posts', postsTable],
			]),
			new Map(),
		);

		const ddl = generateDDL(schema, { naming: camelCaseNaming });
		const diff = compareSchemata(
			schema,
			new ModelIRImpl(new Map(), new Map()),
			{
				dbCasing: 'snake_case',
			},
		);
		const sql = generateMigrationSQL(diff);

		expect(ddl).toContain(
			'CREATE INDEX "idx_posts_author_id" ON "posts" ("author_id");',
		);
		expect(sql).toContain(
			'CREATE INDEX IF NOT EXISTS "idx_posts_author_id" ON "posts" ("author_id");',
		);
	});

	it('should NOT generate FK auto-index when fkAutoIndex=false', () => {
		const table = makeTable('orders', [
			makeCol({ name: 'user_id', type: 'integer' }),
		]);
		const tableWithFk: TableIR = {
			...table,
			foreignKeys: [baseFk],
		};
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'orders',
				destructive: false,
				details: '',
				meta: { table: tableWithFk },
			},
		]);
		const sql = generateMigrationSQL(diff, { fkAutoIndex: false });
		expect(
			sql.some((s) => s.includes('CREATE INDEX') && s.includes('"user_id"')),
		).toBe(false);
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
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'orders',
				destructive: false,
				details: '',
				meta: { table: tableWithFk },
			},
		]);
		const sql = generateMigrationSQL(diff);
		const autoIndexCount = sql.filter(
			(s) => s.includes('CREATE INDEX') && s.includes('"user_id"'),
		).length;
		// Only the explicit index from create_index phase (none here), no duplicates
		expect(autoIndexCount).toBe(0);
	});

	it('should not generate FK auto-index when only a partial index covers the FK column', () => {
		const usersTable = makeTable(
			'users',
			[makeCol({ name: 'id', type: 'integer' })],
			'id',
		);
		const ordersTable: TableIR = {
			...makeTable(
				'orders',
				[
					makeCol({ name: 'id', type: 'integer' }),
					makeCol({ name: 'user_id', type: 'integer' }),
					makeCol({ name: 'deleted_at', type: 'timestamp', nullable: true }),
				],
				'id',
			),
			foreignKeys: [baseFk],
			indexes: [
				{
					name: 'idx_orders_user_id_active',
					columns: ['user_id'],
					where: 'deleted_at IS NULL',
				},
			],
		};
		const diff = compareSchemata(
			new ModelIRImpl(
				new Map([
					['users', usersTable],
					['orders', ordersTable],
				]),
				new Map(),
			),
			new ModelIRImpl(new Map(), new Map()),
		);

		const sql = generateMigrationSQL(diff);

		expect(sql).toContain(
			'CREATE INDEX IF NOT EXISTS "idx_orders_user_id_active" ON "orders" ("user_id") WHERE deleted_at IS NULL;',
		);
		expect(sql).not.toContain(
			'CREATE INDEX IF NOT EXISTS "idx_orders_user_id" ON "orders" ("user_id");',
		);
	});

	it('should not generate FK auto-index when explicit FK index uses nullsNotDistinct', () => {
		const table = makeTable('orders', [
			makeCol({ name: 'user_id', type: 'integer' }),
		]);
		const tableWithFk: TableIR = {
			...table,
			foreignKeys: [baseFk],
			indexes: [
				{
					name: 'uk_orders_user_id_nulls',
					columns: ['user_id'],
					unique: true,
					nullsNotDistinct: true,
				},
			],
		};
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'orders',
				destructive: false,
				details: '',
				meta: { table: tableWithFk },
			},
		]);

		const sql = generateMigrationSQL(diff);

		expect(
			sql.filter((s) => s.includes('CREATE INDEX') && s.includes('"user_id"')),
		).toEqual([]);
	});
});

// ============================================================================
// Block 5: Column Enhancements — collation, identity, comments
// ============================================================================

describe('Column enhancements — migration SQL', () => {
	it('should generate ALTER COLUMN TYPE with COLLATE', () => {
		const col = makeCol({ name: 'name', type: 'string', collation: 'en_US' });
		const diff = makeDiff([
			{
				kind: 'alter_column_collation',
				table: 'users',
				column: 'name',
				destructive: false,
				details: '',
				meta: { column: col },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toContain('ALTER COLUMN "name" TYPE');
		expect(sql[0]).toContain('COLLATE "en_US"');
	});

	it('should generate ADD GENERATED ALWAYS AS IDENTITY', () => {
		const col = makeCol({ name: 'id', type: 'integer', identity: 'always' });
		const diff = makeDiff([
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
		expect(sql).toHaveLength(1);
		expect(sql[0]).toContain('ADD GENERATED ALWAYS AS IDENTITY');
	});

	it('should generate DROP IDENTITY IF EXISTS', () => {
		const col = makeCol({ name: 'id', type: 'integer' });
		const diff = makeDiff([
			{
				kind: 'alter_column_identity',
				table: 'users',
				column: 'id',
				destructive: false,
				details: '',
				meta: { column: col, previousIdentity: 'always' },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toContain('DROP IDENTITY IF EXISTS');
	});

	it('should generate SET GENERATED BY DEFAULT for identity type change', () => {
		const col = makeCol({ name: 'id', type: 'integer', identity: 'byDefault' });
		const diff = makeDiff([
			{
				kind: 'alter_column_identity',
				table: 'users',
				column: 'id',
				destructive: false,
				details: '',
				meta: { column: col, previousIdentity: 'always' },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toContain('SET GENERATED BY DEFAULT');
	});

	it('should generate COMMENT ON TABLE', () => {
		const diff = makeDiff([
			{
				kind: 'add_comment',
				table: 'users',
				destructive: false,
				details: '',
				meta: { comment: 'User accounts', target: 'table' },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toMatch(/COMMENT ON TABLE "users" IS 'User accounts'/);
	});

	it('should generate COMMENT ON COLUMN', () => {
		const diff = makeDiff([
			{
				kind: 'add_comment',
				table: 'users',
				column: 'email',
				destructive: false,
				details: '',
				meta: { comment: 'Primary email', target: 'column' },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toMatch(
			/COMMENT ON COLUMN "users"\."email" IS 'Primary email'/,
		);
	});

	it('should generate COMMENT IS NULL for drop_comment on table', () => {
		const diff = makeDiff([
			{
				kind: 'drop_comment',
				table: 'users',
				destructive: false,
				details: '',
				meta: { target: 'table' },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toMatch(/COMMENT ON TABLE "users" IS NULL/);
	});

	it('should generate COMMENT IS NULL for drop_comment on column', () => {
		const diff = makeDiff([
			{
				kind: 'drop_comment',
				table: 'users',
				column: 'email',
				destructive: false,
				details: '',
				meta: { target: 'column' },
			},
		]);
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
		const diff = makeDiff([
			{
				kind: 'add_comment',
				table: 'users',
				destructive: false,
				details: '',
				meta: { comment: "O'Brien's table", target: 'table' },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toContain("O''Brien''s table");
	});

	it('should apply schema prefix to comment statements', () => {
		const diff = makeDiff([
			{
				kind: 'add_comment',
				table: 'users',
				destructive: false,
				details: '',
				meta: { comment: 'Scoped table', target: 'table' },
			},
		]);
		const sql = generateMigrationSQL(diff, { schemaName: 'myschema' });
		expect(sql[0]).toContain('"myschema"."users"');
	});
});

// ============================================================================
// Extensions
// ============================================================================

describe('Extensions — migration SQL', () => {
	it('should generate CREATE EXTENSION IF NOT EXISTS', () => {
		const diff = makeDiff([
			{
				kind: 'create_extension',
				table: '',
				destructive: false,
				details: 'Create extension "uuid-ossp"',
				meta: { extension: 'uuid-ossp' },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toBe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
	});

	it('should generate DROP EXTENSION IF EXISTS CASCADE', () => {
		const diff = makeDiff([
			{
				kind: 'drop_extension',
				table: '',
				destructive: true,
				details: 'Drop extension "uuid-ossp"',
				meta: { extension: 'uuid-ossp' },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toBe('DROP EXTENSION IF EXISTS "uuid-ossp" CASCADE;');
	});

	it('should order create_extension before create_table (phase 5 vs 6)', () => {
		const tableIR: TableIR = {
			name: 'users',
			columns: [{ name: 'id', type: 'integer', nullable: false }],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
		};
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'users',
				destructive: false,
				details: 'Create table',
				meta: { table: tableIR },
			},
			{
				kind: 'create_extension',
				table: '',
				destructive: false,
				details: 'Create extension',
				meta: { extension: 'pgcrypto' },
			},
		]);
		const sql = generateMigrationSQL(diff);
		const extIdx = sql.findIndex((s) => s.includes('CREATE EXTENSION'));
		const tableIdx = sql.findIndex((s) => s.includes('CREATE TABLE'));
		expect(extIdx).toBeLessThan(tableIdx);
	});

	it('should generate DOWN SQL: create_extension reverses to DROP EXTENSION', () => {
		const diff = makeDiff([
			{
				kind: 'create_extension',
				table: '',
				destructive: false,
				details: '',
				meta: { extension: 'uuid-ossp' },
			},
		]);
		const sql = generateDownSQL(diff);
		expect(sql[0]).toBe('DROP EXTENSION IF EXISTS "uuid-ossp" CASCADE;');
	});

	it('should generate DOWN SQL: drop_extension reverses to CREATE EXTENSION', () => {
		const diff = makeDiff([
			{
				kind: 'drop_extension',
				table: '',
				destructive: true,
				details: '',
				meta: { extension: 'uuid-ossp' },
			},
		]);
		const sql = generateDownSQL(diff);
		expect(sql[0]).toBe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
	});
});

// ============================================================================
// Sequences
// ============================================================================

describe('Sequences — migration SQL', () => {
	it('should generate CREATE SEQUENCE with all options', () => {
		const seq: SequenceIR = {
			name: 'order_seq',
			startWith: 100,
			incrementBy: 5,
			minValue: 1,
			maxValue: 9999,
			cycle: true,
		};
		const diff = makeDiff([
			{
				kind: 'create_sequence',
				table: '',
				destructive: false,
				details: '',
				meta: { sequence: seq },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toBe(
			'CREATE SEQUENCE "order_seq" START WITH 100 INCREMENT BY 5 MINVALUE 1 MAXVALUE 9999 CYCLE;',
		);
	});

	it('should generate CREATE SEQUENCE without options', () => {
		const seq: SequenceIR = { name: 'simple_seq' };
		const diff = makeDiff([
			{
				kind: 'create_sequence',
				table: '',
				destructive: false,
				details: '',
				meta: { sequence: seq },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toBe('CREATE SEQUENCE "simple_seq";');
	});

	it('should generate CREATE SEQUENCE with schema prefix', () => {
		const seq: SequenceIR = { name: 'order_seq', startWith: 1 };
		const diff = makeDiff([
			{
				kind: 'create_sequence',
				table: '',
				destructive: false,
				details: '',
				meta: { sequence: seq },
			},
		]);
		const sql = generateMigrationSQL(diff, { schemaName: 'myschema' });
		expect(sql[0]).toBe('CREATE SEQUENCE "myschema"."order_seq" START WITH 1;');
	});

	it('should accept strict numeric strings in sequence options', () => {
		const seq: SequenceIR = {
			name: 'order_seq',
			startWith: '1' as unknown as number,
			incrementBy: '-5' as unknown as number,
		};
		const diff = makeDiff([
			{
				kind: 'create_sequence',
				table: '',
				destructive: false,
				details: '',
				meta: { sequence: seq },
			},
		]);

		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toBe(
			'CREATE SEQUENCE "order_seq" START WITH 1 INCREMENT BY -5;',
		);
	});

	it('rejects forged non-number sequence numeric fields before emission', () => {
		const forgedStart = {
			toString: () => '1; DROP TABLE users; --',
		};
		const seq: SequenceIR = {
			name: 'order_seq',
			startWith: forgedStart as unknown as number,
		};
		const diff = makeDiff([
			{
				kind: 'create_sequence',
				table: '',
				destructive: false,
				details: '',
				meta: { sequence: seq },
			},
		]);

		expect(() => generateMigrationSQL(diff)).toThrow(
			/sequence START WITH: expected a finite number or numeric string, received object/,
		);
	});

	it('should generate ALTER SEQUENCE', () => {
		const seq: SequenceIR = {
			name: 'order_seq',
			incrementBy: 10,
			cycle: false,
		};
		const diff = makeDiff([
			{
				kind: 'alter_sequence',
				table: '',
				destructive: false,
				details: '',
				meta: { sequence: seq },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toBe('ALTER SEQUENCE "order_seq" INCREMENT BY 10 NO CYCLE;');
	});

	it('should generate ALTER SEQUENCE with CYCLE', () => {
		const seq: SequenceIR = { name: 'order_seq', cycle: true };
		const diff = makeDiff([
			{
				kind: 'alter_sequence',
				table: '',
				destructive: false,
				details: '',
				meta: { sequence: seq },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toBe('ALTER SEQUENCE "order_seq" CYCLE;');
	});

	it('should generate DROP SEQUENCE IF EXISTS CASCADE', () => {
		const seq: SequenceIR = { name: 'order_seq' };
		const diff = makeDiff([
			{
				kind: 'drop_sequence',
				table: '',
				destructive: true,
				details: '',
				meta: { sequence: seq },
			},
		]);
		const sql = generateMigrationSQL(diff);
		expect(sql[0]).toBe('DROP SEQUENCE IF EXISTS "order_seq" CASCADE;');
	});

	it('should order create_sequence before create_table (phase 5 vs 6)', () => {
		const tableIR: TableIR = {
			name: 'users',
			columns: [{ name: 'id', type: 'integer', nullable: false }],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
		};
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'users',
				destructive: false,
				details: 'Create table',
				meta: { table: tableIR },
			},
			{
				kind: 'create_sequence',
				table: '',
				destructive: false,
				details: 'Create sequence',
				meta: { sequence: { name: 'order_seq' } },
			},
		]);
		const sql = generateMigrationSQL(diff);
		const seqIdx = sql.findIndex((s) => s.includes('CREATE SEQUENCE'));
		const tableIdx = sql.findIndex((s) => s.includes('CREATE TABLE'));
		expect(seqIdx).toBeLessThan(tableIdx);
	});

	it('should generate DOWN SQL: create_sequence reverses to DROP SEQUENCE', () => {
		const seq: SequenceIR = { name: 'order_seq' };
		const diff = makeDiff([
			{
				kind: 'create_sequence',
				table: '',
				destructive: false,
				details: '',
				meta: { sequence: seq },
			},
		]);
		const sql = generateDownSQL(diff);
		expect(sql[0]).toBe('DROP SEQUENCE IF EXISTS "order_seq" CASCADE;');
	});

	it('should generate DOWN SQL: drop_sequence reverses to CREATE SEQUENCE', () => {
		const seq: SequenceIR = { name: 'order_seq', startWith: 1, incrementBy: 5 };
		const diff = makeDiff([
			{
				kind: 'drop_sequence',
				table: '',
				destructive: true,
				details: '',
				meta: { sequence: seq },
			},
		]);
		const sql = generateDownSQL(diff);
		expect(sql[0]).toBe(
			'CREATE SEQUENCE "order_seq" START WITH 1 INCREMENT BY 5;',
		);
	});

	it('should generate DOWN SQL: alter_sequence reverses to previous state', () => {
		const prevSeq: SequenceIR = { name: 'order_seq', incrementBy: 1 };
		const diff = makeDiff([
			{
				kind: 'alter_sequence',
				table: '',
				destructive: false,
				details: '',
				meta: {
					sequence: { name: 'order_seq', incrementBy: 10 },
					previousSequence: prevSeq,
				},
			},
		]);
		const sql = generateDownSQL(diff);
		expect(sql[0]).toBe('ALTER SEQUENCE "order_seq" INCREMENT BY 1;');
	});
});

// ============================================================================
// Partitioning SQL Tests
// ============================================================================

describe('Partitioning', () => {
	function makePartitionedTableIR(
		name: string,
		partition: PartitionIR,
	): TableIR {
		return {
			name,
			columns: [
				{ name: 'id', type: 'integer', nullable: false },
				{ name: 'created_at', type: 'timestamp', nullable: false },
			],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
			partition,
		};
	}

	it('should generate PARTITION BY RANGE in CREATE TABLE', () => {
		const table = makePartitionedTableIR('events', {
			strategy: 'RANGE',
			columns: ['created_at'],
		});
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'events',
				destructive: false,
				details: '',
				meta: { table },
			},
		]);
		const sql = generateMigrationSQL(diff);
		const createSql = sql.find((s) => s.includes('CREATE TABLE'));
		expect(createSql).toBeDefined();
		expect(createSql).toContain('PARTITION BY RANGE ("created_at")');
		expect(createSql).toMatch(/\)\s+PARTITION BY RANGE/);
		expect(createSql).toMatch(/PARTITION BY RANGE \("created_at"\);$/);
	});

	it('should generate PARTITION BY LIST in CREATE TABLE', () => {
		const table = makePartitionedTableIR('orders', {
			strategy: 'LIST',
			columns: ['region'],
		});
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'orders',
				destructive: false,
				details: '',
				meta: { table },
			},
		]);
		const sql = generateMigrationSQL(diff);
		const createSql = sql.find((s) => s.includes('CREATE TABLE'));
		expect(createSql).toContain('PARTITION BY LIST ("region")');
	});

	it('should generate PARTITION BY HASH in CREATE TABLE', () => {
		const table = makePartitionedTableIR('logs', {
			strategy: 'HASH',
			columns: ['id'],
		});
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'logs',
				destructive: false,
				details: '',
				meta: { table },
			},
		]);
		const sql = generateMigrationSQL(diff);
		const createSql = sql.find((s) => s.includes('CREATE TABLE'));
		expect(createSql).toContain('PARTITION BY HASH ("id")');
	});

	it('should not emit PARTITION BY for non-partitioned tables', () => {
		const table = makeTable('users', [
			makeCol({ name: 'id', type: 'integer' }),
		]);
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'users',
				destructive: false,
				details: '',
				meta: { table },
			},
		]);
		const sql = generateMigrationSQL(diff);
		const createSql = sql.find((s) => s.includes('CREATE TABLE'));
		expect(createSql).not.toContain('PARTITION BY');
	});

	it('should support multi-column partition keys', () => {
		const table = makePartitionedTableIR('sales', {
			strategy: 'RANGE',
			columns: ['year', 'month'],
		});
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'sales',
				destructive: false,
				details: '',
				meta: { table },
			},
		]);
		const sql = generateMigrationSQL(diff);
		const createSql = sql.find((s) => s.includes('CREATE TABLE'));
		expect(createSql).toContain('PARTITION BY RANGE ("year", "month")');
	});
});

// ============================================================================
// Regression: F-001 — generateDownSQL phases array missing index 15 (comments)
// ============================================================================

describe('generateDownSQL — comment changes (F-001 regression)', () => {
	function makeCommentModel(options: {
		tableComment?: string;
		columnComment?: string;
	}) {
		const emailColumn =
			options.columnComment === undefined
				? makeCol({ name: 'email' })
				: makeCol({ name: 'email', comment: options.columnComment });
		const table: TableIR = {
			name: 'users',
			columns: [emailColumn],
			foreignKeys: [],
			indexes: [],
			...(options.tableComment === undefined
				? {}
				: { comment: options.tableComment }),
		};
		return new ModelIRImpl(new Map([['users', table]]), new Map());
	}

	it('F-001: add_comment in DOWN SQL does not crash (phase 15 present)', () => {
		const diff = makeDiff([
			{
				kind: 'add_comment',
				table: 'users',
				destructive: false,
				details: '',
				meta: { comment: 'A table', target: 'table' },
			},
		]);
		// Must not throw (was crashing with phases[15] = undefined)
		expect(() => generateDownSQL(diff)).not.toThrow();
		const sql = generateDownSQL(diff);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toContain('COMMENT ON TABLE "users" IS NULL');
	});

	it('F-001: drop_comment in DOWN SQL does not crash (phase 15 present)', () => {
		const diff = makeDiff([
			{
				kind: 'drop_comment',
				table: 'orders',
				column: 'total',
				destructive: false,
				details: '',
				meta: { target: 'column' },
			},
		]);
		expect(() => generateDownSQL(diff)).not.toThrow();
		const sql = generateDownSQL(diff);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toContain('WARNING');
	});

	it('F-001: mixed add_comment + create_table DOWN SQL preserves ordering', () => {
		const table = makeTable('users', [
			makeCol({ name: 'id', type: 'integer' }),
		]);
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'users',
				destructive: false,
				details: '',
				meta: { table },
			},
			{
				kind: 'add_comment',
				table: 'users',
				destructive: false,
				details: '',
				meta: { comment: 'User accounts', target: 'table' },
			},
		]);
		expect(() => generateDownSQL(diff)).not.toThrow();
		const sql = generateDownSQL(diff);
		// DOWN: comments reversed first (higher phase), then DROP TABLE
		const commentIdx = sql.findIndex((s) => s.includes('COMMENT ON TABLE'));
		const dropIdx = sql.findIndex((s) => s.includes('DROP TABLE'));
		expect(commentIdx).toBeLessThan(dropIdx);
	});

	it('restores previous table and column comments when comments change', () => {
		const diff = compareSchemata(
			makeCommentModel({
				tableComment: 'new table',
				columnComment: 'new column',
			}),
			makeCommentModel({
				tableComment: 'old table',
				columnComment: 'old column',
			}),
		);

		expect(diff.changes.map((change) => change.kind)).toEqual([
			'add_comment',
			'add_comment',
		]);
		expect(generateMigrationSQL(diff)).toEqual([
			`COMMENT ON TABLE "users" IS 'new table';`,
			`COMMENT ON COLUMN "users"."email" IS 'new column';`,
		]);

		const down = generateDownMigrationSQL(diff);
		expect(down.statements).toEqual([
			`COMMENT ON TABLE "users" IS 'old table';`,
			`COMMENT ON COLUMN "users"."email" IS 'old column';`,
		]);
		expect(down.destructive).toBe(false);
	});

	it('rolls back an empty-string previous comment to IS NULL (empty comment == no comment in PG)', () => {
		// PostgreSQL stores COMMENT ... IS '' identically to IS NULL, so an empty
		// prior comment is the same state as "no prior comment" and rolls back to
		// IS NULL — consistent with an empty desired comment being treated as none.
		const diff = compareSchemata(
			makeCommentModel({ tableComment: 'new table' }),
			makeCommentModel({ tableComment: '' }),
		);

		expect(diff.changes.map((change) => change.kind)).toEqual(['add_comment']);

		const down = generateDownMigrationSQL(diff);
		expect(down.statements).toEqual([`COMMENT ON TABLE "users" IS NULL;`]);
	});

	it('does not throw when a drop_comment change carries a null prior comment', () => {
		// The comparator stores db.comment, which may be null for a public/JS caller
		// or malformed IR; a null must fall through to the warning path, not throw.
		const down = generateDownMigrationSQL(
			makeDiff([
				{
					kind: 'drop_comment',
					table: 'users',
					destructive: false,
					details: '',
					meta: { target: 'table', comment: null },
				},
			]),
		);

		expect(down.statements).toHaveLength(1);
		expect(down.statements[0]).toContain('WARNING');
	});

	it('restores removed table and column comments from diff metadata', () => {
		const diff = compareSchemata(
			makeCommentModel({}),
			makeCommentModel({
				tableComment: 'old table',
				columnComment: 'old column',
			}),
		);

		expect(diff.changes.map((change) => change.kind)).toEqual([
			'drop_comment',
			'drop_comment',
		]);
		expect(generateMigrationSQL(diff)).toEqual([
			`COMMENT ON TABLE "users" IS NULL;`,
			`COMMENT ON COLUMN "users"."email" IS NULL;`,
		]);

		const down = generateDownMigrationSQL(diff);
		expect(down.statements).toEqual([
			`COMMENT ON TABLE "users" IS 'old table';`,
			`COMMENT ON COLUMN "users"."email" IS 'old column';`,
		]);
		expect(down.destructive).toBe(false);
	});

	it('removes comments on rollback for fresh table and column comment adds', () => {
		const diff = compareSchemata(
			makeCommentModel({
				tableComment: 'new table',
				columnComment: 'new column',
			}),
			makeCommentModel({}),
		);

		expect(diff.changes.map((change) => change.kind)).toEqual([
			'add_comment',
			'add_comment',
		]);
		expect(generateMigrationSQL(diff)).toEqual([
			`COMMENT ON TABLE "users" IS 'new table';`,
			`COMMENT ON COLUMN "users"."email" IS 'new column';`,
		]);

		const down = generateDownMigrationSQL(diff);
		expect(down.statements).toEqual([
			`COMMENT ON TABLE "users" IS NULL;`,
			`COMMENT ON COLUMN "users"."email" IS NULL;`,
		]);
		expect(down.destructive).toBe(true);
	});

	it('escapes quote-containing previous comments when restoring changed comments', () => {
		const diff = compareSchemata(
			makeCommentModel({ tableComment: 'new table' }),
			makeCommentModel({ tableComment: "O'Brien" }),
		);

		expect(generateMigrationSQL(diff)).toEqual([
			`COMMENT ON TABLE "users" IS 'new table';`,
		]);
		expect(generateDownSQL(diff)).toEqual([
			`COMMENT ON TABLE "users" IS 'O''Brien';`,
		]);
	});
});

// ============================================================================
// Regression: F-002 — drop_check_constraint DOWN SQL must use $$ not $
// ============================================================================

describe('generateDownSQL — drop_check_constraint dollar-quoting (F-002 regression)', () => {
	it('F-002: DOWN SQL for drop_check_constraint uses $$ not $', () => {
		const diff = makeDiff([
			{
				kind: 'drop_check_constraint',
				table: 'users',
				destructive: true,
				details: '',
				meta: {
					check: { name: 'users_age_check', expression: 'CHECK ((age > 0))' },
				},
			},
		]);
		const sql = generateDownSQL(diff);
		expect(sql).toHaveLength(1);
		// Must use $$ (double dollar), not $ (single dollar) — invalid PostgreSQL
		expect(sql[0]).toContain('DO $$ BEGIN');
		expect(sql[0]).toContain('END $$;');
		expect(sql[0]).not.toMatch(/DO \$ BEGIN/);
		expect(sql[0]).not.toMatch(/END \$;/);
		expect(sql[0]).toBe(
			'DO $$ BEGIN ALTER TABLE "users" ADD CONSTRAINT "users_age_check" CHECK ((age > 0)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;',
		);
	});

	it('re-adds dropped CHECK with escaped semicolon and comment literals', () => {
		const diff = makeDiff([
			{
				kind: 'drop_check_constraint',
				table: 'users',
				destructive: true,
				details: '',
				meta: {
					check: {
						name: 'users_status_check',
						expression: "CHECK (status IN ('a;b', 'c--d'))",
					},
				},
			},
		]);
		const sql = generateDownSQL(diff);
		expect(sql).toEqual([
			`DO $$ BEGIN ALTER TABLE "users" ADD CONSTRAINT "users_status_check" CHECK (status IN ('a;b', 'c--d')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
		]);
	});

	it('F-002: DOWN SQL for drop_check_constraint with schema uses $$', () => {
		const diff = makeDiff([
			{
				kind: 'drop_check_constraint',
				table: 'products',
				destructive: true,
				details: '',
				meta: {
					check: {
						name: 'products_price_check',
						expression: 'CHECK ((price >= 0))',
					},
				},
			},
		]);
		const sql = generateDownSQL(diff, { schemaName: 'catalog' });
		expect(sql).toHaveLength(1);
		expect(sql[0]).toContain('DO $$ BEGIN');
		expect(sql[0]).toContain('END $$;');
		expect(sql[0]).toContain('"catalog"."products"');
	});
});

// ============================================================================
// Regression: F-003 — generateCreateTableSQL missing COLLATE and IDENTITY
// ============================================================================

describe('generateCreateTableSQL — collation and identity (F-003 regression)', () => {
	it('F-003: CREATE TABLE includes COLLATE for columns with collation', () => {
		const table = makeTable('users', [
			makeCol({ name: 'id', type: 'integer' }),
			makeCol({ name: 'name', type: 'string', collation: 'en_US' }),
		]);
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'users',
				destructive: false,
				details: '',
				meta: { table },
			},
		]);
		const sql = generateMigrationSQL(diff);
		const createSql = sql.find((s) => s.includes('CREATE TABLE'));
		expect(createSql).toBeDefined();
		expect(createSql).toContain('COLLATE "en_US"');
	});

	it('F-003: CREATE TABLE includes GENERATED ALWAYS AS IDENTITY', () => {
		const table = makeTable('orders', [
			makeCol({ name: 'id', type: 'integer', identity: 'always' }),
			makeCol({ name: 'name', type: 'string' }),
		]);
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'orders',
				destructive: false,
				details: '',
				meta: { table },
			},
		]);
		const sql = generateMigrationSQL(diff);
		const createSql = sql.find((s) => s.includes('CREATE TABLE'));
		expect(createSql).toBeDefined();
		expect(createSql).toContain('GENERATED ALWAYS AS IDENTITY');
	});

	it('F-003: CREATE TABLE includes GENERATED BY DEFAULT AS IDENTITY', () => {
		const table = makeTable('events', [
			makeCol({ name: 'id', type: 'integer', identity: 'byDefault' }),
		]);
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'events',
				destructive: false,
				details: '',
				meta: { table },
			},
		]);
		const sql = generateMigrationSQL(diff);
		const createSql = sql.find((s) => s.includes('CREATE TABLE'));
		expect(createSql).toBeDefined();
		expect(createSql).toContain('GENERATED BY DEFAULT AS IDENTITY');
	});

	it('F-003: CREATE TABLE includes both COLLATE and IDENTITY on same column', () => {
		const table = makeTable('items', [
			makeCol({
				name: 'code',
				type: 'string',
				collation: 'C',
				identity: 'always',
			}),
		]);
		const diff = makeDiff([
			{
				kind: 'create_table',
				table: 'items',
				destructive: false,
				details: '',
				meta: { table },
			},
		]);
		const sql = generateMigrationSQL(diff);
		const createSql = sql.find((s) => s.includes('CREATE TABLE'));
		expect(createSql).toBeDefined();
		expect(createSql).toContain('COLLATE "C"');
		expect(createSql).toContain('GENERATED ALWAYS AS IDENTITY');
	});
});

// ============================================================================
// DDL-VALIDATE: NOT VALID and VALIDATE CONSTRAINT
// ============================================================================

describe('NOT VALID / VALIDATE CONSTRAINT', () => {
	describe('add_foreign_key with notValid: true', () => {
		it('should append NOT VALID to FK ADD CONSTRAINT SQL', () => {
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				notValid: true,
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
				'ALTER TABLE "posts" ADD CONSTRAINT "fk_posts_user_id" FOREIGN KEY ("user_id") REFERENCES "users" ("id") NOT VALID;',
			);
		});

		it('should not append NOT VALID when notValid is false', () => {
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				notValid: false,
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
				'ALTER TABLE "posts" ADD CONSTRAINT "fk_posts_user_id" FOREIGN KEY ("user_id") REFERENCES "users" ("id");',
			);
		});

		it('should append NOT VALID after DEFERRABLE clause when both set', () => {
			const fk: ForeignKeyIR = {
				columns: ['org_id'],
				references: { table: 'orgs', columns: ['id'] },
				onDelete: 'CASCADE',
				deferred: true,
				notValid: true,
			};
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_foreign_key',
						table: 'members',
						destructive: false,
						details: '',
						meta: { fk },
					},
				]),
			);
			expect(sql[0]).toBe(
				'ALTER TABLE "members" ADD CONSTRAINT "fk_members_org_id" FOREIGN KEY ("org_id") REFERENCES "orgs" ("id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID;',
			);
		});
	});

	describe('add_check_constraint with notValid: true', () => {
		it('should append NOT VALID to CHECK ADD CONSTRAINT SQL', () => {
			const diff = makeDiff([
				{
					kind: 'add_check_constraint',
					table: 'users',
					destructive: false,
					details: '',
					meta: {
						check: {
							name: 'users_age_check',
							expression: 'CHECK ((age > 0))',
							notValid: true,
						},
					},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toBe(
				'DO $$ BEGIN ALTER TABLE "users" ADD CONSTRAINT "users_age_check" CHECK ((age > 0)) NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;',
			);
		});

		it('should not append NOT VALID when notValid is absent', () => {
			const diff = makeDiff([
				{
					kind: 'add_check_constraint',
					table: 'users',
					destructive: false,
					details: '',
					meta: {
						check: {
							name: 'users_age_check',
							expression: 'CHECK ((age > 0))',
						},
					},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toBe(
				'DO $$ BEGIN ALTER TABLE "users" ADD CONSTRAINT "users_age_check" CHECK ((age > 0)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;',
			);
		});

		it('should emit inline legacy NOT VALID exactly once', () => {
			const diff = makeDiff([
				{
					kind: 'add_check_constraint',
					table: 'users',
					destructive: false,
					details: '',
					meta: {
						check: {
							name: 'users_age_check',
							expression: 'CHECK ((age > 0)) NOT VALID',
						},
					},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toBe(
				'DO $$ BEGIN ALTER TABLE "users" ADD CONSTRAINT "users_age_check" CHECK ((age > 0)) NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;',
			);
		});

		it('should let explicit notValid false override inline legacy NOT VALID', () => {
			const diff = makeDiff([
				{
					kind: 'add_check_constraint',
					table: 'users',
					destructive: false,
					details: '',
					meta: {
						check: {
							name: 'users_age_check',
							expression: 'CHECK ((age > 0)) NOT VALID',
							notValid: false,
						},
					},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toBe(
				'DO $$ BEGIN ALTER TABLE "users" ADD CONSTRAINT "users_age_check" CHECK ((age > 0)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;',
			);
		});

		it('should re-add a dropped NOT VALID CHECK in the down migration', () => {
			const down = generateDownMigrationSQL(
				makeDiff([
					{
						kind: 'drop_check_constraint',
						table: 'users',
						destructive: true,
						details: '',
						meta: {
							check: {
								name: 'users_age_check',
								expression: 'CHECK ((age > 0))',
								notValid: true,
							},
						},
					},
				]),
			);
			expect(down.statements).toEqual([
				'DO $$ BEGIN ALTER TABLE "users" ADD CONSTRAINT "users_age_check" CHECK ((age > 0)) NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;',
			]);
			expect(down.destructive).toBe(false);
		});
	});

	describe('validate_constraint', () => {
		it('should generate VALIDATE CONSTRAINT for FK', () => {
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
			};
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'validate_constraint',
						table: 'posts',
						destructive: false,
						details: '',
						meta: { fk },
					},
				]),
			);
			expect(sql[0]).toBe(
				'ALTER TABLE "posts" VALIDATE CONSTRAINT "fk_posts_user_id";',
			);
		});

		it('should generate VALIDATE CONSTRAINT with an explicit FK constraint name', () => {
			const fk: ForeignKeyIR = {
				constraintName: 'posts_author_id_fkey',
				columns: ['author_id'],
				references: { table: 'users', columns: ['id'] },
			};
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'validate_constraint',
						table: 'posts',
						destructive: false,
						details: '',
						meta: { fk },
					},
				]),
			);

			expect(sql[0]).toBe(
				'ALTER TABLE "posts" VALIDATE CONSTRAINT "posts_author_id_fkey";',
			);
		});

		it('should generate VALIDATE CONSTRAINT for CHECK', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'validate_constraint',
						table: 'users',
						destructive: false,
						details: '',
						meta: {
							check: {
								name: 'users_age_check',
								expression: 'CHECK ((age > 0))',
							},
						},
					},
				]),
			);
			expect(sql[0]).toBe(
				'ALTER TABLE "users" VALIDATE CONSTRAINT "users_age_check";',
			);
		});

		it('should generate VALIDATE CONSTRAINT with schema prefix', () => {
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
			};
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'validate_constraint',
						table: 'posts',
						destructive: false,
						details: '',
						meta: { fk },
					},
				]),
				{ schemaName: 'myschema' },
			);
			expect(sql[0]).toBe(
				'ALTER TABLE "myschema"."posts" VALIDATE CONSTRAINT "fk_posts_user_id";',
			);
		});

		it('should return undefined when no meta', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'validate_constraint',
						table: 'posts',
						destructive: false,
						details: '',
					},
				]),
			);
			expect(sql).toHaveLength(0);
		});

		it('validate_constraint runs after add_foreign_key (phase 16 > phase 10)', () => {
			const fkAdd: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				notValid: true,
			};
			const fkValidate: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
			};
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'validate_constraint',
						table: 'posts',
						destructive: false,
						details: '',
						meta: { fk: fkValidate },
					},
					{
						kind: 'add_foreign_key',
						table: 'posts',
						destructive: false,
						details: '',
						meta: { fk: fkAdd },
					},
				]),
			);
			expect(sql).toHaveLength(2);
			expect(sql[0]).toContain('ADD CONSTRAINT');
			expect(sql[1]).toContain('VALIDATE CONSTRAINT');
		});

		it('should generate DOWN comment for validate_constraint', () => {
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
			};
			const down = generateDownSQL(
				makeDiff([
					{
						kind: 'validate_constraint',
						table: 'posts',
						destructive: false,
						details: '',
						meta: { fk },
					},
				]),
			);
			expect(down[0]).toContain('cannot be reversed');
		});
	});

	describe('compareSchemata emits validate_constraint', () => {
		it('should emit validate_constraint when FK transitions from notValid to valid', () => {
			const fkDB: ForeignKeyIR = {
				constraintName: 'posts_user_id_fkey',
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				notValid: true,
			};
			const fkSchema: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				notValid: false,
			};
			const usersTable: TableIR = {
				name: 'users',
				columns: [],
				foreignKeys: [],
				indexes: [],
			};
			const tableSchema: TableIR = {
				name: 'posts',
				columns: [],
				foreignKeys: [fkSchema],
				indexes: [],
			};
			const tableDB: TableIR = {
				name: 'posts',
				columns: [],
				foreignKeys: [fkDB],
				indexes: [],
			};
			const schemaModel = new ModelIRImpl(
				new Map([
					['users', usersTable],
					['posts', tableSchema],
				]),
				new Map(),
			);
			const dbModel = new ModelIRImpl(
				new Map([
					['users', usersTable],
					['posts', tableDB],
				]),
				new Map(),
			);
			const diff = compareSchemata(schemaModel, dbModel);
			const validate = diff.changes.find(
				(c) => c.kind === 'validate_constraint',
			);
			expect(validate).toBeDefined();
			expect(validate?.table).toBe('posts');
			expect(generateMigrationSQL(diff)).toEqual([
				'ALTER TABLE "posts" VALIDATE CONSTRAINT "posts_user_id_fkey";',
			]);
		});

		it('should not validate separately when altering a NOT VALID FK', () => {
			const fkDB: ForeignKeyIR = {
				constraintName: 'posts_user_id_fkey',
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				notValid: true,
			};
			const fkSchema: ForeignKeyIR = {
				constraintName: 'custom_posts_user_fk',
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				onDelete: 'CASCADE',
			};
			const usersTable: TableIR = {
				name: 'users',
				columns: [],
				foreignKeys: [],
				indexes: [],
			};
			const diff = compareSchemata(
				new ModelIRImpl(
					new Map([
						['users', usersTable],
						[
							'posts',
							{
								name: 'posts',
								columns: [],
								foreignKeys: [fkSchema],
								indexes: [],
							},
						],
					]),
					new Map(),
				),
				new ModelIRImpl(
					new Map([
						['users', usersTable],
						[
							'posts',
							{
								name: 'posts',
								columns: [],
								foreignKeys: [fkDB],
								indexes: [],
							},
						],
					]),
					new Map(),
				),
			);

			expect(diff.changes.map((change) => change.kind)).toEqual([
				'alter_foreign_key',
			]);
			expect(generateMigrationSQL(diff)).toEqual([
				'ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_user_id_fkey";\n' +
					'ALTER TABLE "posts" ADD CONSTRAINT "custom_posts_user_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE;',
			]);
		});

		it('should rename before validating a NOT VALID FK with an explicit desired name', () => {
			const fkDB: ForeignKeyIR = {
				constraintName: 'posts_user_id_fkey',
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				notValid: true,
			};
			const fkSchema: ForeignKeyIR = {
				constraintName: 'custom_posts_user_fk',
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
			};
			const usersTable: TableIR = {
				name: 'users',
				columns: [],
				foreignKeys: [],
				indexes: [],
			};
			const diff = compareSchemata(
				new ModelIRImpl(
					new Map([
						['users', usersTable],
						[
							'posts',
							{
								name: 'posts',
								columns: [],
								foreignKeys: [fkSchema],
								indexes: [],
							},
						],
					]),
					new Map(),
				),
				new ModelIRImpl(
					new Map([
						['users', usersTable],
						[
							'posts',
							{
								name: 'posts',
								columns: [],
								foreignKeys: [fkDB],
								indexes: [],
							},
						],
					]),
					new Map(),
				),
			);

			expect(diff.changes.map((change) => change.kind)).toEqual([
				'rename_foreign_key',
				'validate_constraint',
			]);
			expect(generateMigrationSQL(diff)).toEqual([
				'ALTER TABLE "posts" RENAME CONSTRAINT "posts_user_id_fkey" TO "custom_posts_user_fk";',
				'ALTER TABLE "posts" VALIDATE CONSTRAINT "custom_posts_user_fk";',
			]);
		});

		it('should emit validate_constraint when CHECK transitions from notValid to valid', () => {
			const tableSchema: TableIR = {
				name: 'users',
				columns: [],
				foreignKeys: [],
				indexes: [],
				checkConstraints: [
					{
						name: 'users_age_check',
						expression: 'CHECK ((age > 0))',
						notValid: false,
					},
				],
			};
			const tableDB: TableIR = {
				name: 'users',
				columns: [],
				foreignKeys: [],
				indexes: [],
				checkConstraints: [
					{
						name: 'users_age_check',
						expression: 'CHECK ((age > 0))',
						notValid: true,
					},
				],
			};
			const schemaModel = new ModelIRImpl(
				new Map([['users', tableSchema]]),
				new Map(),
			);
			const dbModel = new ModelIRImpl(new Map([['users', tableDB]]), new Map());
			const diff = compareSchemata(schemaModel, dbModel);
			const validate = diff.changes.find(
				(c) => c.kind === 'validate_constraint',
			);
			expect(validate).toBeDefined();
			expect(validate?.table).toBe('users');
		});

		it('should drop and re-add CHECK NOT VALID when schema asks to unvalidate a validated constraint', () => {
			const tableSchema: TableIR = {
				name: 'users',
				columns: [],
				foreignKeys: [],
				indexes: [],
				checkConstraints: [
					{
						name: 'users_age_check',
						expression: 'CHECK ((age > 0))',
						notValid: true,
					},
				],
			};
			const tableDB: TableIR = {
				name: 'users',
				columns: [],
				foreignKeys: [],
				indexes: [],
				checkConstraints: [
					{
						name: 'users_age_check',
						expression: 'CHECK ((age > 0))',
					},
				],
			};
			const diff = compareSchemata(
				new ModelIRImpl(new Map([['users', tableSchema]]), new Map()),
				new ModelIRImpl(new Map([['users', tableDB]]), new Map()),
			);

			expect(diff.changes.map((change) => change.kind)).toEqual([
				'drop_check_constraint',
				'add_check_constraint',
			]);
			expect(diff.changes.every((change) => change.destructive)).toBe(true);
			expect(generateMigrationSQL(diff)).toEqual([
				'ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_age_check";',
				'DO $$ BEGIN ALTER TABLE "users" ADD CONSTRAINT "users_age_check" CHECK ((age > 0)) NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;',
			]);
			expect(generateMigrationSQL(diff, { includeDestructive: false })).toEqual(
				[],
			);
		});

		it('should drop and re-add FK NOT VALID when schema asks to unvalidate a validated constraint', () => {
			const fkSchema: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				notValid: true,
			};
			const fkDB: ForeignKeyIR = {
				constraintName: 'posts_user_id_fkey',
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
			};
			const usersTable: TableIR = {
				name: 'users',
				columns: [],
				foreignKeys: [],
				indexes: [],
			};
			const tableSchema: TableIR = {
				name: 'posts',
				columns: [],
				foreignKeys: [fkSchema],
				indexes: [],
			};
			const tableDB: TableIR = {
				name: 'posts',
				columns: [],
				foreignKeys: [fkDB],
				indexes: [],
			};
			const diff = compareSchemata(
				new ModelIRImpl(
					new Map([
						['users', usersTable],
						['posts', tableSchema],
					]),
					new Map(),
				),
				new ModelIRImpl(
					new Map([
						['users', usersTable],
						['posts', tableDB],
					]),
					new Map(),
				),
			);

			expect(diff.changes.map((change) => change.kind)).toEqual([
				'drop_foreign_key',
				'add_foreign_key',
			]);
			expect(diff.changes.every((change) => change.destructive)).toBe(true);
			expect(generateMigrationSQL(diff)).toEqual([
				'ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_user_id_fkey";',
				'ALTER TABLE "posts" ADD CONSTRAINT "fk_posts_user_id" FOREIGN KEY ("user_id") REFERENCES "users" ("id") NOT VALID;',
			]);
			expect(generateMigrationSQL(diff, { includeDestructive: false })).toEqual(
				[],
			);
		});

		it('should NOT emit validate_constraint when both are notValid', () => {
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				notValid: true,
			};
			const usersTable: TableIR = {
				name: 'users',
				columns: [],
				foreignKeys: [],
				indexes: [],
			};
			const tableSchema: TableIR = {
				name: 'posts',
				columns: [],
				foreignKeys: [fk],
				indexes: [],
			};
			const tableDB: TableIR = {
				name: 'posts',
				columns: [],
				foreignKeys: [fk],
				indexes: [],
			};
			const schemaModel = new ModelIRImpl(
				new Map([
					['users', usersTable],
					['posts', tableSchema],
				]),
				new Map(),
			);
			const dbModel = new ModelIRImpl(
				new Map([
					['users', usersTable],
					['posts', tableDB],
				]),
				new Map(),
			);
			const diff = compareSchemata(schemaModel, dbModel);
			expect(diff.changes.some((c) => c.kind === 'validate_constraint')).toBe(
				false,
			);
		});
	});
});

// ============================================================================
// DDL-RLS: Row-Level Security
// ============================================================================

describe('DDL-RLS: Row-Level Security', () => {
	function makeRlsTable(
		overrides: Partial<TableIR> & { name: string },
	): TableIR {
		return {
			columns: [],
			foreignKeys: [],
			indexes: [],
			...overrides,
		};
	}

	describe('changeToUpSQL', () => {
		it('enable_rls generates ALTER TABLE ENABLE ROW LEVEL SECURITY', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'enable_rls',
						table: 'documents',
						destructive: false,
						details: '',
					},
				]),
			);
			expect(sql).toEqual([
				'ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;',
			]);
		});

		it('disable_rls generates ALTER TABLE DISABLE ROW LEVEL SECURITY', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'disable_rls',
						table: 'documents',
						destructive: false,
						details: '',
					},
				]),
			);
			expect(sql).toEqual([
				'ALTER TABLE "documents" DISABLE ROW LEVEL SECURITY;',
			]);
		});

		it('create_policy with all options', () => {
			const policy: PolicyIR = {
				name: 'tenant_isolation',
				command: 'ALL',
				roles: ['app_user', 'app_admin'],
				permissive: true,
				using: "tenant_id = current_setting('app.tenant')::uuid",
				withCheck: "tenant_id = current_setting('app.tenant')::uuid",
			};
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_policy',
						table: 'documents',
						destructive: false,
						details: '',
						meta: { policy },
					},
				]),
			);
			expect(sql).toEqual([
				`CREATE POLICY "tenant_isolation" ON "documents" FOR ALL AS PERMISSIVE TO "app_user", "app_admin" USING (tenant_id = current_setting('app.tenant')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant')::uuid);`,
			]);
		});

		it('create_policy role names are double-quoted (F-002 security fix)', () => {
			const policy: PolicyIR = {
				name: 'p',
				roles: ['app_user', 'app admin'],
			};
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_policy',
						table: 't',
						destructive: false,
						details: '',
						meta: { policy },
					},
				]),
			);
			expect(sql[0]).toContain('TO "app_user", "app admin"');
		});

		it('create_policy with minimal options (name only)', () => {
			const policy: PolicyIR = { name: 'open' };
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_policy',
						table: 'documents',
						destructive: false,
						details: '',
						meta: { policy },
					},
				]),
			);
			expect(sql).toEqual([
				`CREATE POLICY "open" ON "documents" FOR ALL AS PERMISSIVE;`,
			]);
		});

		it('create_policy SELECT command with USING only', () => {
			const policy: PolicyIR = {
				name: 'read_own',
				command: 'SELECT',
				using: 'owner_id = current_user_id()',
			};
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_policy',
						table: 'documents',
						destructive: false,
						details: '',
						meta: { policy },
					},
				]),
			);
			expect(sql).toEqual([
				`CREATE POLICY "read_own" ON "documents" FOR SELECT AS PERMISSIVE USING (owner_id = current_user_id());`,
			]);
		});

		it('create_policy RESTRICTIVE', () => {
			const policy: PolicyIR = {
				name: 'no_delete',
				command: 'DELETE',
				permissive: false,
				using: 'false',
			};
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_policy',
						table: 'documents',
						destructive: false,
						details: '',
						meta: { policy },
					},
				]),
			);
			expect(sql).toEqual([
				`CREATE POLICY "no_delete" ON "documents" FOR DELETE AS RESTRICTIVE USING (false);`,
			]);
		});

		it('drop_policy generates DROP POLICY IF EXISTS', () => {
			const policy: PolicyIR = { name: 'tenant_isolation' };
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'drop_policy',
						table: 'documents',
						destructive: false,
						details: '',
						meta: { policy },
					},
				]),
			);
			expect(sql).toEqual([
				`DROP POLICY IF EXISTS "tenant_isolation" ON "documents";`,
			]);
		});

		it('schema-qualified table in enable_rls and create_policy', () => {
			const policy: PolicyIR = { name: 'tenant', using: 'tenant_id = $1' };
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'enable_rls',
						table: 'documents',
						destructive: false,
						details: '',
					},
					{
						kind: 'create_policy',
						table: 'documents',
						destructive: false,
						details: '',
						meta: { policy },
					},
				]),
				{ schemaName: 'tenant_42' },
			);
			expect(sql[0]).toBe(
				'ALTER TABLE "tenant_42"."documents" ENABLE ROW LEVEL SECURITY;',
			);
			expect(sql[1]).toBe(
				`CREATE POLICY "tenant" ON "tenant_42"."documents" FOR ALL AS PERMISSIVE USING (tenant_id = $1);`,
			);
		});

		it('phase ordering: enable_rls (17) comes after create_index (12)', () => {
			const policy: PolicyIR = { name: 'p' };
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_policy',
						table: 't',
						destructive: false,
						details: '',
						meta: { policy },
					},
					{
						kind: 'enable_rls',
						table: 't',
						destructive: false,
						details: '',
					},
					{
						kind: 'create_index',
						table: 't',
						destructive: false,
						details: '',
						meta: { index: { columns: ['id'], unique: false } },
					},
				]),
			);
			const kinds = sql.map((s) => {
				if (s.includes('ENABLE ROW LEVEL')) return 'enable_rls';
				if (s.includes('CREATE POLICY')) return 'create_policy';
				if (s.includes('INDEX')) return 'create_index';
				return 'other';
			});
			expect(kinds.indexOf('create_index')).toBeLessThan(
				kinds.indexOf('enable_rls'),
			);
			expect(kinds.indexOf('enable_rls')).toBeLessThan(
				kinds.indexOf('create_policy'),
			);
		});

		it('isChangeSupported: supportsDDLRowLevelSecurity=false filters RLS kinds', () => {
			const policy: PolicyIR = { name: 'p', using: 'true' };
			const caps: DialectCapabilities = {
				name: 'no-rls',
				supportsReturning: false,
				supportsRecursiveCTE: false,
				supportsWindowFunctions: false,
				supportsArrayType: false,
				supportsRangeTypes: false,
				supportsJsonType: false,
				supportsJsonOperators: false,
				supportsSchemas: false,
				supportsLateralJoin: false,
				supportsJsonAgg: false,
				recursivePathStyle: 'string',
				stringConcatStyle: 'operator',
				identifierQuote: '"',
				parameterStyle: 'dollar',
				limitStyle: 'limit-offset',
				booleanStyle: 'native',
				supportsDDLRowLevelSecurity: false,
			};
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'enable_rls',
						table: 'documents',
						destructive: false,
						details: '',
					},
					{
						kind: 'create_policy',
						table: 'documents',
						destructive: false,
						details: '',
						meta: { policy },
					},
				]),
				{ dialectCapabilities: caps },
			);
			expect(sql).toHaveLength(0);
		});
	});

	describe('changeToDownSQL', () => {
		it('enable_rls DOWN reverses to DISABLE', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'enable_rls',
						table: 'documents',
						destructive: false,
						details: '',
					},
				]),
			);
			expect(sql).toEqual([
				'ALTER TABLE "documents" DISABLE ROW LEVEL SECURITY;',
			]);
		});

		it('disable_rls DOWN reverses to ENABLE', () => {
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'disable_rls',
						table: 'documents',
						destructive: false,
						details: '',
					},
				]),
			);
			expect(sql).toEqual([
				'ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;',
			]);
		});

		it('create_policy DOWN drops the policy', () => {
			const policy: PolicyIR = {
				name: 'tenant_isolation',
				using: "tenant_id = current_setting('app.tenant')::uuid",
			};
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'create_policy',
						table: 'documents',
						destructive: false,
						details: '',
						meta: { policy },
					},
				]),
			);
			expect(sql).toEqual([
				`DROP POLICY IF EXISTS "tenant_isolation" ON "documents";`,
			]);
		});

		it('drop_policy DOWN recreates the policy', () => {
			const policy: PolicyIR = {
				name: 'tenant_isolation',
				command: 'SELECT',
				roles: ['app_user'],
				using: "tenant_id = current_setting('app.tenant')::uuid",
			};
			const sql = generateDownSQL(
				makeDiff([
					{
						kind: 'drop_policy',
						table: 'documents',
						destructive: false,
						details: '',
						meta: { policy },
					},
				]),
			);
			expect(sql).toEqual([
				`CREATE POLICY "tenant_isolation" ON "documents" FOR SELECT AS PERMISSIVE TO "app_user" USING (tenant_id = current_setting('app.tenant')::uuid);`,
			]);
		});
	});

	describe('generateDDL', () => {
		it('rlsEnabled generates ENABLE ROW LEVEL SECURITY', async () => {
			const { generateDDL } = await import('./ddl-generator.js');
			const model = new ModelIRImpl(
				new Map([
					[
						'documents',
						makeRlsTable({
							name: 'documents',
							rlsEnabled: true,
						}),
					],
				]),
				new Map(),
			);
			const stmts = generateDDL(model);
			expect(stmts.some((s) => s.includes('ENABLE ROW LEVEL SECURITY'))).toBe(
				true,
			);
		});

		it('policies generate CREATE POLICY statements', async () => {
			const { generateDDL } = await import('./ddl-generator.js');
			const policy: PolicyIR = {
				name: 'tenant_isolation',
				command: 'ALL',
				roles: ['app_user'],
				using: "tenant_id = current_setting('app.tenant')::uuid",
			};
			const model = new ModelIRImpl(
				new Map([
					[
						'documents',
						makeRlsTable({
							name: 'documents',
							rlsEnabled: true,
							policies: [policy],
						}),
					],
				]),
				new Map(),
			);
			const stmts = generateDDL(model);
			expect(stmts.some((s) => s.includes('CREATE POLICY'))).toBe(true);
			expect(stmts.some((s) => s.includes('"tenant_isolation"'))).toBe(true);
		});

		it('generateDDL policy role names are double-quoted (F-003 security fix)', async () => {
			const { generateDDL } = await import('./ddl-generator.js');
			const policy: PolicyIR = {
				name: 'tenant_isolation',
				command: 'ALL',
				roles: ['app_user', 'app_admin'],
				using: 'true',
			};
			const model = new ModelIRImpl(
				new Map([
					[
						'documents',
						makeRlsTable({
							name: 'documents',
							rlsEnabled: true,
							policies: [policy],
						}),
					],
				]),
				new Map(),
			);
			const stmts = generateDDL(model);
			const policyStmt = stmts.find((s) => s.includes('CREATE POLICY'));
			expect(policyStmt).toContain('TO "app_user", "app_admin"');
		});

		it('capability gating: supportsDDLRowLevelSecurity=false omits RLS SQL', async () => {
			const { generateDDL } = await import('./ddl-generator.js');
			const noCaps: DialectCapabilities = {
				name: 'no-rls',
				supportsReturning: false,
				supportsRecursiveCTE: false,
				supportsWindowFunctions: false,
				supportsArrayType: false,
				supportsRangeTypes: false,
				supportsJsonType: false,
				supportsJsonOperators: false,
				supportsSchemas: false,
				supportsLateralJoin: false,
				supportsJsonAgg: false,
				recursivePathStyle: 'string',
				stringConcatStyle: 'operator',
				identifierQuote: '"',
				parameterStyle: 'dollar',
				limitStyle: 'limit-offset',
				booleanStyle: 'native',
				supportsDDLRowLevelSecurity: false,
			};
			const policy: PolicyIR = { name: 'p', using: 'true' };
			const model = new ModelIRImpl(
				new Map([
					[
						'documents',
						makeRlsTable({
							name: 'documents',
							rlsEnabled: true,
							policies: [policy],
						}),
					],
				]),
				new Map(),
			);
			const stmts = generateDDL(model, { dialectCapabilities: noCaps });
			expect(stmts.some((s) => s.includes('ROW LEVEL SECURITY'))).toBe(false);
			expect(stmts.some((s) => s.includes('CREATE POLICY'))).toBe(false);
		});
	});

	describe('compareSchemata', () => {
		it('new table with rlsEnabled emits enable_rls change', () => {
			const table = makeRlsTable({ name: 'documents', rlsEnabled: true });
			const schemaModel = new ModelIRImpl(
				new Map([['documents', table]]),
				new Map(),
			);
			const dbModel = new ModelIRImpl(new Map(), new Map());
			const diff = compareSchemata(schemaModel, dbModel);
			expect(diff.changes.some((c) => c.kind === 'enable_rls')).toBe(true);
		});

		it('new table with policies emits create_policy changes', () => {
			const policy: PolicyIR = { name: 'p', using: 'true' };
			const table = makeRlsTable({
				name: 'documents',
				rlsEnabled: true,
				policies: [policy],
			});
			const schemaModel = new ModelIRImpl(
				new Map([['documents', table]]),
				new Map(),
			);
			const dbModel = new ModelIRImpl(new Map(), new Map());
			const diff = compareSchemata(schemaModel, dbModel);
			expect(diff.changes.some((c) => c.kind === 'create_policy')).toBe(true);
		});

		it('existing table: rlsEnabled added → enable_rls change', () => {
			const schemaTable = makeRlsTable({ name: 'documents', rlsEnabled: true });
			const dbTable = makeRlsTable({ name: 'documents' });
			const schemaModel = new ModelIRImpl(
				new Map([['documents', schemaTable]]),
				new Map(),
			);
			const dbModel = new ModelIRImpl(
				new Map([['documents', dbTable]]),
				new Map(),
			);
			const diff = compareSchemata(schemaModel, dbModel);
			expect(diff.changes.some((c) => c.kind === 'enable_rls')).toBe(true);
		});

		it('existing table: rlsEnabled removed → disable_rls change', () => {
			const schemaTable = makeRlsTable({ name: 'documents' });
			const dbTable = makeRlsTable({ name: 'documents', rlsEnabled: true });
			const schemaModel = new ModelIRImpl(
				new Map([['documents', schemaTable]]),
				new Map(),
			);
			const dbModel = new ModelIRImpl(
				new Map([['documents', dbTable]]),
				new Map(),
			);
			const diff = compareSchemata(schemaModel, dbModel);
			expect(diff.changes.some((c) => c.kind === 'disable_rls')).toBe(true);
		});

		it('new policy → create_policy change', () => {
			const policy: PolicyIR = { name: 'p', using: 'true' };
			const schemaTable = makeRlsTable({
				name: 'documents',
				rlsEnabled: true,
				policies: [policy],
			});
			const dbTable = makeRlsTable({ name: 'documents', rlsEnabled: true });
			const schemaModel = new ModelIRImpl(
				new Map([['documents', schemaTable]]),
				new Map(),
			);
			const dbModel = new ModelIRImpl(
				new Map([['documents', dbTable]]),
				new Map(),
			);
			const diff = compareSchemata(schemaModel, dbModel);
			expect(diff.changes.some((c) => c.kind === 'create_policy')).toBe(true);
		});

		it('removed policy → drop_policy change', () => {
			const policy: PolicyIR = { name: 'p', using: 'true' };
			const schemaTable = makeRlsTable({ name: 'documents', rlsEnabled: true });
			const dbTable = makeRlsTable({
				name: 'documents',
				rlsEnabled: true,
				policies: [policy],
			});
			const schemaModel = new ModelIRImpl(
				new Map([['documents', schemaTable]]),
				new Map(),
			);
			const dbModel = new ModelIRImpl(
				new Map([['documents', dbTable]]),
				new Map(),
			);
			const diff = compareSchemata(schemaModel, dbModel);
			expect(diff.changes.some((c) => c.kind === 'drop_policy')).toBe(true);
		});

		it('changed policy → drop_policy + create_policy', () => {
			const oldPolicy: PolicyIR = { name: 'p', using: 'true' };
			const newPolicy: PolicyIR = { name: 'p', using: 'false' };
			const schemaTable = makeRlsTable({
				name: 'documents',
				rlsEnabled: true,
				policies: [newPolicy],
			});
			const dbTable = makeRlsTable({
				name: 'documents',
				rlsEnabled: true,
				policies: [oldPolicy],
			});
			const schemaModel = new ModelIRImpl(
				new Map([['documents', schemaTable]]),
				new Map(),
			);
			const dbModel = new ModelIRImpl(
				new Map([['documents', dbTable]]),
				new Map(),
			);
			const diff = compareSchemata(schemaModel, dbModel);
			expect(diff.changes.some((c) => c.kind === 'drop_policy')).toBe(true);
			expect(diff.changes.some((c) => c.kind === 'create_policy')).toBe(true);
		});

		it('same-name policy replacement DOWN mirrors UP order', () => {
			const oldPolicy: PolicyIR = {
				name: 'tenant_isolation',
				command: 'SELECT',
				roles: ['app_user'],
				using: "tenant_id = current_setting('app.tenant')::uuid",
			};
			const newPolicy: PolicyIR = {
				name: 'tenant_isolation',
				command: 'SELECT',
				roles: ['app_user'],
				using:
					"tenant_id = current_setting('app.tenant')::uuid AND archived_at IS NULL",
			};
			const schemaTable = makeRlsTable({
				name: 'documents',
				rlsEnabled: true,
				policies: [newPolicy],
			});
			const dbTable = makeRlsTable({
				name: 'documents',
				rlsEnabled: true,
				policies: [oldPolicy],
			});
			const schemaModel = new ModelIRImpl(
				new Map([['documents', schemaTable]]),
				new Map(),
			);
			const dbModel = new ModelIRImpl(
				new Map([['documents', dbTable]]),
				new Map(),
			);
			const diff = compareSchemata(schemaModel, dbModel);

			expect(diff.changes.map((change) => change.kind)).toEqual([
				'drop_policy',
				'create_policy',
			]);
			expect(generateMigrationSQL(diff)).toEqual([
				`DROP POLICY IF EXISTS "tenant_isolation" ON "documents";`,
				`CREATE POLICY "tenant_isolation" ON "documents" FOR SELECT AS PERMISSIVE TO "app_user" USING (tenant_id = current_setting('app.tenant')::uuid AND archived_at IS NULL);`,
			]);
			expect(generateDownSQL(diff)).toEqual([
				`DROP POLICY IF EXISTS "tenant_isolation" ON "documents";`,
				`CREATE POLICY "tenant_isolation" ON "documents" FOR SELECT AS PERMISSIVE TO "app_user" USING (tenant_id = current_setting('app.tenant')::uuid);`,
			]);
		});

		it('unchanged policy → no RLS changes', () => {
			const policy: PolicyIR = {
				name: 'p',
				command: 'SELECT',
				using: 'true',
				roles: ['app_user'],
			};
			const schemaTable = makeRlsTable({
				name: 'documents',
				rlsEnabled: true,
				policies: [policy],
			});
			const dbTable = makeRlsTable({
				name: 'documents',
				rlsEnabled: true,
				policies: [policy],
			});
			const schemaModel = new ModelIRImpl(
				new Map([['documents', schemaTable]]),
				new Map(),
			);
			const dbModel = new ModelIRImpl(
				new Map([['documents', dbTable]]),
				new Map(),
			);
			const diff = compareSchemata(schemaModel, dbModel);
			const rlsChanges = diff.changes.filter(
				(c) =>
					c.kind === 'enable_rls' ||
					c.kind === 'disable_rls' ||
					c.kind === 'create_policy' ||
					c.kind === 'drop_policy',
			);
			expect(rlsChanges).toHaveLength(0);
		});

		it('capability gating: supportsDDLRowLevelSecurity=false skips RLS diff', () => {
			const policy: PolicyIR = { name: 'p', using: 'true' };
			const schemaTable = makeRlsTable({
				name: 'documents',
				rlsEnabled: true,
				policies: [policy],
			});
			const dbTable = makeRlsTable({ name: 'documents' });
			const schemaModel = new ModelIRImpl(
				new Map([['documents', schemaTable]]),
				new Map(),
			);
			const dbModel = new ModelIRImpl(
				new Map([['documents', dbTable]]),
				new Map(),
			);
			const caps: DialectCapabilities = {
				name: 'no-rls',
				supportsReturning: false,
				supportsRecursiveCTE: false,
				supportsWindowFunctions: false,
				supportsArrayType: false,
				supportsRangeTypes: false,
				supportsJsonType: false,
				supportsJsonOperators: false,
				supportsSchemas: false,
				supportsLateralJoin: false,
				supportsJsonAgg: false,
				recursivePathStyle: 'string',
				stringConcatStyle: 'operator',
				identifierQuote: '"',
				parameterStyle: 'dollar',
				limitStyle: 'limit-offset',
				booleanStyle: 'native',
				supportsDDLRowLevelSecurity: false,
			};
			const diff = compareSchemata(schemaModel, dbModel, {
				dialectCapabilities: caps,
			});
			const rlsChanges = diff.changes.filter(
				(c) =>
					c.kind === 'enable_rls' ||
					c.kind === 'disable_rls' ||
					c.kind === 'create_policy' ||
					c.kind === 'drop_policy',
			);
			expect(rlsChanges).toHaveLength(0);
		});
	});
});
