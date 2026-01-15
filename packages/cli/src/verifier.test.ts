/**
 * Tests for ARCH-002 Block 7: Schema Verifier
 */

import { defineSchema } from '@dbsp/schema';
import { describe, expect, it } from 'vitest';
import { type DbTableInfo, formatVerifyResult, verify } from './verifier.js';

describe('verify', () => {
	describe('table-level drift', () => {
		it('should detect missing table in database', () => {
			const schema = defineSchema({
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						name: { type: 'string' },
					},
					posts: {
						id: { type: 'uuid', primaryKey: true },
						title: { type: 'string' },
					},
				},
			});

			const dbTables: DbTableInfo[] = [
				{
					name: 'users',
					columns: [
						{ name: 'id', dataType: 'uuid', isNullable: false },
						{ name: 'name', dataType: 'character varying', isNullable: true },
					],
				},
			];

			const result = verify(schema, dbTables);

			expect(result.valid).toBe(false);
			expect(result.issues).toContainEqual(
				expect.objectContaining({
					severity: 'error',
					type: 'missing_table_in_db',
					table: 'posts',
				}),
			);
		});

		it('should detect extra table in database', () => {
			const schema = defineSchema({
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
					},
				},
			});

			const dbTables: DbTableInfo[] = [
				{
					name: 'users',
					columns: [{ name: 'id', dataType: 'uuid', isNullable: false }],
				},
				{
					name: 'legacy_table',
					columns: [{ name: 'id', dataType: 'integer', isNullable: false }],
				},
			];

			const result = verify(schema, dbTables);

			// Extra tables are warnings, not errors
			expect(result.valid).toBe(true);
			expect(result.issues).toContainEqual(
				expect.objectContaining({
					severity: 'warning',
					type: 'missing_table_in_schema',
					table: 'legacy_table',
				}),
			);
		});

		it('should return valid when tables match', () => {
			const schema = defineSchema({
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						name: { type: 'string' },
					},
				},
			});

			const dbTables: DbTableInfo[] = [
				{
					name: 'users',
					columns: [
						{ name: 'id', dataType: 'uuid', isNullable: false },
						{ name: 'name', dataType: 'character varying', isNullable: true },
					],
				},
			];

			const result = verify(schema, dbTables);

			expect(result.valid).toBe(true);
			expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(
				0,
			);
		});
	});

	describe('column-level drift', () => {
		it('should detect missing column in database', () => {
			const schema = defineSchema({
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						name: { type: 'string' },
						email: { type: 'string' },
					},
				},
			});

			const dbTables: DbTableInfo[] = [
				{
					name: 'users',
					columns: [
						{ name: 'id', dataType: 'uuid', isNullable: false },
						{ name: 'name', dataType: 'character varying', isNullable: true },
						// email column missing
					],
				},
			];

			const result = verify(schema, dbTables);

			expect(result.valid).toBe(false);
			expect(result.issues).toContainEqual(
				expect.objectContaining({
					severity: 'error',
					type: 'missing_column_in_db',
					table: 'users',
					column: 'email',
				}),
			);
		});

		it('should detect extra column in database', () => {
			const schema = defineSchema({
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						name: { type: 'string' },
					},
				},
			});

			const dbTables: DbTableInfo[] = [
				{
					name: 'users',
					columns: [
						{ name: 'id', dataType: 'uuid', isNullable: false },
						{ name: 'name', dataType: 'character varying', isNullable: true },
						{ name: 'avatar', dataType: 'text', isNullable: true },
					],
				},
			];

			const result = verify(schema, dbTables);

			// Extra columns are info, not errors
			expect(result.valid).toBe(true);
			expect(result.issues).toContainEqual(
				expect.objectContaining({
					severity: 'info',
					type: 'missing_column_in_schema',
					table: 'users',
					column: 'avatar',
				}),
			);
		});

		it('should detect type mismatch', () => {
			const schema = defineSchema({
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						age: { type: 'integer' },
					},
				},
			});

			const dbTables: DbTableInfo[] = [
				{
					name: 'users',
					columns: [
						{ name: 'id', dataType: 'uuid', isNullable: false },
						{ name: 'age', dataType: 'text', isNullable: true }, // Wrong type
					],
				},
			];

			const result = verify(schema, dbTables);

			expect(result.valid).toBe(false);
			expect(result.issues).toContainEqual(
				expect.objectContaining({
					severity: 'error',
					type: 'type_mismatch',
					table: 'users',
					column: 'age',
				}),
			);
		});

		it('should detect nullable mismatch', () => {
			const schema = defineSchema({
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						email: { type: 'string', nullable: false },
					},
				},
			});

			const dbTables: DbTableInfo[] = [
				{
					name: 'users',
					columns: [
						{ name: 'id', dataType: 'uuid', isNullable: false },
						{ name: 'email', dataType: 'character varying', isNullable: true }, // Mismatch
					],
				},
			];

			const result = verify(schema, dbTables);

			expect(result.issues).toContainEqual(
				expect.objectContaining({
					severity: 'warning',
					type: 'nullable_mismatch',
					table: 'users',
					column: 'email',
				}),
			);
		});
	});

	describe('type compatibility', () => {
		it('should accept varchar as string', () => {
			const schema = defineSchema({
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						name: { type: 'string' },
					},
				},
			});

			const dbTables: DbTableInfo[] = [
				{
					name: 'users',
					columns: [
						{ name: 'id', dataType: 'uuid', isNullable: false },
						{ name: 'name', dataType: 'character varying', isNullable: true },
					],
				},
			];

			const result = verify(schema, dbTables);

			expect(result.valid).toBe(true);
			expect(
				result.issues.filter((i) => i.type === 'type_mismatch'),
			).toHaveLength(0);
		});

		it('should accept int4 as integer', () => {
			const schema = defineSchema({
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						age: { type: 'integer' },
					},
				},
			});

			const dbTables: DbTableInfo[] = [
				{
					name: 'users',
					columns: [
						{ name: 'id', dataType: 'uuid', isNullable: false },
						{ name: 'age', dataType: 'int4', isNullable: true },
					],
				},
			];

			const result = verify(schema, dbTables);

			expect(result.valid).toBe(true);
		});

		it('should accept timestamptz as timestamp', () => {
			const schema = defineSchema({
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						createdAt: { type: 'timestamp' },
					},
				},
			});

			const dbTables: DbTableInfo[] = [
				{
					name: 'users',
					columns: [
						{ name: 'id', dataType: 'uuid', isNullable: false },
						{
							name: 'createdAt',
							dataType: 'timestamp with time zone',
							isNullable: true,
						},
					],
				},
			];

			const result = verify(schema, dbTables);

			expect(result.valid).toBe(true);
		});

		it('should accept jsonb as json', () => {
			const schema = defineSchema({
				tables: {
					users: {
						id: { type: 'uuid', primaryKey: true },
						metadata: { type: 'json' },
					},
				},
			});

			const dbTables: DbTableInfo[] = [
				{
					name: 'users',
					columns: [
						{ name: 'id', dataType: 'uuid', isNullable: false },
						{ name: 'metadata', dataType: 'jsonb', isNullable: true },
					],
				},
			];

			const result = verify(schema, dbTables);

			expect(result.valid).toBe(true);
		});
	});
});

describe('formatVerifyResult', () => {
	it('should format valid result', () => {
		const result = {
			valid: true,
			issues: [],
			schemaTables: ['users', 'posts'],
			dbTables: ['users', 'posts'],
		};

		const output = formatVerifyResult(result);

		expect(output).toContain('✅ Schema matches database');
		expect(output).toContain('Tables in schema: 2');
		expect(output).toContain('Tables in database: 2');
	});

	it('should format result with errors', () => {
		const result = {
			valid: false,
			issues: [
				{
					severity: 'error' as const,
					type: 'missing_table_in_db' as const,
					table: 'posts',
					message: 'Table "posts" exists in schema but not in database',
				},
			],
			schemaTables: ['users', 'posts'],
			dbTables: ['users'],
		};

		const output = formatVerifyResult(result);

		expect(output).toContain('❌ Schema drift detected');
		expect(output).toContain('1 error(s)');
		expect(output).toContain(
			'Table "posts" exists in schema but not in database',
		);
	});

	it('should format result with warnings', () => {
		const result = {
			valid: true,
			issues: [
				{
					severity: 'warning' as const,
					type: 'missing_table_in_schema' as const,
					table: 'legacy',
					message: 'Table "legacy" exists in database but not in schema',
				},
			],
			schemaTables: ['users'],
			dbTables: ['users', 'legacy'],
		};

		const output = formatVerifyResult(result);

		expect(output).toContain('✅ Schema matches database');
		expect(output).toContain('1 warning(s)');
	});
});
