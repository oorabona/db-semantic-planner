// @ts-nocheck — coverage test: runtime assertions
/**
 * Coverage tests for schema-codegen.ts — targets uncovered branches
 * not in schema-codegen.test.ts.
 *
 * Focus: unique columns, composite primary keys, multi-column FKs (skipped),
 * non-'id' FK reference columns, onDelete actions, originalDbType on short-form + ref columns,
 * FK with both nullable and unique, self-ref with non-'parent' base name,
 * empty model, empty warnings array, camelCase dbCasing option.
 */

import type { ModelIR, TableIR } from '@dbsp/core';
import { schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
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
	// multi-column FK (skipped by codegen)
	// -----------------------------------------------------------------------
	describe('multi-column foreign keys (skipped)', () => {
		it('does not generate ref() for multi-column FKs', () => {
			const tables = new Map<string, TableIR>([
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

			// Multi-column FK should be skipped — no ref()
			expect(result).not.toContain("ref('orders')");
			// Columns should be rendered as regular columns
			expect(result).toContain("orderId: 'integer'");
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
	// Empty warnings array
	// -----------------------------------------------------------------------
	describe('empty warnings array', () => {
		it('does not output warnings section when array is empty', () => {
			const model = schema({
				users: { id: { type: 'uuid', primaryKey: true } },
			}).model;

			const result = generateSchemaFile(model, { warnings: [] });

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
