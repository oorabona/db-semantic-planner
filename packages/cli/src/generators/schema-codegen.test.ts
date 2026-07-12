/**
 * CLI-DDL: Schema Codegen Tests
 *
 * Tests for generateSchemaFile() which generates TypeScript schema from ModelIR.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	compareSchemata,
	generateCreateIndex,
	generateDDL,
	generateMigrationSQL,
	identityNaming,
} from '@dbsp/adapter-pgsql';
import type { ModelIR, TableIR } from '@dbsp/core';
import { ref, schema } from '@dbsp/core';
import type { IndexIR } from '@dbsp/types';
import * as ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSchema } from '../utils/schema-loader.js';
import {
	generateSchemaFile,
	generateSchemaFileWithDiagnostics,
	type SchemaCodegenOptions,
} from './schema-codegen.js';

function makeCodegenModel(tables: readonly TableIR[]): ModelIR {
	const tableMap = new Map(tables.map((table) => [table.name, table] as const));
	return {
		tables: tableMap,
		relations: new Map(),
		getTable: (name: string) => tableMap.get(name),
		getRelation: () => undefined,
	} as unknown as ModelIR;
}

function expectValidTypeScript(source: string): void {
	const result = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
		},
		reportDiagnostics: true,
	});
	const errors =
		result.diagnostics?.filter(
			(diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
		) ?? [];
	expect(errors.map((diagnostic) => diagnostic.messageText)).toEqual([]);
}

async function loadGeneratedSchemaCode(source: string) {
	const tmpDir = mkdtempSync(join(process.cwd(), '.tmp-schema-codegen-'));
	try {
		const schemaPath = join(tmpDir, 'dbsp.schema.ts');
		writeFileSync(schemaPath, source, 'utf8');
		return await loadSchema(schemaPath);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('generateSchemaFile', () => {
	describe('basic structure', () => {
		it('returns a string', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).model;

			const result = generateSchemaFile(model);

			expect(typeof result).toBe('string');
		});

		it('generates valid schema file with imports (no FKs)', () => {
			// ARCH-005: When no FKs, only schema is imported
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					name: { type: 'string' },
				},
			}).model;

			const result = generateSchemaFile(model);

			expect(result).toContain("import { schema } from '@dbsp/core';");
			expect(result).toContain('export const dbSchema = schema({');
			expect(result).toContain('});');
		});

		it('generates valid schema file with ref import (with FKs)', () => {
			// ARCH-005: When FKs exist, ref is also imported
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					authorId: ref('users'),
				},
			}).model;

			const result = generateSchemaFile(model);

			expect(result).toContain("import { schema, ref } from '@dbsp/core';");
			expect(result).toContain('export const dbSchema = schema({');
		});

		it('generates table definitions', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).model;

			const result = generateSchemaFile(model);

			expect(result).toContain('users: {');
			expect(result).toContain("id: { type: 'uuid', primaryKey: true }");
		});

		it('generates multiple tables', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).model;

			const result = generateSchemaFile(model);

			expect(result).toContain('users: {');
			expect(result).toContain('posts: {');
		});
	});

	describe('column types', () => {
		it('generates short form for simple columns', () => {
			// ARCH-005: Non-PK, non-nullable, no-default columns use short form
			const model = schema({
				test: {
					id: { type: 'uuid', primaryKey: true },
					name: { type: 'string' },
					count: { type: 'integer' },
					active: { type: 'boolean' },
				},
			}).model;

			const result = generateSchemaFile(model);

			// id has primaryKey, so long form
			expect(result).toContain("id: { type: 'uuid', primaryKey: true }");
			// Others use short form
			expect(result).toContain("name: 'string'");
			expect(result).toContain("count: 'integer'");
			expect(result).toContain("active: 'boolean'");
		});
	});

	describe('primary key', () => {
		it('marks single primary key column', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					name: { type: 'string' },
				},
			}).model;

			const result = generateSchemaFile(model);

			expect(result).toContain("id: { type: 'uuid', primaryKey: true }");
			expect(result).not.toContain(
				"name: { type: 'string', primaryKey: true }",
			);
		});

		it('does not mark non-primary key columns', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					email: { type: 'string' },
					name: { type: 'string' },
				},
			}).model;

			const result = generateSchemaFile(model);

			// Only id should have primaryKey: true
			const matches = result.match(/primaryKey: true/g);
			expect(matches).toHaveLength(1);
			expect(result).toContain("id: { type: 'uuid', primaryKey: true }");
		});
	});

	describe('nullable columns', () => {
		it('adds nullable: true for nullable columns', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					bio: { type: 'string', nullable: true },
				},
			}).model;

			const result = generateSchemaFile(model);

			expect(result).toContain("bio: { type: 'string', nullable: true }");
		});

		it('omits nullable for non-nullable columns (short form)', () => {
			// ARCH-005: Short form for simple columns
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					name: { type: 'string' },
				},
			}).model;

			const result = generateSchemaFile(model);

			// ARCH-005: name uses short form since it's non-nullable
			expect(result).toContain("name: 'string'");
		});
	});

	describe('default values', () => {
		it('includes string default values with quotes', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
				},
			}).model;

			const result = generateSchemaFile(model);

			expect(result).toContain("default: 'gen_random_uuid()'");
		});

		it('includes numeric default values without quotes', () => {
			const model = schema({
				posts: {
					id: { type: 'uuid', primaryKey: true },
					views: { type: 'integer', default: 0 },
				},
			}).model;

			const result = generateSchemaFile(model);

			expect(result).toContain('default: 0');
		});

		it('includes boolean default values', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					active: { type: 'boolean', default: true },
				},
			}).model;

			const result = generateSchemaFile(model);

			expect(result).toContain('default: true');
		});
	});

	describe('foreign key references', () => {
		it('generates ref() for FK columns', () => {
			// ARCH-005: FK columns become ref() calls
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

			// ARCH-005: ref() instead of references: {}
			expect(result).toContain("author_id: ref('users')");
		});

		it('generates ref() for FK columns regardless of target column', () => {
			// ARCH-005: ref() only takes table name; always targets PK
			// This test creates ModelIR directly to simulate introspection of a non-PK FK
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					email: 'string',
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					// Use ref() - the code generator will output ref()
					author_email: ref('users'),
				},
			}).model;

			const result = generateSchemaFile(model);

			// ARCH-005: ref() only references table (always targets PK)
			expect(result).toContain("author_email: ref('users')");
		});

		it('generates ref() with nullable option', () => {
			// ARCH-005: nullable FK → ref(target, { nullable: true })
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					authorId: ref('users', { nullable: true }),
				},
			}).model;

			const result = generateSchemaFile(model);

			expect(result).toContain("authorId: ref('users', { nullable: true })");
		});

		it('generates ref() with roles for self-referential FK', () => {
			// ARCH-005: Self-ref FK → ref(target, { roles: {...} })
			const model = schema({
				categories: {
					id: { type: 'uuid', primaryKey: true },
					name: 'string',
					parentId: ref('categories', {
						nullable: true,
						roles: { parent: 'parent', children: 'children' },
					}),
				},
			}).model;

			const result = generateSchemaFile(model);

			// Self-ref should have roles inferred from column name
			expect(result).toContain("ref('categories'");
			expect(result).toContain('roles:');
			expect(result).toContain('parent:');
			expect(result).toContain('children:');
		});

		it('infers role baseName from snake_case self-ref column (L-1)', () => {
			// snake_case column like `parent_id` must strip `_id` suffix, not leave
			// it: baseName should be 'parent', not 'parent_id'.
			const model = schema({
				nodes: {
					id: { type: 'uuid', primaryKey: true },
					parent_id: ref('nodes', {
						nullable: true,
						roles: { parent: 'parent', children: 'children' },
					}),
				},
			}).model;

			const result = generateSchemaFile(model);

			// Role must be 'parent', NOT 'parent_id'
			expect(result).toContain("parent: 'parent'");
			expect(result).not.toContain("parent: 'parent_id'");
		});

		it('routes onDelete/onUpdate through singleQuoteEscape (L-2)', () => {
			// Ensures fkInfo.onDelete and onUpdate are wrapped via singleQuoteEscape,
			// not interpolated as bare template literals.
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					author_id: ref('users', { onDelete: 'CASCADE' }),
				},
			}).model;

			const result = generateSchemaFile(model);

			// onDelete must appear as a properly single-quoted string literal
			expect(result).toContain("onDelete: 'CASCADE'");
		});
	});

	describe('options', () => {
		it('includes source URL in header (redacted)', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).model;

			const options: SchemaCodegenOptions = {
				sourceUrl: 'postgresql://user:secret123@localhost/mydb',
			};

			const result = generateSchemaFile(model, options);

			expect(result).toContain('Source: postgresql://user:***@localhost/mydb');
			expect(result).not.toContain('secret123');
		});

		it('includes timestamp in header', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).model;

			const options: SchemaCodegenOptions = {
				introspectedAt: new Date('2026-01-18T12:00:00Z'),
			};

			const result = generateSchemaFile(model, options);

			expect(result).toContain('Generated: 2026-01-18T12:00:00.000Z');
		});

		it('returns a string and writes no diagnostics without onWarning', () => {
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).model;

			const result = generateSchemaFile(model);

			expect(typeof result).toBe('string');
			expect(error).not.toHaveBeenCalled();
			expect(log).not.toHaveBeenCalled();
			expect(result).not.toContain('Warnings:');
			expectValidTypeScript(result);
		});

		it('includes DB type comments when enabled', () => {
			// For this test, we need to manually create a model with originalDbType
			// since defineSchema doesn't include that field
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					data: { type: 'json', nullable: true },
				},
			}).model;

			// Manually set originalDbType on the columns (simulating introspection output)
			const usersTable = model.tables.get('users');
			if (usersTable) {
				// Cast to mutable for test setup
				const idCol = usersTable.columns.find((c) => c.name === 'id');
				const dataCol = usersTable.columns.find((c) => c.name === 'data');
				if (idCol)
					(idCol as { originalDbType?: string }).originalDbType = 'uuid';
				if (dataCol)
					(dataCol as { originalDbType?: string }).originalDbType = 'jsonb';
			}

			const options: SchemaCodegenOptions = {
				includeDbTypeComments: true,
			};

			const result = generateSchemaFile(model, options);

			expect(result).toContain('/* from: uuid */');
			expect(result).toContain('/* from: jsonb */');
		});

		it('neutralizes catalog-derived DB type comments', () => {
			const model = schema({
				users: {
					payload: { type: 'json', nullable: true },
				},
			}).model;

			const usersTable = model.tables.get('users');
			const payloadCol = usersTable?.columns.find((c) => c.name === 'payload');
			if (payloadCol) {
				(payloadCol as { originalDbType?: string }).originalDbType =
					"jsonb */\nthrow new Error('injected');\n/*";
			}

			const result = generateSchemaFile(model, {
				includeDbTypeComments: true,
			});

			expect(result).toContain('jsonb * /\\nthrow');
			expect(result).not.toContain('jsonb */');
			expectValidTypeScript(result);
		});

		it('omits DB type comments when disabled', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).model;

			const options: SchemaCodegenOptions = {
				includeDbTypeComments: false,
			};

			const result = generateSchemaFile(model, options);

			expect(result).not.toContain('/* from:');
		});
	});

	describe('header comment', () => {
		it('includes auto-generated notice', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).model;

			const result = generateSchemaFile(model);

			expect(result).toContain('Auto-generated by: dbsp introspect');
			expect(result).toContain('Review before using in production.');
		});
	});

	describe('dbCasing option', () => {
		it('converts snake_case column names to camelCase when dbCasing is snake_case', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					first_name: 'string',
					last_name: 'string',
					created_at: 'datetime',
				},
			}).model;

			const result = generateSchemaFile(model, { dbCasing: 'snake_case' });

			expect(result).toContain('firstName:');
			expect(result).toContain('lastName:');
			expect(result).toContain('createdAt:');
			// Original snake_case names should NOT appear as keys
			expect(result).not.toMatch(/\tfirst_name:/);
			expect(result).not.toMatch(/\tlast_name:/);
			expect(result).not.toMatch(/\tcreated_at:/);
		});

		it('converts FK column names to camelCase', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					author_id: ref('users'),
				},
			}).model;

			const result = generateSchemaFile(model, { dbCasing: 'snake_case' });

			expect(result).toContain("authorId: ref('users')");
			expect(result).not.toMatch(/\tauthor_id:/);
		});

		it('converts non-PK FK target column to camelCase in references option (dbCasing snake_case)', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					email_address: { type: 'string', unique: true },
				},
				memberships: {
					id: { type: 'uuid', primaryKey: true },
					user_email: ref('users', { references: ['email_address'] }),
				},
			}).model;
			const result = generateSchemaFile(model, { dbCasing: 'snake_case' });
			// FK source column: snake_case → camelCase
			expect(result).toContain('userEmail:');
			expect(result).not.toMatch(/\tuser_email:/);
			// FK target references[] entry: snake_case → camelCase
			expect(result).toContain("references: ['emailAddress']");
			expect(result).not.toContain("references: ['email_address']");
		});

		it('does NOT transform fk.references.columns entries when dbCasing is preserve (L1-followup-4-symmetry)', () => {
			// Symmetric negative regression paired with the snake_case positive test above.
			// In preserve mode, entries inside references[] must round-trip unchanged.
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					email_address: { type: 'string', unique: true },
				},
				memberships: {
					id: { type: 'uuid', primaryKey: true },
					user_email: ref('users', { references: ['email_address'] }),
				},
			}).model;
			const result = generateSchemaFile(model, { dbCasing: 'preserve' });
			// references[] entry must NOT be camelCase-transformed in preserve mode
			expect(result).toContain("references: ['email_address']");
			expect(result).not.toContain("references: ['emailAddress']");
			// Source column name also preserved as-is
			expect(result).toContain('user_email:');
			expect(result).not.toContain('userEmail:');
		});

		it('preserves column names when dbCasing is preserve', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					first_name: 'string',
				},
			}).model;

			const result = generateSchemaFile(model, { dbCasing: 'preserve' });

			expect(result).toContain('first_name:');
			expect(result).not.toContain('firstName:');
		});

		it('preserves column names when dbCasing is not set', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					first_name: 'string',
				},
			}).model;

			const result = generateSchemaFile(model);

			expect(result).toContain('first_name:');
		});

		it('exports dbCasing constant when snake_case', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).model;

			const result = generateSchemaFile(model, { dbCasing: 'snake_case' });

			expect(result).toContain(
				"export const dbCasing = 'snake_case' as const;",
			);
		});

		it('adds adapter import when dbCasing is set', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).model;

			const result = generateSchemaFile(model, { dbCasing: 'snake_case' });

			expect(result).toContain(
				"import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';",
			);
		});

		it('does not export dbCasing when preserve', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).model;

			const result = generateSchemaFile(model, { dbCasing: 'preserve' });

			expect(result).not.toContain('export const dbCasing');
		});

		it('includes usage hint with dbCasing in example', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).model;

			const result = generateSchemaFile(model, { dbCasing: 'snake_case' });

			expect(result).toContain("dbCasing: 'snake_case'");
			expect(result).toContain('createPgsqlAdapter(pool');
		});

		it('converts table names to camelCase too', () => {
			const model = schema({
				user_profiles: {
					id: { type: 'uuid', primaryKey: true },
					display_name: 'string',
				},
			}).model;

			const result = generateSchemaFile(model, { dbCasing: 'snake_case' });

			// Table name becomes camelCase
			expect(result).toContain('userProfiles: {');
			expect(result).not.toContain('user_profiles: {');
			// Column name becomes camelCase
			expect(result).toContain('displayName:');
		});

		it('converts ref() table targets to camelCase', () => {
			const model = schema({
				user_profiles: {
					id: { type: 'uuid', primaryKey: true },
				},
				blog_posts: {
					id: { type: 'uuid', primaryKey: true },
					author_id: ref('user_profiles'),
				},
			}).model;

			const result = generateSchemaFile(model, { dbCasing: 'snake_case' });

			expect(result).toContain("ref('userProfiles')");
			expect(result).not.toContain("ref('user_profiles')");
		});
	});

	describe('table-level indexes', () => {
		it('emits every expressible index option and converts column-like names', () => {
			const index: IndexIR = {
				name: 'uq_user_profiles_email_covering',
				columns: ['email_address'],
				unique: true,
				method: 'btree',
				where: 'email_address IS NOT NULL',
				opclass: { email_address: 'text_pattern_ops' },
				with: { fillfactor: '70' },
				include: ['display_name'],
				nullsNotDistinct: true,
			};
			const model = makeCodegenModel([
				{
					name: 'user_profiles',
					columns: [
						{ name: 'id', type: 'uuid', nullable: false },
						{ name: 'email_address', type: 'string', nullable: false },
						{ name: 'display_name', type: 'string', nullable: false },
					],
					primaryKey: 'id',
					foreignKeys: [],
					indexes: [index],
				},
			]);

			const result = generateSchemaFile(model, { dbCasing: 'snake_case' });

			expect(result).toContain('indexes: [');
			expect(result).toContain("columns: ['emailAddress']");
			expect(result).toContain('unique: true');
			expect(result).toContain("name: 'uq_user_profiles_email_covering'");
			expect(result).toContain("method: 'btree'");
			expect(result).toContain("where: 'email_address IS NOT NULL'");
			expect(result).toContain(
				"opclass: { ['emailAddress']: 'text_pattern_ops' }",
			);
			expect(result).toContain("with: { ['fillfactor']: '70' }");
			expect(result).toContain("include: ['displayName']");
			expect(result).toContain('nullsNotDistinct: true');
		});

		it('omits indexes rejected by the DDL emitter and leaves them unmanaged', async () => {
			const model = makeCodegenModel([
				{
					name: 'users',
					columns: [
						{ name: 'id', type: 'uuid', nullable: false },
						{ name: 'email', type: 'string', nullable: false },
						{ name: 'body', type: 'string', nullable: false },
					],
					primaryKey: 'id',
					foreignKeys: [],
					indexes: [
						{
							name: 'idx-users-email',
							columns: ['email'],
						},
						{
							name: 'idx_users_body_rum',
							columns: ['body'],
							method: 'rum',
						},
					],
				},
			]);

			const result = generateSchemaFileWithDiagnostics(model);

			expect(result.code).not.toContain('idx-users-email');
			expect(result.code).not.toContain('idx_users_body_rum');
			expect(result.warnings).toHaveLength(2);
			expect(result.warnings).toContainEqual(
				expect.stringContaining('Index "idx-users-email" on table "users"'),
			);
			expect(result.warnings).toContainEqual(
				expect.stringContaining('Invalid alias identifier'),
			);
			expect(result.warnings).toContainEqual(
				expect.stringContaining('Index "idx_users_body_rum" on table "users"'),
			);
			expect(result.warnings).toContainEqual(
				expect.stringContaining('Invalid index method: "rum"'),
			);

			const loaded = await loadGeneratedSchemaCode(result.code);
			expect(() => generateDDL(loaded.model)).not.toThrow();
			const diff = compareSchemata(loaded.model, model);
			expect(diff.changes).toEqual([]);
			expect(generateMigrationSQL(diff, { includeDestructive: false })).toEqual(
				[],
			);
		});

		it('deliberately emits FK-column indexes with database auto-index names', () => {
			const model = makeCodegenModel([
				{
					name: 'users',
					columns: [{ name: 'id', type: 'uuid', nullable: false }],
					primaryKey: 'id',
					foreignKeys: [],
					indexes: [],
				},
				{
					name: 'posts',
					columns: [
						{ name: 'id', type: 'uuid', nullable: false },
						{ name: 'author_id', type: 'uuid', nullable: false },
					],
					primaryKey: 'id',
					foreignKeys: [
						{
							columns: ['author_id'],
							references: { table: 'users', columns: ['id'] },
						},
					],
					indexes: [
						{
							name: 'idx_posts_author_id',
							columns: ['author_id'],
							unique: false,
						},
					],
				},
			]);

			const result = generateSchemaFile(model, { dbCasing: 'snake_case' });

			expect(result).toContain("authorId: ref('users')");
			expect(result).toContain('indexes: [');
			expect(result).toContain("columns: ['authorId']");
			expect(result).toContain("name: 'idx_posts_author_id'");
		});

		it('emits FK indexes whose name does not match the database-form auto-index name', () => {
			const model = makeCodegenModel([
				{
					name: 'users',
					columns: [{ name: 'id', type: 'uuid', nullable: false }],
					primaryKey: 'id',
					foreignKeys: [],
					indexes: [],
				},
				{
					name: 'posts',
					columns: [
						{ name: 'id', type: 'uuid', nullable: false },
						{ name: 'author_id', type: 'uuid', nullable: false },
					],
					primaryKey: 'id',
					foreignKeys: [
						{
							columns: ['author_id'],
							references: { table: 'users', columns: ['id'] },
						},
					],
					indexes: [
						{
							name: 'idx_posts_authorId',
							columns: ['author_id'],
							unique: false,
						},
					],
				},
			]);

			const result = generateSchemaFile(model, { dbCasing: 'snake_case' });

			expect(result).toContain("authorId: ref('users')");
			expect(result).toContain('indexes: [');
			expect(result).toContain("columns: ['authorId']");
			expect(result).toContain("name: 'idx_posts_authorId'");
		});

		it('emits user-named plain indexes on FK columns', () => {
			const model = makeCodegenModel([
				{
					name: 'users',
					columns: [{ name: 'id', type: 'uuid', nullable: false }],
					primaryKey: 'id',
					foreignKeys: [],
					indexes: [],
				},
				{
					name: 'posts',
					columns: [
						{ name: 'id', type: 'uuid', nullable: false },
						{ name: 'author_id', type: 'uuid', nullable: false },
					],
					primaryKey: 'id',
					foreignKeys: [
						{
							columns: ['author_id'],
							references: { table: 'users', columns: ['id'] },
						},
					],
					indexes: [
						{
							name: 'my_lookup_idx',
							columns: ['author_id'],
							unique: false,
						},
					],
				},
			]);

			const result = generateSchemaFile(model, { dbCasing: 'snake_case' });

			expect(result).toContain("authorId: ref('users')");
			expect(result).toContain('indexes: [');
			expect(result).toContain("columns: ['authorId']");
			expect(result).toContain("name: 'my_lookup_idx'");
		});

		it('calls onWarning and does not emit expression indexes', () => {
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			const warnings: string[] = [];
			const model = makeCodegenModel([
				{
					name: 'users',
					columns: [{ name: 'email', type: 'string', nullable: false }],
					foreignKeys: [],
					indexes: [
						{
							name: 'idx_users_lower_email',
							columns: [],
							expressions: ['lower(email)'],
						},
					],
				},
			]);

			const result = generateSchemaFile(model, {
				onWarning: (message) => warnings.push(message),
			});
			const warningText = warnings.join('\n');

			expect(error).not.toHaveBeenCalled();
			expect(log).not.toHaveBeenCalled();
			expect(warningText).toContain(
				'Expression index "idx_users_lower_email" on table "users" cannot be represented in the schema and is not managed by dbsp.',
			);
			expect(warningText).toContain(
				'dbsp will neither drop nor recreate it; maintain it by hand.',
			);
			expect(result).not.toContain('Warnings:');
			expect(result).not.toContain('idx_users_lower_email');
			expect(result).not.toContain('indexes: [');
		});

		it('throws expression-index warnings without onWarning', () => {
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			const model = makeCodegenModel([
				{
					name: 'users',
					columns: [{ name: 'email', type: 'string', nullable: false }],
					foreignKeys: [],
					indexes: [
						{
							name: 'idx_users_lower_email',
							columns: [],
							expressions: ['lower(email)'],
						},
					],
				},
			]);

			expect(() => generateSchemaFile(model)).toThrowError(
				/generateSchemaFile\(\) produced 1 diagnostic\(s\).*idx_users_lower_email.*generateSchemaFileWithDiagnostics\(\).*onWarning/s,
			);

			expect(error).not.toHaveBeenCalled();
			expect(log).not.toHaveBeenCalled();
		});

		it('throws emitter-rejected index warnings without onWarning', () => {
			const model = makeCodegenModel([
				{
					name: 'users',
					columns: [{ name: 'email', type: 'string', nullable: false }],
					foreignKeys: [],
					indexes: [
						{
							name: 'idx-users-email',
							columns: ['email'],
						},
					],
				},
			]);

			expect(() => generateSchemaFile(model)).toThrowError(
				/generateSchemaFile\(\) produced 1 diagnostic\(s\).*idx-users-email.*generateSchemaFileWithDiagnostics\(\).*onWarning/s,
			);
		});

		it('throws legacy caller-supplied warnings without onWarning', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).model;
			const callerWarning = 'caller warning: missing production-only index';

			expect(() =>
				generateSchemaFile(model, {
					warnings: [callerWarning],
				}),
			).toThrowError(
				/generateSchemaFile\(\) produced 1 diagnostic\(s\).*caller warning: missing production-only index/s,
			);
		});

		it('reports legacy caller-supplied warnings through onWarning', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).model;
			const callerWarning = 'caller warning: missing production-only index';
			const streamed: string[] = [];

			const result = generateSchemaFile(model, {
				warnings: [callerWarning],
				onWarning: (message) => streamed.push(message),
			});

			expect(typeof result).toBe('string');
			expect(streamed).toEqual([callerWarning]);
			expect(result).not.toContain(callerWarning);
			expectValidTypeScript(result);
		});

		it('keeps malicious expression-index warning text out of generated source', () => {
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			const warnings: string[] = [];
			const injected =
				"*/\nthrow new Error('generated source injection');\n/*`${";
			const model = makeCodegenModel([
				{
					name: 'users',
					columns: [{ name: 'email', type: 'string', nullable: false }],
					foreignKeys: [],
					indexes: [
						{
							name: `idx_users_email_${injected}`,
							columns: [],
							expressions: ['lower(email)'],
						},
					],
				},
			]);

			const result = generateSchemaFile(model, {
				onWarning: (message) => warnings.push(message),
			});
			const warningText = warnings.join('\n');

			expect(error).not.toHaveBeenCalled();
			expect(warningText).toContain('generated source injection');
			expect(result).not.toContain('generated source injection');
			expect(result).not.toContain('Warnings:');
			expectValidTypeScript(result);
		});

		it('returns code plus pass-through and discovered diagnostics', () => {
			const callerWarning =
				"no primary key */\nthrow new Error('source injection');\n${";
			const streamed: string[] = [];
			const model = makeCodegenModel([
				{
					name: 'notes',
					columns: [
						{ name: 'id', type: 'integer', nullable: false },
						{ name: 'note', type: 'string', nullable: false },
						{ name: 'email', type: 'string', nullable: false },
					],
					primaryKey: 'id',
					foreignKeys: [],
					indexes: [
						{
							name: 'idx_notes_lower_email',
							columns: [],
							expressions: ['lower(email)'],
						},
						{
							name: 'idx_notes_note_literal',
							columns: ['note'],
							where: "note = 'a;b'",
						},
					],
				},
			]);

			const result = generateSchemaFileWithDiagnostics(model, {
				warnings: [callerWarning],
				onWarning: (message) => streamed.push(message),
			});

			expect(typeof result.code).toBe('string');
			expect(result.warnings).toHaveLength(3);
			expect(result.warnings[0]).toBe(callerWarning);
			expect(result.warnings).toContainEqual(
				expect.stringContaining(
					'Expression index "idx_notes_lower_email" on table "notes" cannot be represented in the schema and is not managed by dbsp.',
				),
			);
			expect(result.warnings).toContainEqual(
				expect.stringContaining(
					'Index "idx_notes_note_literal" on table "notes" cannot be represented in the schema and is not managed by dbsp because the DDL emitter rejected it',
				),
			);
			expect(streamed).toEqual(result.warnings);
			expect(result.code).not.toContain('source injection');
			expect(result.code).not.toContain('no primary key */');
			expect(result.code).not.toContain('${');
			expect(result.code).not.toContain('idx_notes_lower_email');
			expect(result.code).not.toContain('idx_notes_note_literal');
			expectValidTypeScript(result.code);
		});

		it('keeps caller-supplied warnings out of generated source', () => {
			const callerWarning =
				"*/\nthrow new Error('caller warning injection');\n${";
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).model;

			const result = generateSchemaFileWithDiagnostics(model, {
				warnings: [callerWarning],
			});

			expect(result.warnings).toEqual([callerWarning]);
			expect(result.code).not.toContain('caller warning injection');
			expect(result.code).not.toContain('*/\nthrow');
			expect(result.code).not.toContain('${');
			expectValidTypeScript(result.code);
		});

		it('omits partial indexes whose predicates the DDL validator rejects and leaves them unmanaged', async () => {
			const model = makeCodegenModel([
				{
					name: 'notes',
					columns: [
						{ name: 'id', type: 'integer', nullable: false },
						{ name: 'note', type: 'string', nullable: false },
					],
					primaryKey: 'id',
					foreignKeys: [],
					indexes: [
						{
							name: 'idx_notes_note_literal',
							columns: ['note'],
							unique: false,
							where: "note = 'a;b'",
						},
					],
				},
			]);

			const result = generateSchemaFileWithDiagnostics(model);

			expect(result.code).not.toContain('idx_notes_note_literal');
			expect(result.code).not.toContain("where: 'note = \\'a;b\\''");
			expect(result.warnings).toContainEqual(
				expect.stringContaining(
					'Index "idx_notes_note_literal" on table "notes" cannot be represented in the schema and is not managed by dbsp because the DDL emitter rejected it',
				),
			);

			const loaded = await loadGeneratedSchemaCode(result.code);
			expect(() => generateDDL(loaded.model)).not.toThrow();
			const diff = compareSchemata(loaded.model, model);
			expect(diff.changes).toEqual([]);
		});

		it('omits non-unique NULLS NOT DISTINCT indexes rejected by schema() and leaves them unmanaged', async () => {
			const model = makeCodegenModel([
				{
					name: 'users',
					columns: [
						{ name: 'id', type: 'integer', nullable: false },
						{ name: 'email', type: 'string', nullable: true },
					],
					primaryKey: 'id',
					foreignKeys: [],
					indexes: [
						{
							name: 'idx_users_email_nulls_not_distinct',
							columns: ['email'],
							unique: false,
							nullsNotDistinct: true,
						},
					],
				},
			]);

			const result = generateSchemaFileWithDiagnostics(model);

			expect(result.code).not.toContain('idx_users_email_nulls_not_distinct');
			expect(result.code).not.toContain('nullsNotDistinct: true');
			expect(result.warnings).toContainEqual(
				expect.stringContaining(
					'Index "idx_users_email_nulls_not_distinct" on table "users" cannot be represented in the schema and is not managed by dbsp because schema() rejected it',
				),
			);

			const loaded = await loadGeneratedSchemaCode(result.code);
			expect(() => generateDDL(loaded.model)).not.toThrow();
			const diff = compareSchemata(loaded.model, model);
			expect(diff.changes).toEqual([]);
		});

		it('emits ordinary partial indexes and the loaded schema has no drift', async () => {
			const model = makeCodegenModel([
				{
					name: 'notes',
					columns: [
						{ name: 'id', type: 'integer', nullable: false },
						{ name: 'deleted_at', type: 'datetime', nullable: true },
					],
					primaryKey: 'id',
					foreignKeys: [],
					indexes: [
						{
							name: 'idx_notes_active',
							columns: ['deleted_at'],
							unique: false,
							where: 'deleted_at IS NULL',
						},
					],
				},
			]);

			const result = generateSchemaFileWithDiagnostics(model);

			expect(result.warnings).toEqual([]);
			expect(result.code).toContain("name: 'idx_notes_active'");
			expect(result.code).toContain("where: 'deleted_at IS NULL'");

			const loaded = await loadGeneratedSchemaCode(result.code);
			expect(() => generateDDL(loaded.model)).not.toThrow();
			expect(compareSchemata(loaded.model, model).changes).toEqual([]);
		});

		it('round-trip invariant: generated schema loads through schema() and re-emits through generateDDL', async () => {
			const model = makeCodegenModel([
				{
					name: 'notes',
					columns: [
						{ name: 'id', type: 'integer', nullable: false },
						{ name: 'note', type: 'string', nullable: false },
						{ name: 'email', type: 'string', nullable: false },
						{ name: 'deleted_at', type: 'datetime', nullable: true },
					],
					primaryKey: 'id',
					foreignKeys: [],
					indexes: [
						{
							name: 'idx_notes_lower_email',
							columns: [],
							expressions: ['lower(email)'],
						},
						{
							name: 'idx_notes_note_literal',
							columns: ['note'],
							where: "note = 'a;b'",
						},
						{
							name: 'idx_notes_active',
							columns: ['deleted_at'],
							where: 'deleted_at IS NULL',
						},
						{
							name: 'idx_notes_email_pattern',
							columns: ['email'],
							opclass: { email: 'text_pattern_ops' },
						},
						{
							name: 'idx_notes_email_covering',
							columns: ['email'],
							include: ['note'],
							with: { fillfactor: '70' },
						},
						{
							name: 'idx-notes-email',
							columns: ['email'],
						},
						{
							name: 'idx_notes_email_rum',
							columns: ['email'],
							method: 'rum',
						},
						{
							name: 'idx_notes_email_nonunique_nulls',
							columns: ['email'],
							unique: false,
							nullsNotDistinct: true,
						},
					],
				},
			]);

			const result = generateSchemaFileWithDiagnostics(model);

			expect(result.code).not.toContain('idx_notes_lower_email');
			expect(result.code).not.toContain('idx_notes_note_literal');
			expect(result.code).not.toContain('idx-notes-email');
			expect(result.code).not.toContain('idx_notes_email_rum');
			expect(result.code).not.toContain('idx_notes_email_nonunique_nulls');
			expect(result.code).toContain('idx_notes_active');
			expect(result.warnings).toContainEqual(
				expect.stringContaining(
					'Index "idx_notes_email_nonunique_nulls" on table "notes" cannot be represented in the schema and is not managed by dbsp because schema() rejected it',
				),
			);

			const loaded = await loadGeneratedSchemaCode(result.code);
			for (const table of loaded.model.tables.values()) {
				for (const idx of table.indexes) {
					expect(() =>
						generateCreateIndex(table.name, idx, undefined, identityNaming),
					).not.toThrow();
				}
			}
			expect(() => generateDDL(loaded.model)).not.toThrow();
			expect(compareSchemata(loaded.model, model).changes).toEqual([]);
		});

		it('emits opclass and with __proto__ keys as own computed properties', async () => {
			const model = makeCodegenModel([
				{
					name: 'notes',
					columns: [
						{ name: 'id', type: 'integer', nullable: false },
						{ name: 'email', type: 'string', nullable: false },
					],
					primaryKey: 'id',
					foreignKeys: [],
					indexes: [
						{
							name: 'idx_notes_email_proto',
							columns: ['email'],
							opclass: { ['__proto__']: 'text_pattern_ops' },
							with: { ['__proto__']: '70' },
						},
					],
				},
			]);

			const result = generateSchemaFileWithDiagnostics(model);

			expect(result.warnings).toEqual([]);
			expect(result.code).toContain(
				"opclass: { ['__proto__']: 'text_pattern_ops' }",
			);
			expect(result.code).toContain("with: { ['__proto__']: '70' }");

			const loaded = await loadGeneratedSchemaCode(result.code);
			const idx = loaded.model.getTable('notes')?.indexes[0];
			expect(Object.hasOwn(idx?.opclass ?? {}, '__proto__')).toBe(true);
			expect(Object.hasOwn(idx?.with ?? {}, '__proto__')).toBe(true);
			expect(idx?.opclass?.['__proto__']).toBe('text_pattern_ops');
			expect(idx?.with?.['__proto__']).toBe('70');
		});
	});

	describe('E2E: introspected ModelIR → codegen → valid schema code', () => {
		it('generates complete schema from a realistic introspection result', () => {
			// Simulate what introspect() returns: snake_case tables with FKs,
			// nullable columns, defaults, and originalDbType metadata
			const model = schema({
				user_profiles: {
					id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
					first_name: 'string',
					last_name: 'string',
					bio: { type: 'string', nullable: true },
					created_at: 'datetime',
				},
				blog_posts: {
					id: { type: 'uuid', primaryKey: true },
					title: 'string',
					author_id: ref('user_profiles'),
					published: { type: 'boolean', default: false },
				},
				post_comments: {
					id: { type: 'uuid', primaryKey: true },
					body: 'string',
					post_id: ref('blog_posts'),
					commenter_id: ref('user_profiles', { nullable: true }),
				},
			}).model;

			// Add originalDbType metadata (simulating introspection output)
			const profiles = model.tables.get('user_profiles');
			if (profiles) {
				const bioCol = profiles.columns.find((c) => c.name === 'bio');
				if (bioCol)
					(bioCol as { originalDbType?: string }).originalDbType = 'text';
			}

			const options: SchemaCodegenOptions = {
				sourceUrl: 'postgresql://admin:s3cret@db.example.com/myapp',
				includeDbTypeComments: true,
				introspectedAt: new Date('2026-01-31T10:00:00Z'),
				dbCasing: 'snake_case',
			};

			const result = generateSchemaFile(model, options);

			// --- Header ---
			expect(result).toContain('Auto-generated by: dbsp introspect');
			expect(result).toContain(
				'Source: postgresql://admin:***@db.example.com/myapp',
			);
			expect(result).not.toContain('s3cret');
			expect(result).toContain('Generated: 2026-01-31T10:00:00.000Z');
			expect(result).not.toContain('Type mapping lossy');

			// --- Imports ---
			expect(result).toContain("import { schema, ref } from '@dbsp/core';");
			expect(result).toContain(
				"import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';",
			);

			// --- Table names are camelCase ---
			expect(result).toContain('userProfiles: {');
			expect(result).toContain('blogPosts: {');
			expect(result).toContain('postComments: {');
			expect(result).not.toContain('user_profiles: {');
			expect(result).not.toContain('blog_posts: {');
			expect(result).not.toContain('post_comments: {');

			// --- Column names are camelCase ---
			expect(result).toContain('firstName:');
			expect(result).toContain('lastName:');
			expect(result).toContain('createdAt:');

			// --- FK refs point to camelCase table names ---
			expect(result).toContain("ref('userProfiles')");
			expect(result).toContain("ref('blogPosts')");

			// --- Nullable FK ---
			expect(result).toContain("ref('userProfiles', { nullable: true })");

			// --- Defaults ---
			expect(result).toContain("default: 'gen_random_uuid()'");
			expect(result).toContain('default: false');

			// --- DB type comment ---
			expect(result).toContain('/* from: text */');

			// --- dbCasing export ---
			expect(result).toContain(
				"export const dbCasing = 'snake_case' as const;",
			);
			expect(result).toContain('createPgsqlAdapter(pool');

			// --- Syntactic validity: balanced braces ---
			const opens = (result.match(/\{/g) || []).length;
			const closes = (result.match(/\}/g) || []).length;
			expect(opens).toBe(closes);

			// --- Schema definition structure ---
			expect(result).toContain('export const dbSchema = schema({');
			expect(result).toContain('});');
		});

		it('generates valid code without dbCasing (preserve mode)', () => {
			const model = schema({
				user_profiles: {
					id: { type: 'uuid', primaryKey: true },
					first_name: 'string',
				},
				blog_posts: {
					id: { type: 'uuid', primaryKey: true },
					author_id: ref('user_profiles'),
				},
			}).model;

			const result = generateSchemaFile(model);

			// Everything stays snake_case (preserve is default)
			expect(result).toContain('user_profiles: {');
			expect(result).toContain('first_name:');
			expect(result).toContain("ref('user_profiles')");
			expect(result).not.toContain('userProfiles');
			expect(result).not.toContain('export const dbCasing');
		});
	});

	describe('non-PK FK references round-trip (C2 codegen)', () => {
		it('emits references option for non-PK FK column', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					email: { type: 'string', unique: true },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					authorEmail: ref('users', { references: ['email'] }),
				},
			}).model;

			const result = generateSchemaFile(model);

			// The non-PK FK should emit references option
			expect(result).toContain("references: ['email']");
			// Should use ref() with the option, not bare ref()
			expect(result).toContain("ref('users', { references: ['email'] })");
		});

		it('does not emit references option for default PK FK (id)', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					authorId: ref('users'),
				},
			}).model;

			const result = generateSchemaFile(model);

			// Default PK FK should use bare ref() — no references option
			expect(result).toContain("ref('users')");
			expect(result).not.toContain('references:');
			expect(result).not.toContain('schema:');
		});

		it('round-trips: schema → model → codegen → contains correct ref call', () => {
			// This test verifies the full round-trip:
			// ref('users', { references: ['email'] })
			//   → ModelIR FK { references: { table: 'users', columns: ['email'] } }
			//   → generateSchemaFile → ref('users', { references: ['email'] })
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					email: { type: 'string', unique: true },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					authorEmail: ref('users', { references: ['email'] }),
				},
			}).model;

			const result = generateSchemaFile(model);

			// Verify the FK column references the non-PK column
			const fk = model.tables.get('posts')?.foreignKeys[0];
			expect(fk?.references.columns).toEqual(['email']);

			// Verify the generated code emits the references option
			expect(result).toContain("ref('users', { references: ['email'] })");
		});

		it('emits references alongside other FK options', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					email: { type: 'string', unique: true },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					authorEmail: ref('users', {
						references: ['email'],
						nullable: true,
						onDelete: 'CASCADE',
					}),
				},
			}).model;

			const result = generateSchemaFile(model);

			// All options should be emitted
			expect(result).toContain("references: ['email']");
			expect(result).toContain('nullable: true');
			expect(result).toContain("onDelete: 'CASCADE'");
		});
	});

	describe('cross-schema foreign keys', () => {
		it('emits schema option for a single-column table-level foreign key reference', () => {
			const model = makeCodegenModel([
				{
					name: 'users',
					columns: [{ name: 'id', type: 'uuid', nullable: false }],
					primaryKey: 'id',
					foreignKeys: [],
					indexes: [],
				},
				{
					name: 'posts',
					columns: [
						{ name: 'id', type: 'uuid', nullable: false },
						{ name: 'authorId', type: 'uuid', nullable: false },
					],
					primaryKey: 'id',
					foreignKeys: [
						{
							columns: ['authorId'],
							references: { schema: 'auth', table: 'users', columns: ['id'] },
						},
					],
					indexes: [],
				},
			]);

			const result = generateSchemaFile(model);

			expect(result).toContain("authorId: 'uuid'");
			expect(result).not.toContain(
				"authorId: ref('users', { schema: 'auth' })",
			);
			expect(result).toContain(
				"ref('users', { schema: 'auth', columns: ['authorId'], references: ['id'] })",
			);
		});

		it('emits schema option for a composite table-level foreign key reference', () => {
			const model = makeCodegenModel([
				{
					name: 'orders',
					columns: [
						{ name: 'tenantId', type: 'uuid', nullable: false },
						{ name: 'orderId', type: 'uuid', nullable: false },
					],
					primaryKey: ['tenantId', 'orderId'],
					foreignKeys: [],
					indexes: [],
				},
				{
					name: 'lineItems',
					columns: [
						{ name: 'id', type: 'uuid', nullable: false },
						{ name: 'tenantId', type: 'uuid', nullable: false },
						{ name: 'orderId', type: 'uuid', nullable: false },
					],
					primaryKey: 'id',
					foreignKeys: [
						{
							columns: ['tenantId', 'orderId'],
							references: {
								schema: 'billing',
								table: 'orders',
								columns: ['tenantId', 'orderId'],
							},
						},
					],
					indexes: [],
				},
			]);

			const result = generateSchemaFile(model);

			expect(result).toContain(
				"ref('orders', { schema: 'billing', columns: ['tenantId', 'orderId'], references: ['tenantId', 'orderId'] })",
			);
		});
	});
});

// ============================================================================
// Item 4: generated output must be loadable by schema-loader (default export)
// ============================================================================
//
// schema-loader.loadSchema() accepts module.schema || module.default.
// generateSchemaFile() previously only emitted `export const dbSchema = ...`
// which satisfies neither — the generated file could NOT be loaded by other
// commands.  The fix adds `export default dbSchema`.

describe('generateSchemaFile — schema-loader interoperability (item 4)', () => {
	it('emits "export default dbSchema" so schema-loader can load via module.default', () => {
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
				name: { type: 'string' },
			},
		}).model;

		const result = generateSchemaFile(model);

		// schema-loader does: const schema = module.schema ?? module.default
		// The generated file must satisfy at least module.default.
		expect(result).toContain('export default dbSchema');
	});

	it('mutation guard: without default export the generated file has no loadable export', () => {
		// Documents what the old code produced — only export const dbSchema.
		// schema-loader's module.schema and module.default were both undefined,
		// so loadSchema() would throw 'Schema file must export schema or default'.
		const oldOutput = 'export const dbSchema = schema({ users: {} });\n';

		// Old output has no 'export default' line — loader would fail.
		expect(oldOutput).not.toContain('export default');

		// New output (from generateSchemaFile) includes it.
		const model = schema({
			users: { id: { type: 'uuid', primaryKey: true } },
		}).model;
		const newOutput = generateSchemaFile(model);
		expect(newOutput).toContain('export default dbSchema');
	});

	it('retains the export const dbSchema named export for direct consumer use', () => {
		// Consumers that import { dbSchema } directly must not be broken.
		const model = schema({
			users: { id: { type: 'uuid', primaryKey: true } },
		}).model;

		const result = generateSchemaFile(model);

		expect(result).toContain('export const dbSchema = schema({');
		expect(result).toContain('export default dbSchema');
	});
});

// ============================================================================
// Item 6: FK target table names and self-ref roles must be escaped (item 6)
// ============================================================================
//
// ref('${refTable}') without singleQuoteEscape produces a syntax error when
// refTable contains a single-quote, backslash, or newline.

describe('generateSchemaFile — FK target name escaping (item 6)', () => {
	it('generates valid output for a normal FK target (smoke test, no regression)', () => {
		const model = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
			},
			posts: {
				id: { type: 'uuid', primaryKey: true },
				authorId: ref('users'),
			},
		}).model;

		const result = generateSchemaFile(model);

		// Standard table name should still appear as a properly quoted string.
		expect(result).toContain("ref('users')");
	});

	it('mutation guard: FK target name containing a single-quote is escaped (revert this fix → RED)', () => {
		// This test FAILS if generateRefCode reverts to bare interpolation:
		//   code = `ref('${refTable}')` → produces ref('o'brien') — invalid TS syntax.
		// With singleQuoteEscape it produces ref('o\'brien') — valid TS.
		//
		// We bypass schema() (which validates identifiers) and pass a ModelIR-shaped
		// object directly so we can inject an arbitrarily-named FK target table.
		const quotedTable = "o'brien"; // contains a literal single-quote

		// Minimal TableIR for the referencing table
		const postsTable: TableIR = {
			name: 'posts',
			columns: [
				{ name: 'id', type: 'uuid', nullable: false },
				{ name: 'clientId', type: 'string', nullable: false },
			],
			primaryKey: 'id',
			foreignKeys: [
				{
					columns: ['clientId'],
					references: { table: quotedTable, columns: ['id'] },
				},
			],
			indexes: [],
		};

		// Minimal referenced table (no FK of its own)
		const obriensTable: TableIR = {
			name: quotedTable,
			columns: [{ name: 'id', type: 'uuid', nullable: false }],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
		};

		// Build a ModelIR-shaped object.  generateSchemaFile only reads
		// model.tables.values() and model.relations.values(), so a plain Map suffices.
		const model = {
			tables: new Map<string, TableIR>([
				[obriensTable.name, obriensTable],
				[postsTable.name, postsTable],
			]),
			relations: new Map(),
			getTable: (name: string) =>
				(model.tables as Map<string, TableIR>).get(name),
			getRelation: () => undefined,
		} as unknown as ModelIR;

		const result = generateSchemaFile(model);

		// Must contain the properly escaped form — NOT the broken bare form.
		expect(result).toContain("ref('o\\'brien')"); // escaped ✓
		expect(result).not.toContain("ref('o'brien')"); // bare interpolation ✗
	});
});
