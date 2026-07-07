// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for migration-sql.ts
 *
 * Focuses on branches not covered by migration-sql.test.ts:
 * - includeDestructive=false filtering
 * - alter_foreign_key (drop + re-add)
 * - formatDefault edge cases (sql object, boolean, number, null, string ending with ())
 * - create_table with composite PK, unique columns, autoIncrement columns
 * - generateAddFKSQL with/without schema, with/without onDelete
 * - drop_index with/without schemaName
 * - create_index with auto-generated name
 * - alter_column_type with column meta vs toType fallback
 * - alter_column_default drop vs set
 * - Missing meta returns undefined for various change kinds
 */

import type { ForeignKeyIR, IndexIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { generateMigrationSQL } from './migration-sql.js';
import type { SchemaChange, SchemaDiff } from './schema-diff.js';

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

describe('migration-sql coverage', () => {
	describe('includeDestructive=false', () => {
		it('filters out destructive changes', () => {
			const diff = makeDiff([
				{
					kind: 'drop_table',
					table: 'old',
					destructive: true,
					details: 'drop',
				},
				{
					kind: 'add_column',
					table: 'users',
					destructive: false,
					details: 'add col',
					meta: { column: { name: 'x', type: 'string', nullable: false } },
				},
			]);
			const sql = generateMigrationSQL(diff, { includeDestructive: false });
			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain('ADD COLUMN');
		});
	});

	describe('alter_foreign_key (drop + re-add)', () => {
		it('generates drop + add statements', () => {
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				onDelete: 'CASCADE',
			};
			const diff = makeDiff([
				{
					kind: 'alter_foreign_key',
					table: 'posts',
					destructive: false,
					details: 'alter fk',
					meta: { fk },
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql).toHaveLength(1);
			expect(sql[0]).toContain('DROP CONSTRAINT IF EXISTS');
			expect(sql[0]).toContain('ADD CONSTRAINT');
			expect(sql[0]).toContain('ON DELETE CASCADE');
		});

		it('returns undefined when meta.fk is missing', () => {
			const diff = makeDiff([
				{
					kind: 'alter_foreign_key',
					table: 'posts',
					destructive: false,
					details: 'alter fk',
					meta: {},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql).toHaveLength(0);
		});
	});

	describe('formatDefault edge cases', () => {
		it('handles sql object { sql: "now()" }', () => {
			const diff = makeDiff([
				{
					kind: 'alter_column_default',
					table: 't',
					column: 'c',
					destructive: false,
					details: 'set default',
					meta: { default: { sql: 'now()' } },
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain('SET DEFAULT now()');
		});

		it('handles boolean true default', () => {
			const diff = makeDiff([
				{
					kind: 'add_column',
					table: 't',
					destructive: false,
					details: 'add col',
					meta: {
						column: {
							name: 'active',
							type: 'boolean',
							nullable: false,
							default: true,
						},
					},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain('DEFAULT true');
		});

		it('handles boolean false default', () => {
			const diff = makeDiff([
				{
					kind: 'add_column',
					table: 't',
					destructive: false,
					details: 'add col',
					meta: {
						column: {
							name: 'active',
							type: 'boolean',
							nullable: false,
							default: false,
						},
					},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain('DEFAULT false');
		});

		it('handles number default', () => {
			const diff = makeDiff([
				{
					kind: 'add_column',
					table: 't',
					destructive: false,
					details: 'add col',
					meta: {
						column: {
							name: 'count',
							type: 'integer',
							nullable: false,
							default: 42,
						},
					},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain('DEFAULT 42');
		});

		it('handles null default', () => {
			const diff = makeDiff([
				{
					kind: 'alter_column_default',
					table: 't',
					column: 'c',
					destructive: false,
					details: 'set default',
					meta: { default: null },
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain('DROP DEFAULT');
		});

		it('handles undefined default (drop)', () => {
			const diff = makeDiff([
				{
					kind: 'alter_column_default',
					table: 't',
					column: 'c',
					destructive: false,
					details: 'drop default',
					meta: { default: undefined },
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain('DROP DEFAULT');
		});

		it('handles string ending with () as function call', () => {
			const diff = makeDiff([
				{
					kind: 'add_column',
					table: 't',
					destructive: false,
					details: 'add col',
					meta: {
						column: {
							name: 'ts',
							type: 'datetime',
							nullable: false,
							default: 'now()',
						},
					},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain('DEFAULT now()');
		});

		it('handles regular string default with single quotes', () => {
			const diff = makeDiff([
				{
					kind: 'add_column',
					table: 't',
					destructive: false,
					details: 'add col',
					meta: {
						column: {
							name: 'status',
							type: 'string',
							nullable: false,
							default: 'active',
						},
					},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain("DEFAULT 'active'");
		});

		it('escapes single quotes in string defaults', () => {
			const diff = makeDiff([
				{
					kind: 'add_column',
					table: 't',
					destructive: false,
					details: 'add col',
					meta: {
						column: {
							name: 's',
							type: 'string',
							nullable: false,
							default: "it's",
						},
					},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain("DEFAULT 'it''s'");
		});

		it('handles set default with concrete value', () => {
			const diff = makeDiff([
				{
					kind: 'alter_column_default',
					table: 't',
					column: 'c',
					destructive: false,
					details: 'set default',
					meta: { default: 'hello' },
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain("SET DEFAULT 'hello'");
		});
	});

	describe('create_table edge cases', () => {
		it('returns undefined when meta.table is missing', () => {
			const diff = makeDiff([
				{
					kind: 'create_table',
					table: 't',
					destructive: false,
					details: 'create',
					meta: {},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql).toHaveLength(0);
		});

		it('creates table with composite primary key', () => {
			const table: TableIR = {
				name: 't',
				columns: [
					{ name: 'a', type: 'integer', nullable: false },
					{ name: 'b', type: 'integer', nullable: false },
				],
				primaryKey: ['a', 'b'],
				foreignKeys: [],
				indexes: [],
			};
			const diff = makeDiff([
				{
					kind: 'create_table',
					table: 't',
					destructive: false,
					details: 'create',
					meta: { table },
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain('"a", "b"');
			expect(sql[0]).toContain('PRIMARY KEY');
		});

		it('creates table with unique column', () => {
			const table: TableIR = {
				name: 't',
				columns: [
					{ name: 'id', type: 'integer', nullable: false },
					{ name: 'email', type: 'string', nullable: false, unique: true },
				],
				primaryKey: 'id',
				foreignKeys: [],
				indexes: [],
			};
			const diff = makeDiff([
				{
					kind: 'create_table',
					table: 't',
					destructive: false,
					details: 'create',
					meta: { table },
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain('UNIQUE');
		});

		it('creates table with autoIncrement column (not NOT NULL)', () => {
			const table: TableIR = {
				name: 't',
				columns: [
					{ name: 'id', type: 'integer', nullable: false, autoIncrement: true },
				],
				primaryKey: 'id',
				foreignKeys: [],
				indexes: [],
			};
			const diff = makeDiff([
				{
					kind: 'create_table',
					table: 't',
					destructive: false,
					details: 'create',
					meta: { table },
				},
			]);
			const sql = generateMigrationSQL(diff);
			// autoIncrement skips NOT NULL
			expect(sql[0]).not.toContain('NOT NULL');
			expect(sql[0]).toContain('SERIAL');
		});

		it('creates table with schema qualification', () => {
			const table: TableIR = {
				name: 't',
				columns: [{ name: 'id', type: 'integer', nullable: false }],
				primaryKey: 'id',
				foreignKeys: [],
				indexes: [],
			};
			const diff = makeDiff([
				{
					kind: 'create_table',
					table: 't',
					destructive: false,
					details: 'create',
					meta: { table },
				},
			]);
			const sql = generateMigrationSQL(diff, { schemaName: 'myschema' });
			expect(sql[0]).toContain('"myschema"."t"');
		});

		it('creates table without PK when primaryKey is undefined', () => {
			const table: TableIR = {
				name: 't',
				columns: [{ name: 'x', type: 'text', nullable: true }],
				foreignKeys: [],
				indexes: [],
			};
			const diff = makeDiff([
				{
					kind: 'create_table',
					table: 't',
					destructive: false,
					details: 'create',
					meta: { table },
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).not.toContain('PRIMARY KEY');
		});
	});

	describe('add_column edge cases', () => {
		it('returns undefined when meta.column is missing', () => {
			const diff = makeDiff([
				{
					kind: 'add_column',
					table: 't',
					destructive: false,
					details: 'add col',
					meta: {},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql).toHaveLength(0);
		});

		it('adds column with UNIQUE constraint', () => {
			const diff = makeDiff([
				{
					kind: 'add_column',
					table: 't',
					destructive: false,
					details: 'add col',
					meta: {
						column: {
							name: 'email',
							type: 'string',
							nullable: false,
							unique: true,
						},
					},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain('UNIQUE');
		});

		it('adds autoIncrement column (skips NOT NULL)', () => {
			const diff = makeDiff([
				{
					kind: 'add_column',
					table: 't',
					destructive: false,
					details: 'add col',
					meta: {
						column: {
							name: 'id',
							type: 'integer',
							nullable: false,
							autoIncrement: true,
						},
					},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).not.toContain('NOT NULL');
		});
	});

	describe('alter_column_type', () => {
		it('uses mapColumnType when column meta is present', () => {
			const diff = makeDiff([
				{
					kind: 'alter_column_type',
					table: 't',
					column: 'c',
					destructive: false,
					details: 'alter type',
					meta: { column: { name: 'c', type: 'bigint', nullable: false } },
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain('TYPE BIGINT');
		});

		it('uses meta.toType when column meta is absent', () => {
			const diff = makeDiff([
				{
					kind: 'alter_column_type',
					table: 't',
					column: 'c',
					destructive: false,
					details: 'alter type',
					meta: { toType: 'TEXT' },
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain('TYPE TEXT');
		});

		it('validates meta.toType when column meta is absent', () => {
			const diff = makeDiff([
				{
					kind: 'alter_column_type',
					table: 't',
					column: 'c',
					destructive: false,
					details: 'alter type',
					meta: { toType: 'integer NOT NULL' },
				},
			]);
			expect(() => generateMigrationSQL(diff)).toThrow(
				/Unsafe database type name/,
			);
		});
	});

	describe('alter_column_nullable', () => {
		it('generates DROP NOT NULL for nullable=true', () => {
			const diff = makeDiff([
				{
					kind: 'alter_column_nullable',
					table: 't',
					column: 'c',
					destructive: false,
					details: 'set nullable',
					meta: { nullable: true },
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain('DROP NOT NULL');
		});

		it('generates SET NOT NULL for nullable=false', () => {
			const diff = makeDiff([
				{
					kind: 'alter_column_nullable',
					table: 't',
					column: 'c',
					destructive: false,
					details: 'set not null',
					meta: { nullable: false },
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain('SET NOT NULL');
		});
	});

	describe('add_foreign_key', () => {
		it('returns undefined when meta.fk is missing', () => {
			const diff = makeDiff([
				{
					kind: 'add_foreign_key',
					table: 't',
					destructive: false,
					details: 'add fk',
					meta: {},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql).toHaveLength(0);
		});

		it('generates FK without onDelete when not specified', () => {
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
			};
			const diff = makeDiff([
				{
					kind: 'add_foreign_key',
					table: 'posts',
					destructive: false,
					details: 'add fk',
					meta: { fk },
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).not.toContain('ON DELETE');
		});

		it('generates FK with schema qualification', () => {
			const fk: ForeignKeyIR = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
				onDelete: 'SET NULL',
			};
			const diff = makeDiff([
				{
					kind: 'add_foreign_key',
					table: 'posts',
					destructive: false,
					details: 'add fk',
					meta: { fk },
				},
			]);
			const sql = generateMigrationSQL(diff, { schemaName: 'app' });
			expect(sql[0]).toContain('"app"."posts"');
			expect(sql[0]).toContain('ON DELETE SET NULL');
		});
	});

	describe('drop_foreign_key', () => {
		it('returns undefined when meta.fk is missing', () => {
			const diff = makeDiff([
				{
					kind: 'drop_foreign_key',
					table: 't',
					destructive: true,
					details: 'drop fk',
					meta: {},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql).toHaveLength(0);
		});
	});

	describe('create_index', () => {
		it('returns undefined when meta.index is missing', () => {
			const diff = makeDiff([
				{
					kind: 'create_index',
					table: 't',
					destructive: false,
					details: 'create idx',
					meta: {},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql).toHaveLength(0);
		});

		it('generates auto-named index when idx.name is undefined', () => {
			const idx: IndexIR = { columns: ['email'], name: undefined };
			const diff = makeDiff([
				{
					kind: 'create_index',
					table: 'users',
					destructive: false,
					details: 'create idx',
					meta: { index: idx },
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain('"idx_users_email"');
		});

		it('generates UNIQUE index', () => {
			const idx: IndexIR = {
				columns: ['email'],
				unique: true,
				name: 'ux_email',
			};
			const diff = makeDiff([
				{
					kind: 'create_index',
					table: 'users',
					destructive: false,
					details: 'create idx',
					meta: { index: idx },
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain('UNIQUE INDEX');
		});
	});

	describe('drop_index', () => {
		it('returns undefined when meta.index is missing', () => {
			const diff = makeDiff([
				{
					kind: 'drop_index',
					table: 't',
					destructive: true,
					details: 'drop idx',
					meta: {},
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql).toHaveLength(0);
		});

		it('generates schema-qualified drop when schemaName provided', () => {
			const idx: IndexIR = { columns: ['email'], name: 'idx_email' };
			const diff = makeDiff([
				{
					kind: 'drop_index',
					table: 'users',
					destructive: true,
					details: 'drop idx',
					meta: { index: idx },
				},
			]);
			const sql = generateMigrationSQL(diff, { schemaName: 'app' });
			expect(sql[0]).toContain('"app"."idx_email"');
		});

		it('generates unqualified drop when no schemaName', () => {
			const idx: IndexIR = { columns: ['email'], name: 'idx_email' };
			const diff = makeDiff([
				{
					kind: 'drop_index',
					table: 'users',
					destructive: true,
					details: 'drop idx',
					meta: { index: idx },
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain('"idx_email"');
			expect(sql[0]).not.toContain('"".');
		});

		it('generates auto-named index for drop when name is undefined', () => {
			const idx: IndexIR = { columns: ['email'], name: undefined };
			const diff = makeDiff([
				{
					kind: 'drop_index',
					table: 'users',
					destructive: true,
					details: 'drop idx',
					meta: { index: idx },
				},
			]);
			const sql = generateMigrationSQL(diff);
			expect(sql[0]).toContain('"idx_users_email"');
		});
	});

	describe('topological ordering', () => {
		it('orders drops before creates', () => {
			const diff = makeDiff([
				{
					kind: 'create_index',
					table: 't',
					destructive: false,
					details: 'create',
					meta: { index: { columns: ['x'], name: 'idx_new' } },
				},
				{
					kind: 'drop_foreign_key',
					table: 't',
					destructive: true,
					details: 'drop fk',
					meta: {
						fk: { columns: ['y'], references: { table: 'z', columns: ['id'] } },
					},
				},
			]);
			const sql = generateMigrationSQL(diff);
			// drop_foreign_key (phase 0) should come before create_index (phase 11)
			const dropIdx = sql.findIndex((s) => s.includes('DROP CONSTRAINT'));
			const createIdx = sql.findIndex((s) => s.includes('CREATE'));
			expect(dropIdx).toBeLessThan(createIdx);
		});
	});
});
