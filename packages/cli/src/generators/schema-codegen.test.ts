/**
 * CLI-DDL: Schema Codegen Tests
 *
 * Tests for generateSchemaFile() which generates TypeScript schema from ModelIR.
 */

import { ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import {
	generateSchemaFile,
	type SchemaCodegenOptions,
} from './schema-codegen.js';

describe('generateSchemaFile', () => {
	describe('basic structure', () => {
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

		it('includes warnings in header', () => {
			const model = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).model;

			const options: SchemaCodegenOptions = {
				warnings: [
					'Type mapping lossy: jsonb → json',
					'Unknown type: custom_enum',
				],
			};

			const result = generateSchemaFile(model, options);

			expect(result).toContain('Warnings:');
			expect(result).toContain('Type mapping lossy: jsonb → json');
			expect(result).toContain('Unknown type: custom_enum');
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

		// TODO: schema-codegen does not yet camelCase non-PK FK target references — tracked separately
		it.skip('converts non-PK FK target column to camelCase in references option (dbCasing snake_case)', () => {
			// Regression: PR #83 landed non-PK FK references plumbing but the
			// schema-bridge camelCase transform must also apply to references[]
			// columns, not just FK source column names.
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
				warnings: ['Type mapping lossy: jsonb → json'],
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
			expect(result).toContain('Type mapping lossy');

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
});
