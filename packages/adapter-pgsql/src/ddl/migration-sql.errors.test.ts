/**
 * Error-path and edge-case tests for migration SQL generation.
 *
 * Covers branches NOT tested in migration-sql.test.ts:
 * - Missing meta guards (return undefined → skipped)
 * - formatDefault edge cases (all value types)
 * - alter_column_type fallback without column meta
 * - generateCreateTableSQL variations (nullable, autoIncrement, default, unique, PK)
 * - generateAddFKSQL variations (no onDelete, schema-qualified)
 * - Destructive filtering edge cases
 */

import type {
	ColumnIR,
	ForeignKeyIR,
	IndexIR,
	PolicyIR,
	TableIR,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { generateDownSQL, generateMigrationSQL } from './migration-sql.js';
import type { SchemaChange, SchemaDiff } from './schema-diff.js';

// ============================================================================
// Test helpers (same as migration-sql.test.ts)
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

describe('generateMigrationSQL — error paths & edge cases', () => {
	// ========================================================================
	// 1. Missing meta guards
	// ========================================================================
	describe('missing meta guards', () => {
		it('should produce no SQL for create_table without meta.table', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_table',
						table: 'test',
						destructive: false,
						details: '',
					},
				]),
			);

			expect(sql).toEqual([]);
		});

		it('should produce no SQL for add_column without meta.column', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_column',
						table: 'test',
						column: 'col',
						destructive: false,
						details: '',
					},
				]),
			);

			expect(sql).toEqual([]);
		});

		it('should produce no SQL for add_foreign_key without meta.fk', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_foreign_key',
						table: 'test',
						destructive: false,
						details: '',
					},
				]),
			);

			expect(sql).toEqual([]);
		});

		it('should produce no SQL for drop_foreign_key without meta.fk', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'drop_foreign_key',
						table: 'test',
						destructive: true,
						details: '',
					},
				]),
			);

			expect(sql).toEqual([]);
		});

		it('should produce no SQL for alter_foreign_key without meta.fk', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'alter_foreign_key',
						table: 'test',
						destructive: false,
						details: '',
					},
				]),
			);

			expect(sql).toEqual([]);
		});

		it('should produce no SQL for create_index without meta.index', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_index',
						table: 'test',
						destructive: false,
						details: '',
					},
				]),
			);

			expect(sql).toEqual([]);
		});

		it('should produce no SQL for drop_index without meta.index', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'drop_index',
						table: 'test',
						destructive: false,
						details: '',
					},
				]),
			);

			expect(sql).toEqual([]);
		});

		it('should produce no SQL when all changes have missing meta', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_table',
						table: 'a',
						destructive: false,
						details: '',
					},
					{
						kind: 'add_column',
						table: 'b',
						column: 'x',
						destructive: false,
						details: '',
					},
					{
						kind: 'create_index',
						table: 'c',
						destructive: false,
						details: '',
					},
				]),
			);

			expect(sql).toEqual([]);
		});
	});

	// ========================================================================
	// 2. formatDefault edge cases
	// ========================================================================
	describe('formatDefault edge cases', () => {
		it('should handle { sql: "NOW()" } as raw SQL expression', () => {
			const col = makeCol({
				name: 'created_at',
				type: 'timestamp',
				default: { sql: 'NOW()' },
			});

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_column',
						table: 'events',
						column: 'created_at',
						destructive: false,
						details: '',
						meta: { column: col },
					},
				]),
			);

			expect(sql[0]).toContain('DEFAULT NOW()');
			// Raw SQL should NOT be quoted
			expect(sql[0]).not.toContain("DEFAULT 'NOW()'");
		});

		it('should handle string ending with () as function call', () => {
			const col = makeCol({
				name: 'id',
				type: 'uuid',
				nullable: false,
				default: 'gen_random_uuid()',
			});

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_column',
						table: 'items',
						column: 'id',
						destructive: false,
						details: '',
						meta: { column: col },
					},
				]),
			);

			expect(sql[0]).toContain('DEFAULT gen_random_uuid()');
			expect(sql[0]).not.toContain("'gen_random_uuid()'");
		});

		it('should handle regular string with single-quote escaping', () => {
			const col = makeCol({
				name: 'greeting',
				type: 'string',
				nullable: true,
				default: "it's",
			});

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_column',
						table: 'messages',
						column: 'greeting',
						destructive: false,
						details: '',
						meta: { column: col },
					},
				]),
			);

			expect(sql[0]).toContain("DEFAULT 'it''s'");
		});

		it('should handle plain string default', () => {
			const col = makeCol({
				name: 'status',
				type: 'string',
				nullable: true,
				default: 'hello',
			});

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_column',
						table: 'items',
						column: 'status',
						destructive: false,
						details: '',
						meta: { column: col },
					},
				]),
			);

			expect(sql[0]).toContain("DEFAULT 'hello'");
		});

		it('should handle number default without quotes', () => {
			const col = makeCol({
				name: 'count',
				type: 'integer',
				nullable: false,
				default: 42,
			});

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_column',
						table: 'counters',
						column: 'count',
						destructive: false,
						details: '',
						meta: { column: col },
					},
				]),
			);

			expect(sql[0]).toContain('DEFAULT 42');
			expect(sql[0]).not.toContain("DEFAULT '42'");
		});

		it('should handle zero as number default', () => {
			const col = makeCol({
				name: 'score',
				type: 'integer',
				nullable: false,
				default: 0,
			});

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_column',
						table: 'scores',
						column: 'score',
						destructive: false,
						details: '',
						meta: { column: col },
					},
				]),
			);

			expect(sql[0]).toContain('DEFAULT 0');
		});

		it('should handle boolean true default', () => {
			const col = makeCol({
				name: 'active',
				type: 'boolean',
				nullable: false,
				default: true,
			});

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_column',
						table: 'flags',
						column: 'active',
						destructive: false,
						details: '',
						meta: { column: col },
					},
				]),
			);

			expect(sql[0]).toContain('DEFAULT true');
		});

		it('should handle boolean false default', () => {
			const col = makeCol({
				name: 'disabled',
				type: 'boolean',
				nullable: false,
				default: false,
			});

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_column',
						table: 'flags',
						column: 'disabled',
						destructive: false,
						details: '',
						meta: { column: col },
					},
				]),
			);

			expect(sql[0]).toContain('DEFAULT false');
		});

		it('should handle null default as NULL', () => {
			const col = makeCol({
				name: 'notes',
				type: 'text',
				nullable: true,
				default: null,
			});

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_column',
						table: 'items',
						column: 'notes',
						destructive: false,
						details: '',
						meta: { column: col },
					},
				]),
			);

			expect(sql[0]).toContain('DEFAULT NULL');
		});

		it('should handle unknown object type as stringified fallback', () => {
			const col = makeCol({
				name: 'meta',
				type: 'text',
				nullable: true,
				default: { foo: 'bar' },
			});

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_column',
						table: 'items',
						column: 'meta',
						destructive: false,
						details: '',
						meta: { column: col },
					},
				]),
			);

			// Object without `sql` key → String({foo: 'bar'}) → '[object Object]'
			expect(sql[0]).toContain("DEFAULT '[object Object]'");
		});

		it('should handle negative number default', () => {
			const col = makeCol({
				name: 'offset',
				type: 'integer',
				nullable: false,
				default: -1,
			});

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_column',
						table: 'config',
						column: 'offset',
						destructive: false,
						details: '',
						meta: { column: col },
					},
				]),
			);

			expect(sql[0]).toContain('DEFAULT -1');
		});
	});

	// ========================================================================
	// 3. alter_column_type fallback
	// ========================================================================
		describe('alter_column_type fallback', () => {
			it('should validate and use toType when meta.column is undefined', () => {
				const sql = generateMigrationSQL(
					makeDiff([
					{
						kind: 'alter_column_type',
						table: 'users',
						column: 'age',
						destructive: true,
						details: '',
						meta: { fromType: 'integer', toType: 'bigint' },
					},
				]),
			);

				expect(sql[0]).toBe(
					'ALTER TABLE "users" ALTER COLUMN "age" TYPE bigint;',
				);
			});

			it('rejects unsafe toType when meta.column is undefined', () => {
				expect(() =>
					generateMigrationSQL(
						makeDiff([
							{
								kind: 'alter_column_type',
								table: 'users',
								column: 'age',
								destructive: true,
								details: '',
								meta: {
									fromType: 'integer',
									toType: 'bigint; DROP TABLE users; --',
								},
							},
						]),
					),
				).toThrow(/Unsafe database type name/);
			});

			it('rejects unsafe fromType when generating fallback rollback SQL', () => {
				expect(() =>
					generateDownSQL(
						makeDiff([
							{
								kind: 'alter_column_type',
								table: 'users',
								column: 'age',
								destructive: true,
								details: '',
								meta: {
									fromType: 'integer; DROP TABLE users; --',
									toType: 'bigint',
								},
							},
						]),
					),
				).toThrow(/Unsafe database type name/);
			});

			it('should prefer mapColumnType(col) when meta.column is provided', () => {
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

			// mapColumnType maps 'bigint' to 'BIGINT'
			expect(sql[0]).toBe(
				'ALTER TABLE "users" ALTER COLUMN "age" TYPE BIGINT;',
			);
		});
	});

	// ========================================================================
	// 4. Schema-qualified generateCreateTableSQL
	// ========================================================================
	describe('schema-qualified CREATE TABLE', () => {
		it('should prefix table name with schema', () => {
			const table = makeTable(
				'accounts',
				[makeCol({ name: 'id', type: 'integer' })],
				'id',
			);

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_table',
						table: 'accounts',
						destructive: false,
						details: '',
						meta: { table },
					},
				]),
				{ schemaName: 'my_schema' },
			);

			expect(sql[0]).toContain('CREATE TABLE "my_schema"."accounts"');
		});
	});

	// ========================================================================
	// 5. generateCreateTableSQL variations
	// ========================================================================
	describe('generateCreateTableSQL variations', () => {
		it('should omit NOT NULL for nullable column', () => {
			const table = makeTable('items', [
				makeCol({ name: 'description', type: 'text', nullable: true }),
			]);

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_table',
						table: 'items',
						destructive: false,
						details: '',
						meta: { table },
					},
				]),
			);

			expect(sql[0]).toContain('"description" TEXT');
			expect(sql[0]).not.toContain('NOT NULL');
		});

		it('should omit NOT NULL for autoIncrement column', () => {
			const table = makeTable('items', [
				makeCol({
					name: 'id',
					type: 'integer',
					autoIncrement: true,
					nullable: false,
				}),
			]);

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_table',
						table: 'items',
						destructive: false,
						details: '',
						meta: { table },
					},
				]),
			);

			expect(sql[0]).toContain('"id" SERIAL');
			expect(sql[0]).not.toContain('NOT NULL');
		});

		it('should include DEFAULT clause for column with default', () => {
			const table = makeTable('items', [
				makeCol({
					name: 'status',
					type: 'string',
					nullable: false,
					default: 'draft',
				}),
			]);

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_table',
						table: 'items',
						destructive: false,
						details: '',
						meta: { table },
					},
				]),
			);

			expect(sql[0]).toContain(
				'"status" VARCHAR(255) NOT NULL DEFAULT \'draft\'',
			);
		});

		it('should include UNIQUE for unique column', () => {
			const table = makeTable('items', [
				makeCol({
					name: 'code',
					type: 'string',
					nullable: false,
					unique: true,
				}),
			]);

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_table',
						table: 'items',
						destructive: false,
						details: '',
						meta: { table },
					},
				]),
			);

			expect(sql[0]).toContain('"code" VARCHAR(255) NOT NULL UNIQUE');
		});

		it('should omit PK constraint when primaryKey is undefined', () => {
			const table = makeTable('tags', [
				makeCol({ name: 'label', type: 'string', nullable: false }),
			]);

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_table',
						table: 'tags',
						destructive: false,
						details: '',
						meta: { table },
					},
				]),
			);

			expect(sql[0]).not.toContain('PRIMARY KEY');
			expect(sql[0]).not.toContain('CONSTRAINT');
		});

		it('should generate composite PK from array primaryKey', () => {
			const table = makeTable(
				'order_items',
				[
					makeCol({ name: 'order_id', type: 'integer', nullable: false }),
					makeCol({ name: 'product_id', type: 'integer', nullable: false }),
					makeCol({ name: 'quantity', type: 'integer', nullable: false }),
				],
				['order_id', 'product_id'],
			);

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_table',
						table: 'order_items',
						destructive: false,
						details: '',
						meta: { table },
					},
				]),
			);

			expect(sql[0]).toContain(
				'CONSTRAINT "pk_order_items" PRIMARY KEY ("order_id", "product_id")',
			);
		});

		it('should combine all column modifiers in correct order', () => {
			const table = makeTable('items', [
				makeCol({
					name: 'code',
					type: 'string',
					nullable: false,
					default: 'X',
					unique: true,
				}),
			]);

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_table',
						table: 'items',
						destructive: false,
						details: '',
						meta: { table },
					},
				]),
			);

			// Order: name type NOT NULL DEFAULT 'X' UNIQUE
			expect(sql[0]).toContain(
				'"code" VARCHAR(255) NOT NULL DEFAULT \'X\' UNIQUE',
			);
		});
	});

	// ========================================================================
	// 6. generateAddFKSQL variations
	// ========================================================================
	describe('generateAddFKSQL variations', () => {
		it('should omit ON DELETE when fk.onDelete is undefined', () => {
			const fk: ForeignKeyIR = {
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
				'ALTER TABLE "posts" ADD CONSTRAINT "fk_posts_author_id" FOREIGN KEY ("author_id") REFERENCES "users" ("id");',
			);
			expect(sql[0]).not.toContain('ON DELETE');
		});

		it('should generate schema-qualified FK table', () => {
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
				{ schemaName: 'tenant_1' },
			);

			expect(sql[0]).toContain('ALTER TABLE "tenant_1"."posts"');
			// REFERENCES must also be schema-qualified so PostgreSQL resolves within the same schema
			expect(sql[0]).toContain('REFERENCES "tenant_1"."users"');
		});

		it('should handle composite FK columns', () => {
			const fk: ForeignKeyIR = {
				columns: ['org_id', 'dept_id'],
				references: { table: 'departments', columns: ['org_id', 'id'] },
				onDelete: 'RESTRICT',
			};

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_foreign_key',
						table: 'employees',
						destructive: false,
						details: '',
						meta: { fk },
					},
				]),
			);

			expect(sql[0]).toContain('CONSTRAINT "fk_employees_org_id_dept_id"');
			expect(sql[0]).toContain('FOREIGN KEY ("org_id", "dept_id")');
			expect(sql[0]).toContain('REFERENCES "departments" ("org_id", "id")');
			expect(sql[0]).toContain('ON DELETE RESTRICT');
		});
	});

	// ========================================================================
	// 7. Destructive filtering edge cases
	// ========================================================================
	describe('destructive filtering edge cases', () => {
		it('should keep only non-destructive when mix with includeDestructive=false', () => {
			const col = makeCol({
				name: 'bio',
				type: 'text',
				nullable: true,
			});
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
			};

			const sql = generateMigrationSQL(
				makeDiff([
					// destructive: should be filtered
					{
						kind: 'drop_table',
						table: 'old',
						destructive: true,
						details: '',
					},
					// destructive: should be filtered
					{
						kind: 'drop_column',
						table: 'users',
						column: 'legacy',
						destructive: true,
						details: '',
					},
					// destructive: should be filtered
					{
						kind: 'drop_foreign_key',
						table: 'posts',
						destructive: true,
						details: '',
						meta: { fk },
					},
					// non-destructive: should remain
					{
						kind: 'add_column',
						table: 'users',
						column: 'bio',
						destructive: false,
						details: '',
						meta: { column: col },
					},
				]),
				{ includeDestructive: false },
			);

			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain('ADD COLUMN "bio"');
		});

		it('should return empty array when all changes are destructive and filtering is on', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'drop_table',
						table: 'a',
						destructive: true,
						details: '',
					},
					{
						kind: 'drop_column',
						table: 'b',
						column: 'c',
						destructive: true,
						details: '',
					},
				]),
				{ includeDestructive: false },
			);

			expect(sql).toEqual([]);
		});

		it('should include all changes when includeDestructive is explicitly true', () => {
			const col = makeCol({
				name: 'new_col',
				type: 'text',
				nullable: true,
			});

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'drop_table',
						table: 'old',
						destructive: true,
						details: '',
					},
					{
						kind: 'add_column',
						table: 'users',
						column: 'new_col',
						destructive: false,
						details: '',
						meta: { column: col },
					},
				]),
				{ includeDestructive: true },
			);

			expect(sql).toHaveLength(2);
			expect(sql[0]).toContain('DROP TABLE');
			expect(sql[1]).toContain('ADD COLUMN');
		});
	});

	// ========================================================================
	// 8. alter_column_default edge cases
	// ========================================================================
	describe('alter_column_default edge cases', () => {
		it('should DROP DEFAULT when meta.default is null', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'alter_column_default',
						table: 'users',
						column: 'role',
						destructive: false,
						details: '',
						meta: { default: null },
					},
				]),
			);

			expect(sql[0]).toBe(
				'ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;',
			);
		});

		it('should SET DEFAULT with number via alter_column_default', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'alter_column_default',
						table: 'counters',
						column: 'count',
						destructive: false,
						details: '',
						meta: { default: 100 },
					},
				]),
			);

			expect(sql[0]).toBe(
				'ALTER TABLE "counters" ALTER COLUMN "count" SET DEFAULT 100;',
			);
		});

		it('should SET DEFAULT with boolean via alter_column_default', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'alter_column_default',
						table: 'flags',
						column: 'active',
						destructive: false,
						details: '',
						meta: { default: true },
					},
				]),
			);

			expect(sql[0]).toBe(
				'ALTER TABLE "flags" ALTER COLUMN "active" SET DEFAULT true;',
			);
		});
	});

	// ========================================================================
	// 9. Index name generation fallback
	// ========================================================================
	describe('index name generation', () => {
		it('should auto-generate index name when idx.name is undefined', () => {
			const idx: IndexIR = {
				columns: ['email', 'tenant_id'],
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
				'CREATE INDEX IF NOT EXISTS "idx_users_email_tenant_id" ON "users" ("email", "tenant_id");',
			);
		});

		it('should auto-generate drop index name when idx.name is undefined', () => {
			const idx: IndexIR = {
				columns: ['status'],
				unique: false,
			};

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'drop_index',
						table: 'orders',
						destructive: false,
						details: '',
						meta: { index: idx },
					},
				]),
			);

			expect(sql[0]).toBe('DROP INDEX IF EXISTS "idx_orders_status";');
		});
	});

	// ========================================================================
	// 10. add_column with autoIncrement (no NOT NULL)
	// ========================================================================
	describe('add_column with autoIncrement', () => {
		it('should omit NOT NULL for autoIncrement column', () => {
			const col = makeCol({
				name: 'seq',
				type: 'integer',
				nullable: false,
				autoIncrement: true,
			});

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'add_column',
						table: 'events',
						column: 'seq',
						destructive: false,
						details: '',
						meta: { column: col },
					},
				]),
			);

			expect(sql[0]).toContain('SERIAL');
			expect(sql[0]).not.toContain('NOT NULL');
		});
	});

	// ========================================================================
	// 11. Schema-qualified alter changes
	// ========================================================================
	describe('schema-qualified changes', () => {
		it('should schema-qualify ALTER TABLE for add_column', () => {
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
				{ schemaName: 'tenant_5' },
			);

			expect(sql[0]).toContain('ALTER TABLE "tenant_5"."users"');
		});

		it('should schema-qualify ALTER TABLE for drop_column', () => {
			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'drop_column',
						table: 'users',
						column: 'legacy',
						destructive: true,
						details: '',
					},
				]),
				{ schemaName: 'tenant_5' },
			);

			expect(sql[0]).toContain('ALTER TABLE "tenant_5"."users"');
		});

		it('should schema-qualify ALTER TABLE for alter_column_type', () => {
			const col = makeCol({ name: 'age', type: 'bigint' });

			const sql = generateMigrationSQL(
				makeDiff([
					{
						kind: 'alter_column_type',
						table: 'users',
						column: 'age',
						destructive: true,
						details: '',
						meta: { column: col },
					},
				]),
				{ schemaName: 'tenant_5' },
			);

			expect(sql[0]).toContain('ALTER TABLE "tenant_5"."users"');
		});

		it('should schema-qualify CREATE INDEX', () => {
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
				{ schemaName: 'tenant_5' },
			);

			expect(sql[0]).toContain('ON "tenant_5"."users"');
		});

		it('should schema-qualify alter_foreign_key drop+add', () => {
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
						meta: { fk },
					},
				]),
				{ schemaName: 'tenant_5' },
			);

			expect(sql[0]).toContain(
				'ALTER TABLE "tenant_5"."posts" DROP CONSTRAINT',
			);
			expect(sql[0]).toContain('ALTER TABLE "tenant_5"."posts" ADD CONSTRAINT');
		});
	});
});

// ============================================================================
// RLS Policy SQL Injection Prevention (SEC-DDL)
// ============================================================================

describe('create_policy SQL injection prevention', () => {
	it('rejects semicolon in USING expression', () => {
		const policy: PolicyIR = {
			name: 'bad',
			using: 'true; DROP TABLE users',
		};
		expect(() =>
			generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_policy',
						table: 'documents',
						destructive: false,
						details: '',
						meta: { policy },
					},
				]),
			),
		).toThrow('Unsafe SQL expression in USING expression');
	});

	it('rejects -- comment in USING expression', () => {
		const policy: PolicyIR = {
			name: 'bad',
			using: '1=1 -- ignore rest',
		};
		expect(() =>
			generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_policy',
						table: 'documents',
						destructive: false,
						details: '',
						meta: { policy },
					},
				]),
			),
		).toThrow('Unsafe SQL expression in USING expression');
	});

	it('rejects /* comment in WITH CHECK expression', () => {
		const policy: PolicyIR = {
			name: 'bad',
			withCheck: '/* injected */ true',
		};
		expect(() =>
			generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_policy',
						table: 'documents',
						destructive: false,
						details: '',
						meta: { policy },
					},
				]),
			),
		).toThrow('Unsafe SQL expression in WITH CHECK expression');
	});

	it('rejects backslash in WITH CHECK expression', () => {
		const policy: PolicyIR = {
			name: 'bad',
			withCheck: 'owner_id = 1; DROP TABLE users',
		};
		expect(() =>
			generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_policy',
						table: 'documents',
						destructive: false,
						details: '',
						meta: { policy },
					},
				]),
			),
		).toThrow('Unsafe SQL expression in WITH CHECK expression');
	});

	it('accepts safe expressions without throwing', () => {
		const policy: PolicyIR = {
			name: 'safe',
			using: 'owner_id = current_user_id()',
			withCheck: 'tenant_id = get_tenant_id()',
		};
		expect(() =>
			generateMigrationSQL(
				makeDiff([
					{
						kind: 'create_policy',
						table: 'documents',
						destructive: false,
						details: '',
						meta: { policy },
					},
				]),
			),
		).not.toThrow();
	});
});
