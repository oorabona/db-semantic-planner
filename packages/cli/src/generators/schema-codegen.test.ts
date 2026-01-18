/**
 * CLI-DDL: Schema Codegen Tests
 *
 * Tests for generateSchemaFile() which generates TypeScript schema from ModelIR.
 */

import { defineSchema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { generateSchemaFile, type SchemaCodegenOptions } from './schema-codegen.js';

describe('generateSchemaFile', () => {
	describe('basic structure', () => {
		it('generates valid schema file with imports', () => {
			const model = defineSchema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					name: { type: 'string' },
				},
			}).build();

			const result = generateSchemaFile(model);

			expect(result).toContain("import { defineSchema } from '@dbsp/schema';");
			expect(result).toContain('export const schema = defineSchema({');
			expect(result).toContain('});');
		});

		it('generates table definitions', () => {
			const model = defineSchema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).build();

			const result = generateSchemaFile(model);

			expect(result).toContain('users: {');
			expect(result).toContain("id: { type: 'uuid', primaryKey: true }");
		});

		it('generates multiple tables', () => {
			const model = defineSchema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).build();

			const result = generateSchemaFile(model);

			expect(result).toContain('users: {');
			expect(result).toContain('posts: {');
		});
	});

	describe('column types', () => {
		it('generates correct type property', () => {
			const model = defineSchema({
				test: {
					id: { type: 'uuid', primaryKey: true },
					name: { type: 'string' },
					count: { type: 'number' },
					active: { type: 'boolean' },
				},
			}).build();

			const result = generateSchemaFile(model);

			expect(result).toContain("type: 'uuid'");
			expect(result).toContain("type: 'string'");
			expect(result).toContain("type: 'number'");
			expect(result).toContain("type: 'boolean'");
		});
	});

	describe('primary key', () => {
		it('marks single primary key column', () => {
			const model = defineSchema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					name: { type: 'string' },
				},
			}).build();

			const result = generateSchemaFile(model);

			expect(result).toContain("id: { type: 'uuid', primaryKey: true }");
			expect(result).not.toContain("name: { type: 'string', primaryKey: true }");
		});

		it('does not mark non-primary key columns', () => {
			const model = defineSchema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					email: { type: 'string' },
					name: { type: 'string' },
				},
			}).build();

			const result = generateSchemaFile(model);

			// Only id should have primaryKey: true
			const matches = result.match(/primaryKey: true/g);
			expect(matches).toHaveLength(1);
			expect(result).toContain("id: { type: 'uuid', primaryKey: true }");
		});
	});

	describe('nullable columns', () => {
		it('adds nullable: true for nullable columns', () => {
			const model = defineSchema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					bio: { type: 'string', nullable: true },
				},
			}).build();

			const result = generateSchemaFile(model);

			expect(result).toContain("bio: { type: 'string', nullable: true }");
		});

		it('omits nullable for non-nullable columns', () => {
			const model = defineSchema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					name: { type: 'string' },
				},
			}).build();

			const result = generateSchemaFile(model);

			// name should not have nullable property
			expect(result).toContain("name: { type: 'string' }");
			expect(result).not.toContain("name: { type: 'string', nullable:");
		});
	});

	describe('default values', () => {
		it('includes string default values with quotes', () => {
			const model = defineSchema({
				users: {
					id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
				},
			}).build();

			const result = generateSchemaFile(model);

			expect(result).toContain("default: 'gen_random_uuid()'");
		});

		it('includes numeric default values without quotes', () => {
			const model = defineSchema({
				posts: {
					id: { type: 'uuid', primaryKey: true },
					views: { type: 'number', default: 0 },
				},
			}).build();

			const result = generateSchemaFile(model);

			expect(result).toContain('default: 0');
		});

		it('includes boolean default values', () => {
			const model = defineSchema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					active: { type: 'boolean', default: true },
				},
			}).build();

			const result = generateSchemaFile(model);

			expect(result).toContain('default: true');
		});
	});

	describe('foreign key references', () => {
		it('includes references for FK columns', () => {
			const model = defineSchema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					author_id: { type: 'uuid', references: { table: 'users' } },
				},
			}).build();

			const result = generateSchemaFile(model);

			// When referencing 'id' column, only table is included (default)
			expect(result).toContain("references: { table: 'users' }");
		});

		it('includes column in references when not id', () => {
			const model = defineSchema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					email: { type: 'string' },
				},
				posts: {
					id: { type: 'uuid', primaryKey: true },
					author_email: { type: 'string', references: { table: 'users', column: 'email' } },
				},
			}).build();

			const result = generateSchemaFile(model);

			expect(result).toContain("references: { table: 'users', column: 'email' }");
		});
	});

	describe('options', () => {
		it('includes source URL in header (redacted)', () => {
			const model = defineSchema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).build();

			const options: SchemaCodegenOptions = {
				sourceUrl: 'postgresql://user:secret123@localhost/mydb',
			};

			const result = generateSchemaFile(model, options);

			expect(result).toContain('Source: postgresql://user:***@localhost/mydb');
			expect(result).not.toContain('secret123');
		});

		it('includes timestamp in header', () => {
			const model = defineSchema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).build();

			const options: SchemaCodegenOptions = {
				introspectedAt: new Date('2026-01-18T12:00:00Z'),
			};

			const result = generateSchemaFile(model, options);

			expect(result).toContain('Generated: 2026-01-18T12:00:00.000Z');
		});

		it('includes warnings in header', () => {
			const model = defineSchema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).build();

			const options: SchemaCodegenOptions = {
				warnings: ['Type mapping lossy: jsonb → json', 'Unknown type: custom_enum'],
			};

			const result = generateSchemaFile(model, options);

			expect(result).toContain('Warnings:');
			expect(result).toContain('Type mapping lossy: jsonb → json');
			expect(result).toContain('Unknown type: custom_enum');
		});

		it('includes DB type comments when enabled', () => {
			// For this test, we need to manually create a model with originalDbType
			// since defineSchema doesn't include that field
			const model = defineSchema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					data: { type: 'json', nullable: true },
				},
			}).build();

			// Manually set originalDbType on the columns (simulating introspection output)
			const usersTable = model.tables.get('users');
			if (usersTable) {
				// Cast to mutable for test setup
				const idCol = usersTable.columns.find(c => c.name === 'id');
				const dataCol = usersTable.columns.find(c => c.name === 'data');
				if (idCol) (idCol as { originalDbType?: string }).originalDbType = 'uuid';
				if (dataCol) (dataCol as { originalDbType?: string }).originalDbType = 'jsonb';
			}

			const options: SchemaCodegenOptions = {
				includeDbTypeComments: true,
			};

			const result = generateSchemaFile(model, options);

			expect(result).toContain('/* from: uuid */');
			expect(result).toContain('/* from: jsonb */');
		});

		it('omits DB type comments when disabled', () => {
			const model = defineSchema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).build();

			const options: SchemaCodegenOptions = {
				includeDbTypeComments: false,
			};

			const result = generateSchemaFile(model, options);

			expect(result).not.toContain('/* from:');
		});
	});

	describe('header comment', () => {
		it('includes auto-generated notice', () => {
			const model = defineSchema({
				users: {
					id: { type: 'uuid', primaryKey: true },
				},
			}).build();

			const result = generateSchemaFile(model);

			expect(result).toContain('Auto-generated by: dbsp introspect');
			expect(result).toContain('Review before using in production.');
		});
	});
});
