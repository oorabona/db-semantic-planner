// @ts-nocheck — coverage test: runtime assertions
/**
 * Coverage tests for schema-codegen.ts — targets uncovered branches
 * not in schema-codegen.test.ts.
 *
 * Focus: unique columns, composite primary keys, multi-column FKs,
 * non-'id' FK reference columns, onDelete actions, originalDbType on short-form + ref columns,
 * FK with both nullable and unique, self-ref with non-'parent' base name,
 * empty model, absent warnings section, camelCase dbCasing option.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelIR, TableIR } from '@dbsp/core';
import { ref, schema } from '@dbsp/core';
import type { ForeignKeyIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { loadSchema } from '../utils/schema-loader.js';
import { generateSchemaFile } from './schema-codegen.js';

describe('generateSchemaFile — coverage', () => {
	// -----------------------------------------------------------------------
	// unique columns
	// -----------------------------------------------------------------------
	describe('unique columns', () => {
		it('generates unique: true in long form for unique non-PK columns', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					email: { type: 'string', unique: true },
				},
			}).model;

			const result = generateSchemaFile(model);

			expect(result).toContain("email: { type: 'string', unique: true }");
		});
	});

	// -----------------------------------------------------------------------
	// composite primary keys
	// -----------------------------------------------------------------------
	describe('composite primary keys', () => {
		it('marks columns in composite PK array', () => {
			// Manually construct a model with composite PK
			const tables = new Map<string, TableIR>([
				[
					'order_items',
					{
						name: 'order_items',
						columns: [
							{ name: 'orderId', type: 'integer', nullable: false },
							{ name: 'productId', type: 'integer', nullable: false },
							{ name: 'quantity', type: 'integer', nullable: false },
						],
						primaryKey: ['orderId', 'productId'],
						foreignKeys: [],
						indexes: [],
					},
				],
			]);
			const model: ModelIR = {
				tables,
				relations: new Map(),
				getTable: (n) => tables.get(n),
				getRelation: () => undefined,
				getRelationsFrom: () => [],
				getRelationsTo: () => [],
				isAmbiguous: () => ({ ambiguous: false, options: [] }),
			};

			const result = generateSchemaFile(model);

			expect(result).toContain(
				"orderId: { type: 'integer', primaryKey: true }",
			);
			expect(result).toContain(
				"productId: { type: 'integer', primaryKey: true }",
			);
			// quantity should be short form (not PK, not nullable)
			expect(result).toContain("quantity: 'integer'");
		});
	});

	// -----------------------------------------------------------------------
	// multi-column FK
	// -----------------------------------------------------------------------
	describe('multi-column foreign keys', () => {
		it('emits loadable table-level ref() constraints for composite relations', async () => {
			const tables = new Map<string, TableIR>([
				[
					'orders',
					{
						name: 'orders',
						columns: [
							{ name: 'orderId', type: 'integer', nullable: false },
							{ name: 'lineId', type: 'integer', nullable: false },
						],
						primaryKey: ['orderId', 'lineId'],
						foreignKeys: [],
						indexes: [],
					},
				],
				[
					'items',
					{
						name: 'items',
						columns: [
							{ name: 'id', type: 'integer', nullable: false },
							{ name: 'orderId', type: 'integer', nullable: false },
							{ name: 'lineId', type: 'integer', nullable: false },
						],
						primaryKey: 'id',
						foreignKeys: [
							{
								columns: ['orderId', 'lineId'],
								references: { table: 'orders', columns: ['orderId', 'lineId'] },
							},
						],
						indexes: [],
					},
				],
			]);
			const model: ModelIR = {
				tables,
				relations: new Map(),
				getTable: (n) => tables.get(n),
				getRelation: () => undefined,
				getRelationsFrom: () => [],
				getRelationsTo: () => [],
				isAmbiguous: () => ({ ambiguous: false, options: [] }),
			};

			const result = generateSchemaFile(model);

			// Single-column ref() lowering remains skipped, but the composite
			// table-level constraint is preserved.
			expect(result).toContain(
				"ref('orders', { columns: ['orderId', 'lineId'], references: ['orderId', 'lineId'] })",
			);
			expect(result).toContain('foreignKeys: [');
			expect(result).not.toContain('export const relations');
			// Columns should be rendered as regular columns
			expect(result).toContain("orderId: 'integer'");

			const tmpDir = mkdtempSync(join(process.cwd(), '.tmp-schema-codegen-'));
			try {
				const schemaPath = join(tmpDir, 'dbsp.schema.ts');
				writeFileSync(schemaPath, result, 'utf8');

				const loaded = await loadSchema(schemaPath);
				expect(loaded.model.getRelation('items.order')).toMatchObject({
					type: 'belongsTo',
					source: 'items',
					target: 'orders',
					foreignKey: ['orderId', 'lineId'],
					targetKey: ['orderId', 'lineId'],
				});
				expect(loaded.model.getRelation('orders.items')).toMatchObject({
					type: 'hasMany',
					source: 'orders',
					target: 'items',
					foreignKey: ['orderId', 'lineId'],
					sourceKey: ['orderId', 'lineId'],
				});
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	// -----------------------------------------------------------------------
	// FK with non-'id' reference column
	// -----------------------------------------------------------------------
	describe('FK referencing non-id column', () => {
		it('generates ref() without column option when ref is id (default)', () => {
			const tables = new Map<string, TableIR>([
				[
					'posts',
					{
						name: 'posts',
						columns: [
							{ name: 'id', type: 'integer', nullable: false },
							{ name: 'authorId', type: 'integer', nullable: false },
						],
						primaryKey: 'id',
						foreignKeys: [
							{
								columns: ['authorId'],
								references: { table: 'users', columns: ['id'] },
							},
						],
						indexes: [],
					},
				],
			]);
			const model: ModelIR = {
				tables,
				relations: new Map(),
				getTable: (n) => tables.get(n),
				getRelation: () => undefined,
				getRelationsFrom: () => [],
				getRelationsTo: () => [],
				isAmbiguous: () => ({ ambiguous: false, options: [] }),
			};

			const result = generateSchemaFile(model);

			// Simple ref (targets id → no column option)
			expect(result).toContain("authorId: ref('users')");
		});
	});

	// -----------------------------------------------------------------------
	// FK with onDelete action
	// -----------------------------------------------------------------------
	describe('FK with onDelete action', () => {
		it('includes onDelete option for CASCADE', () => {
			const tables = new Map<string, TableIR>([
				[
					'comments',
					{
						name: 'comments',
						columns: [
							{ name: 'id', type: 'integer', nullable: false },
							{ name: 'postId', type: 'integer', nullable: false },
						],
						primaryKey: 'id',
						foreignKeys: [
							{
								columns: ['postId'],
								references: { table: 'posts', columns: ['id'] },
								onDelete: 'CASCADE',
							},
						],
						indexes: [],
					},
				],
			]);
			const model: ModelIR = {
				tables,
				relations: new Map(),
				getTable: (n) => tables.get(n),
				getRelation: () => undefined,
				getRelationsFrom: () => [],
				getRelationsTo: () => [],
				isAmbiguous: () => ({ ambiguous: false, options: [] }),
			};

			const result = generateSchemaFile(model);

			expect(result).toContain("onDelete: 'CASCADE'");
		});

		it('omits onDelete for NO ACTION (default)', () => {
			const tables = new Map<string, TableIR>([
				[
					'comments',
					{
						name: 'comments',
						columns: [
							{ name: 'id', type: 'integer', nullable: false },
							{ name: 'postId', type: 'integer', nullable: false },
						],
						primaryKey: 'id',
						foreignKeys: [
							{
								columns: ['postId'],
								references: { table: 'posts', columns: ['id'] },
								onDelete: 'NO ACTION',
							},
						],
						indexes: [],
					},
				],
			]);
			const model: ModelIR = {
				tables,
				relations: new Map(),
				getTable: (n) => tables.get(n),
				getRelation: () => undefined,
				getRelationsFrom: () => [],
				getRelationsTo: () => [],
				isAmbiguous: () => ({ ambiguous: false, options: [] }),
			};

			const result = generateSchemaFile(model);

			expect(result).not.toContain('onDelete');
		});
	});

	// -----------------------------------------------------------------------
	// FK with unique column → unique: true on ref
	// -----------------------------------------------------------------------
	describe('FK on unique column', () => {
		it('includes unique: true in ref options', () => {
			const tables = new Map<string, TableIR>([
				[
					'profiles',
					{
						name: 'profiles',
						columns: [
							{ name: 'id', type: 'integer', nullable: false },
							{
								name: 'userId',
								type: 'integer',
								nullable: false,
								unique: true,
							},
						],
						primaryKey: 'id',
						foreignKeys: [
							{
								columns: ['userId'],
								references: { table: 'users', columns: ['id'] },
							},
						],
						indexes: [],
					},
				],
			]);
			const model: ModelIR = {
				tables,
				relations: new Map(),
				getTable: (n) => tables.get(n),
				getRelation: () => undefined,
				getRelationsFrom: () => [],
				getRelationsTo: () => [],
				isAmbiguous: () => ({ ambiguous: false, options: [] }),
			};

			const result = generateSchemaFile(model);

			expect(result).toContain('unique: true');
			expect(result).toContain("ref('users'");
		});
	});

	// -----------------------------------------------------------------------
	// Self-referential FK with non-'parent' base name
	// -----------------------------------------------------------------------
	describe('self-referential FK with managerId (not parentId)', () => {
		it('infers role names from column base name', () => {
			const tables = new Map<string, TableIR>([
				[
					'employees',
					{
						name: 'employees',
						columns: [
							{ name: 'id', type: 'integer', nullable: false },
							{ name: 'managerId', type: 'integer', nullable: true },
						],
						primaryKey: 'id',
						foreignKeys: [
							{
								columns: ['managerId'],
								references: { table: 'employees', columns: ['id'] },
							},
						],
						indexes: [],
					},
				],
			]);
			const model: ModelIR = {
				tables,
				relations: new Map(),
				getTable: (n) => tables.get(n),
				getRelation: () => undefined,
				getRelationsFrom: () => [],
				getRelationsTo: () => [],
				isAmbiguous: () => ({ ambiguous: false, options: [] }),
			};

			const result = generateSchemaFile(model);

			// Self-ref with managerId → roles: { parent: 'manager', children: 'managers' }
			expect(result).toContain("ref('employees'");
			expect(result).toContain("parent: 'manager'");
			expect(result).toContain("children: 'managers'");
		});
	});

	// -----------------------------------------------------------------------
	// originalDbType comment on ref() column
	// -----------------------------------------------------------------------
	describe('originalDbType on ref column', () => {
		it('appends /* from: ... */ comment on ref() when includeDbTypeComments', () => {
			const tables = new Map<string, TableIR>([
				[
					'posts',
					{
						name: 'posts',
						columns: [
							{ name: 'id', type: 'integer', nullable: false },
							{
								name: 'authorId',
								type: 'integer',
								nullable: false,
								originalDbType: 'int4',
							},
						],
						primaryKey: 'id',
						foreignKeys: [
							{
								columns: ['authorId'],
								references: { table: 'users', columns: ['id'] },
							},
						],
						indexes: [],
					},
				],
			]);
			const model: ModelIR = {
				tables,
				relations: new Map(),
				getTable: (n) => tables.get(n),
				getRelation: () => undefined,
				getRelationsFrom: () => [],
				getRelationsTo: () => [],
				isAmbiguous: () => ({ ambiguous: false, options: [] }),
			};

			const result = generateSchemaFile(model, { includeDbTypeComments: true });

			expect(result).toContain("ref('users') /* from: int4 */");
		});
	});

	// -----------------------------------------------------------------------
	// originalDbType on short-form column
	// -----------------------------------------------------------------------
	describe('originalDbType on short-form column', () => {
		it('appends /* from: ... */ after short-form type string', () => {
			const tables = new Map<string, TableIR>([
				[
					'users',
					{
						name: 'users',
						columns: [
							{ name: 'id', type: 'integer', nullable: false },
							{
								name: 'name',
								type: 'string',
								nullable: false,
								originalDbType: 'varchar(255)',
							},
						],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
					},
				],
			]);
			const model: ModelIR = {
				tables,
				relations: new Map(),
				getTable: (n) => tables.get(n),
				getRelation: () => undefined,
				getRelationsFrom: () => [],
				getRelationsTo: () => [],
				isAmbiguous: () => ({ ambiguous: false, options: [] }),
			};

			const result = generateSchemaFile(model, { includeDbTypeComments: true });

			expect(result).toContain("'string' /* from: varchar(255) */");
		});
	});

	// -----------------------------------------------------------------------
	// Empty model
	// -----------------------------------------------------------------------
	describe('empty model', () => {
		it('generates valid schema file with no tables', () => {
			const model: ModelIR = {
				tables: new Map(),
				relations: new Map(),
				getTable: () => undefined,
				getRelation: () => undefined,
				getRelationsFrom: () => [],
				getRelationsTo: () => [],
				isAmbiguous: () => ({ ambiguous: false, options: [] }),
			};

			const result = generateSchemaFile(model);

			expect(result).toContain("import { schema } from '@dbsp/core'");
			expect(result).toContain('export const dbSchema = schema({');
			expect(result).toContain('});');
			// No ref import when no FKs
			expect(result).not.toContain('ref');
		});
	});

	// -----------------------------------------------------------------------
	// No warnings section
	// -----------------------------------------------------------------------
	describe('warnings', () => {
		it('does not output a warnings section', () => {
			const model = schema({
				users: { id: { type: 'uuid', primaryKey: true } },
			}).model;

			const result = generateSchemaFile(model);

			expect(result).not.toContain('Warnings');
		});
	});

	// -----------------------------------------------------------------------
	// camelCase dbCasing
	// -----------------------------------------------------------------------
	describe('camelCase dbCasing', () => {
		it('does not convert column names (already camelCase)', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					firstName: 'string',
				},
			}).model;

			const result = generateSchemaFile(model, { dbCasing: 'camelCase' });

			// camelCase dbCasing is not 'preserve', so it triggers the import and export
			expect(result).toContain(
				"import { createPgsqlAdapter } from '@dbsp/adapter-pgsql'",
			);
			expect(result).toContain("export const dbCasing = 'camelCase' as const");
			// Column names stay as-is (no conversion needed)
			expect(result).toContain('firstName:');
		});
	});

	// -----------------------------------------------------------------------
	// FK column name lookup with camelCase conversion
	// -----------------------------------------------------------------------
	describe('FK column name with snake_case lookup', () => {
		it('finds FK info when FK column is snake_case but model column is camelCase', () => {
			// Simulate introspection: FK references use snake_case (author_id)
			// but columns in TableIR are already camelCase (authorId) via CamelCasePlugin
			const tables = new Map<string, TableIR>([
				[
					'posts',
					{
						name: 'posts',
						columns: [
							{ name: 'id', type: 'integer', nullable: false },
							{ name: 'authorId', type: 'integer', nullable: false },
						],
						primaryKey: 'id',
						foreignKeys: [
							{
								columns: ['author_id'], // snake_case from raw DB
								references: { table: 'users', columns: ['id'] },
							},
						],
						indexes: [],
					},
				],
			]);
			const model: ModelIR = {
				tables,
				relations: new Map(),
				getTable: (n) => tables.get(n),
				getRelation: () => undefined,
				getRelationsFrom: () => [],
				getRelationsTo: () => [],
				isAmbiguous: () => ({ ambiguous: false, options: [] }),
			};

			const result = generateSchemaFile(model);

			// Should match via snakeToCamelCase fallback
			expect(result).toContain("authorId: ref('users')");
		});
	});

	// -----------------------------------------------------------------------
	// No sourceUrl / introspectedAt (minimal header)
	// -----------------------------------------------------------------------
	describe('minimal header (no sourceUrl, no timestamp)', () => {
		it('does not include Source or Generated lines', () => {
			const model = schema({
				users: { id: { type: 'uuid', primaryKey: true } },
			}).model;

			const result = generateSchemaFile(model, {});

			expect(result).toContain('Auto-generated by: dbsp introspect');
			expect(result).not.toContain('Source:');
			expect(result).not.toContain('Generated:');
		});
	});

	// -----------------------------------------------------------------------
	// FK with both nullable and unique
	// -----------------------------------------------------------------------
	describe('FK with both nullable and unique', () => {
		it('includes both nullable and unique in ref options', () => {
			const tables = new Map<string, TableIR>([
				[
					'profiles',
					{
						name: 'profiles',
						columns: [
							{ name: 'id', type: 'integer', nullable: false },
							{ name: 'userId', type: 'integer', nullable: true, unique: true },
						],
						primaryKey: 'id',
						foreignKeys: [
							{
								columns: ['userId'],
								references: { table: 'users', columns: ['id'] },
							},
						],
						indexes: [],
					},
				],
			]);
			const model: ModelIR = {
				tables,
				relations: new Map(),
				getTable: (n) => tables.get(n),
				getRelation: () => undefined,
				getRelationsFrom: () => [],
				getRelationsTo: () => [],
				isAmbiguous: () => ({ ambiguous: false, options: [] }),
			};

			const result = generateSchemaFile(model);

			expect(result).toContain('nullable: true');
			expect(result).toContain('unique: true');
			expect(result).toContain("ref('users'");
		});
	});
});

// -----------------------------------------------------------------------
// C7: invalid JS identifier table/column names are quoted in output
// -----------------------------------------------------------------------
describe('[C7] invalid JS identifier names are quoted in generated schema', () => {
	it('[C7] table name with hyphen is quoted as object key (regression gate)', () => {
		// Tables with names like user-profile cannot be bare keys in JS/TS object
		// literals. The generated schema must quote them.
		const tables = new Map<string, TableIR>([
			[
				'user-profile',
				{
					name: 'user-profile',
					columns: [{ name: 'id', type: 'uuid', nullable: false }],
					primaryKey: 'id',
					foreignKeys: [],
					indexes: [],
				},
			],
		]);
		const model: ModelIR = {
			tables,
			relations: new Map(),
			getTable: (n) => tables.get(n),
			getRelation: () => undefined,
			getRelationsFrom: () => [],
			getRelationsTo: () => [],
			isAmbiguous: () => ({ ambiguous: false, options: [] }),
		};

		const result = generateSchemaFile(model);

		// Bare key `user-profile` is invalid JS; must be quoted
		expect(result).toMatch(/'user-profile':|"user-profile":/);
		// Must not contain the bare unquoted identifier
		expect(result).not.toContain('\tuser-profile: {');
	});

	it('valid JS identifier names remain unquoted', () => {
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
			},
		}).model;

		const result = generateSchemaFile(model);

		// 'users' is a valid identifier — no quoting needed
		expect(result).toContain('\tusers: {');
	});
});

// ============================================================================
// F3 regression: quoteKey must escape control chars (newline, CR, tab) via
// singleQuoteEscape — not just \\ and ' as the previous inline chain did.
// ============================================================================

describe('[F3] quoteKey escapes control characters in identifiers', () => {
	// We test via generateSchemaFile by injecting a table whose name contains
	// control characters (simulating an introspected schema with exotic names).

	it('identifier with newline produces valid TS output', () => {
		const model = schema({
			users: { id: { type: 'uuid', primaryKey: true } },
		}).model;
		// Inject a table name that contains a real newline
		const tables = new Map(model.tables);
		const usersTable = tables.get('users')!;
		tables.set('line\nnewline', {
			...usersTable,
			name: 'line\nnewline',
		});
		tables.delete('users');
		const injected = {
			...model,
			tables,
			getTable: (n: string) => tables.get(n),
		};
		const result = generateSchemaFile(injected as never);
		// The key must appear as 'line\\nnewline' — not a literal newline inside quotes
		expect(result).toContain("'line\\nnewline'");
		// No raw newline should appear inside a string literal on the key line
		const keyLine = result
			.split('\n')
			.find((l) => l.includes("'line\\nnewline'"));
		expect(keyLine).toBeDefined();
	});

	it('identifier with tab produces valid TS output', () => {
		const model = schema({
			users: { id: { type: 'uuid', primaryKey: true } },
		}).model;
		const tables = new Map(model.tables);
		const usersTable = tables.get('users')!;
		tables.set('tab\there', {
			...usersTable,
			name: 'tab\there',
		});
		tables.delete('users');
		const injected = {
			...model,
			tables,
			getTable: (n: string) => tables.get(n),
		};
		const result = generateSchemaFile(injected as never);
		expect(result).toContain("'tab\\there'");
	});
});

// ============================================================================
// SQL expression defaults + escape coverage
// (recovered from deleted schema-codegen.codex.test.ts — non-C2 portions only)
// ============================================================================

describe('CODEX-11: SQL-expression defaults round-trip', () => {
	it('emits { sql: "now()" } for a SQL-expression default — not [object Object]', () => {
		const model = schema({
			events: {
				id: { type: 'uuid', primaryKey: true },
				created_at: { type: 'datetime', default: 'placeholder' },
			},
		}).model;

		const col = model.tables
			.get('events')
			?.columns.find((c) => c.name === 'created_at');
		if (col) (col as { default: unknown }).default = { sql: 'now()' };

		const result = generateSchemaFile(model);

		expect(result).toContain("{ sql: 'now()' }");
		expect(result).not.toContain('[object Object]');
	});

	it('emits { sql: "CURRENT_TIMESTAMP" } for a multi-word SQL default', () => {
		const model = schema({
			things: {
				id: { type: 'uuid', primaryKey: true },
				ts: { type: 'datetime', default: 'placeholder' },
			},
		}).model;

		const col = model.tables
			.get('things')
			?.columns.find((c) => c.name === 'ts');
		if (col)
			(col as { default: unknown }).default = { sql: 'CURRENT_TIMESTAMP' };

		const result = generateSchemaFile(model);
		expect(result).toContain("{ sql: 'CURRENT_TIMESTAMP' }");
		expect(result).not.toContain('[object Object]');
	});

	it('emits { sql: "..." } for a SQL default with special characters', () => {
		const model = schema({
			t: {
				id: { type: 'uuid', primaryKey: true },
				x: { type: 'string', default: 'placeholder' },
			},
		}).model;

		const col = model.tables.get('t')?.columns.find((c) => c.name === 'x');
		if (col)
			(col as { default: unknown }).default = {
				sql: "nextval('seq'::regclass)",
			};

		const result = generateSchemaFile(model);
		// Apostrophes inside sql expr are escaped as \'
		expect(result).toContain("{ sql: 'nextval(\\'seq\\'::regclass)' }");
		expect(result).not.toContain('[object Object]');
	});
});

describe('CODEX-14: string defaults are properly escaped', () => {
	it('escapes double-quote in string default (single-quote TS style)', () => {
		const model = schema({
			t: {
				id: { type: 'uuid', primaryKey: true },
				label: { type: 'string', default: 'say "hi"' },
			},
		}).model;
		const result = generateSchemaFile(model);
		// Double-quotes don't need escaping inside single-quoted strings
		expect(result).toContain('default: \'say "hi"\'');
		expect(result).not.toContain('[object Object]');
	});

	it('escapes backslash in string default', () => {
		const model = schema({
			t: {
				id: { type: 'uuid', primaryKey: true },
				path: { type: 'string', default: 'C:\\Users' },
			},
		}).model;
		const result = generateSchemaFile(model);
		expect(result).toContain("default: 'C:\\\\Users'");
	});

	it('escapes single-quote in string default (produces valid TS)', () => {
		const model = schema({
			t: {
				id: { type: 'uuid', primaryKey: true },
				name: { type: 'string', default: "O'Brien" },
			},
		}).model;
		const result = generateSchemaFile(model);
		expect(result).toContain("default: 'O\\'Brien'");
	});

	it('preserves number defaults as unquoted literals', () => {
		const model = schema({
			t: {
				id: { type: 'uuid', primaryKey: true },
				count: { type: 'integer', default: 42 },
				score: { type: 'number', default: 0 },
			},
		}).model;
		const result = generateSchemaFile(model);
		expect(result).toContain('default: 42');
		expect(result).toContain('default: 0');
		expect(result).not.toContain("default: '42'");
	});

	it('preserves boolean defaults as unquoted literals', () => {
		const model = schema({
			t: {
				id: { type: 'uuid', primaryKey: true },
				active: { type: 'boolean', default: true },
				archived: { type: 'boolean', default: false },
			},
		}).model;
		const result = generateSchemaFile(model);
		expect(result).toContain('default: true');
		expect(result).toContain('default: false');
	});

	it('emits null for a null default', () => {
		const model = schema({
			t: {
				id: { type: 'uuid', primaryKey: true },
				opt: { type: 'string', nullable: true, default: 'placeholder' },
			},
		}).model;
		const col = model.tables.get('t')?.columns.find((c) => c.name === 'opt');
		if (col) (col as { default: unknown }).default = null;

		const result = generateSchemaFile(model);
		expect(result).toContain('default: null');
	});

	it('escapes newline in string default', () => {
		const model = schema({
			t: {
				id: { type: 'uuid', primaryKey: true },
				note: { type: 'string', default: 'line1\nline2' },
			},
		}).model;
		const result = generateSchemaFile(model);
		// \n becomes \\n in the TS source literal
		expect(result).toContain("default: 'line1\\nline2'");
	});
});

// ---------------------------------------------------------------------------
// CODEX-12: FK onUpdate preserved in ref()
// ---------------------------------------------------------------------------
describe('CODEX-12: FK onUpdate preserved in generated ref()', () => {
	it('emits onUpdate: "CASCADE" when FK has ON UPDATE CASCADE', () => {
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
			},
			orders: {
				id: { type: 'uuid', primaryKey: true },
				user_id: ref('users'),
			},
		}).model;

		// Inject onUpdate via mutation of the FK (simulates introspection)
		const table = model.tables.get('orders');
		if (table) {
			const fk = table.foreignKeys[0];
			if (fk) (fk as unknown as { onUpdate: string }).onUpdate = 'CASCADE';
		}

		const result = generateSchemaFile(model);
		expect(result).toContain("onUpdate: 'CASCADE'");
	});

	it('omits onUpdate when FK has ON UPDATE NO ACTION (default)', () => {
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
			},
			orders: {
				id: { type: 'uuid', primaryKey: true },
				user_id: ref('users'),
			},
		}).model;

		const table = model.tables.get('orders');
		if (table) {
			const fk = table.foreignKeys[0];
			if (fk) (fk as unknown as { onUpdate: string }).onUpdate = 'NO ACTION';
		}

		const result = generateSchemaFile(model);
		expect(result).not.toContain('onUpdate:');
	});

	it('emits both onDelete and onUpdate when both are non-default', () => {
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
			},
			orders: {
				id: { type: 'uuid', primaryKey: true },
				user_id: ref('users'),
			},
		}).model;

		const table = model.tables.get('orders');
		if (table) {
			const fk = table.foreignKeys[0];
			if (fk) {
				(fk as unknown as { onDelete: string; onUpdate: string }).onDelete =
					'RESTRICT';
				(fk as unknown as { onDelete: string; onUpdate: string }).onUpdate =
					'SET DEFAULT';
			}
		}

		const result = generateSchemaFile(model);
		expect(result).toContain("onDelete: 'RESTRICT'");
		expect(result).toContain("onUpdate: 'SET DEFAULT'");
	});

	it('handles SET NULL as onUpdate', () => {
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
			},
			posts: {
				id: { type: 'uuid', primaryKey: true },
				author_id: ref('users', { nullable: true }),
			},
		}).model;

		const table = model.tables.get('posts');
		if (table) {
			const fk = table.foreignKeys[0];
			if (fk) (fk as unknown as { onUpdate: string }).onUpdate = 'SET NULL';
		}

		const result = generateSchemaFile(model);
		expect(result).toContain("onUpdate: 'SET NULL'");
	});
});

// ---------------------------------------------------------------------------
// CODEX-13: FK + PK overlap — shared-PK 1:1 pattern
// ---------------------------------------------------------------------------
describe('CODEX-13: FK + PK overlap', () => {
	it('emits isPrimaryKey: true inside ref() for a column that is both PK and FK', () => {
		// Shared-PK 1:1: profiles.id is PK and also FK → users.id
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
			},
			profiles: {
				id: { type: 'uuid', primaryKey: true },
			},
		}).model;

		// Inject FK: profiles.id → users.id
		const table = model.tables.get('profiles');
		if (table) {
			(table.foreignKeys as Array<ForeignKeyIR>).push({
				columns: ['id'] as readonly string[],
				references: { table: 'users', columns: ['id'] as readonly string[] },
			});
		}

		const result = generateSchemaFile(model);

		// Must emit ref() (FK wins the code structure)
		expect(result).toContain("ref('users'");
		// Must preserve the PK flag inside ref() options
		expect(result).toContain('isPrimaryKey: true');
	});

	it('does NOT emit isPrimaryKey for a non-PK FK column', () => {
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
			},
			posts: {
				id: { type: 'uuid', primaryKey: true },
				author_id: ref('users'),
			},
		}).model;

		const result = generateSchemaFile(model);

		// author_id is FK but not PK — isPrimaryKey must not appear
		expect(result).toContain("author_id: ref('users')");
		expect(result).not.toContain('isPrimaryKey: true');
	});

	it('emits isPrimaryKey: true even when the column is also nullable FK', () => {
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
			},
			profiles: {
				id: { type: 'uuid', primaryKey: true },
			},
		}).model;

		const table = model.tables.get('profiles');
		if (table) {
			(table.foreignKeys as Array<ForeignKeyIR>).push({
				columns: ['id'] as readonly string[],
				references: { table: 'users', columns: ['id'] as readonly string[] },
			});
			// Mark the column nullable
			const col = table.columns.find((c) => c.name === 'id');
			if (col) (col as { nullable: boolean }).nullable = true;
		}

		const result = generateSchemaFile(model);
		expect(result).toContain('isPrimaryKey: true');
		expect(result).toContain('nullable: true');
		expect(result).toContain("ref('users'");
	});
});
