/**
 * Tests for Schema Verifier — Drift Detection via Comparison Engine
 */

import { compareSchemata } from '@dbsp/adapter-pgsql';
import type { ModelIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { formatVerifyResult, verifyFromDiff } from './verifier.js';

// ============================================================================
// Helpers
// ============================================================================

function makeModel(tables: [string, TableIR][]): ModelIR {
	return {
		tables: new Map(tables),
		relations: new Map(),
		enums: new Map(),
		getTable: (name: string) =>
			tables.find(([tableName]) => tableName === name)?.[1],
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function makeTable(overrides: Partial<TableIR> & { name: string }): TableIR {
	return {
		columns: [],
		foreignKeys: [],
		indexes: [],
		...overrides,
	};
}

function verify(schemaModel: ModelIR, dbModel: ModelIR) {
	const diff = compareSchemata(schemaModel, dbModel);
	const schemaTables = Array.from(schemaModel.tables.keys());
	const dbTables = Array.from(dbModel.tables.keys());
	return verifyFromDiff(diff, schemaTables, dbTables);
}

// ============================================================================
// Tests
// ============================================================================

describe('verify (via compareSchemata)', () => {
	it('reports declared readdress drift with its state and blocks refused work', () => {
		const desired = makeModel([
			[
				'accounts',
				makeTable({
					name: 'accounts',
					readdress: {
						from: { name: 'users' },
						to: { name: 'accounts' },
					},
				}),
			],
		]);
		const refused = verify(desired, makeModel([]));
		expect(refused).toMatchObject({
			valid: false,
			issues: [
				{
					type: 'readdress_table',
					severity: 'error',
					readdress: { state: 'source-missing' },
				},
			],
		});

		const executable = verify(
			desired,
			makeModel([['users', makeTable({ name: 'users' })]]),
		);
		expect(executable).toMatchObject({
			valid: true,
			issues: [
				{
					type: 'readdress_table',
					severity: 'warning',
					readdress: { state: 'source-only' },
				},
			],
		});
	});

	describe('table-level drift', () => {
		it('should detect missing table in database', () => {
			const schemaModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'name', type: 'string', nullable: true },
						],
						primaryKey: 'id',
					}),
				],
				[
					'posts',
					makeTable({
						name: 'posts',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'title', type: 'string', nullable: true },
						],
						primaryKey: 'id',
					}),
				],
			]);

			const dbModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'name', type: 'string', nullable: true },
						],
						primaryKey: 'id',
					}),
				],
			]);

			const result = verify(schemaModel, dbModel);

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
			const schemaModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [{ name: 'id', type: 'uuid', nullable: false }],
						primaryKey: 'id',
					}),
				],
			]);

			const dbModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [{ name: 'id', type: 'uuid', nullable: false }],
						primaryKey: 'id',
					}),
				],
				[
					'legacy_table',
					makeTable({
						name: 'legacy_table',
						columns: [{ name: 'id', type: 'integer', nullable: false }],
					}),
				],
			]);

			const result = verify(schemaModel, dbModel);

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

		it('should return valid when schemas match', () => {
			const model = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'name', type: 'string', nullable: true },
						],
						primaryKey: 'id',
					}),
				],
			]);

			const result = verify(model, model);

			expect(result.valid).toBe(true);
			expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(
				0,
			);
		});
	});

	describe('column-level drift', () => {
		it('should detect missing column in database', () => {
			const schemaModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'name', type: 'string', nullable: true },
							{ name: 'email', type: 'string', nullable: true },
						],
						primaryKey: 'id',
					}),
				],
			]);

			const dbModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'name', type: 'string', nullable: true },
						],
						primaryKey: 'id',
					}),
				],
			]);

			const result = verify(schemaModel, dbModel);

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
			const schemaModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'name', type: 'string', nullable: true },
						],
						primaryKey: 'id',
					}),
				],
			]);

			const dbModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'name', type: 'string', nullable: true },
							{ name: 'avatar', type: 'text', nullable: true },
						],
						primaryKey: 'id',
					}),
				],
			]);

			const result = verify(schemaModel, dbModel);

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
			const schemaModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'age', type: 'integer', nullable: true },
						],
						primaryKey: 'id',
					}),
				],
			]);

			const dbModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'age', type: 'text', nullable: true },
						],
						primaryKey: 'id',
					}),
				],
			]);

			const result = verify(schemaModel, dbModel);

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
			const schemaModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'email', type: 'string', nullable: false },
						],
						primaryKey: 'id',
					}),
				],
			]);

			const dbModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'email', type: 'string', nullable: true },
						],
						primaryKey: 'id',
					}),
				],
			]);

			const result = verify(schemaModel, dbModel);

			expect(result.issues).toContainEqual(
				expect.objectContaining({
					severity: 'warning',
					type: 'nullable_mismatch',
					table: 'users',
					column: 'email',
				}),
			);
		});

		it('should classify unique mismatch as a warning', () => {
			const schemaModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{
								name: 'email',
								type: 'string',
								nullable: false,
								unique: true,
							},
						],
						primaryKey: 'id',
					}),
				],
			]);

			const dbModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'email', type: 'string', nullable: false },
						],
						primaryKey: 'id',
					}),
				],
			]);

			const result = verify(schemaModel, dbModel);

			expect(result.diff.changes).toContainEqual(
				expect.objectContaining({
					kind: 'alter_column_unique',
					table: 'users',
					column: 'email',
				}),
			);
			expect(result.issues).toContainEqual(
				expect.objectContaining({
					severity: 'warning',
					type: 'unique_mismatch',
					table: 'users',
					column: 'email',
				}),
			);
		});
	});

	describe('foreign key drift', () => {
		it('should detect missing FK in database', () => {
			const schemaModel = makeModel([
				[
					'posts',
					makeTable({
						name: 'posts',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'user_id', type: 'uuid', nullable: false },
						],
						primaryKey: 'id',
						foreignKeys: [
							{
								columns: ['user_id'],
								references: { table: 'users', columns: ['id'] },
								onDelete: 'CASCADE',
							},
						],
					}),
				],
			]);

			const dbModel = makeModel([
				[
					'posts',
					makeTable({
						name: 'posts',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'user_id', type: 'uuid', nullable: false },
						],
						primaryKey: 'id',
						foreignKeys: [],
					}),
				],
			]);

			const result = verify(schemaModel, dbModel);

			expect(result.valid).toBe(false);
			expect(result.issues).toContainEqual(
				expect.objectContaining({
					severity: 'error',
					type: 'missing_fk_in_db',
					table: 'posts',
				}),
			);
		});

		it('should detect FK onDelete mismatch', () => {
			const fkBase = {
				columns: ['user_id'],
				references: { table: 'users', columns: ['id'] },
			};

			const schemaModel = makeModel([
				[
					'posts',
					makeTable({
						name: 'posts',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'user_id', type: 'uuid', nullable: false },
						],
						primaryKey: 'id',
						foreignKeys: [{ ...fkBase, onDelete: 'CASCADE' }],
					}),
				],
			]);

			const dbModel = makeModel([
				[
					'posts',
					makeTable({
						name: 'posts',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'user_id', type: 'uuid', nullable: false },
						],
						primaryKey: 'id',
						foreignKeys: [{ ...fkBase, onDelete: 'NO ACTION' }],
					}),
				],
			]);

			const result = verify(schemaModel, dbModel);

			expect(result.issues).toContainEqual(
				expect.objectContaining({
					type: 'fk_on_delete_mismatch',
					table: 'posts',
				}),
			);
		});
	});

	describe('index drift', () => {
		it('should detect missing index in database', () => {
			const schemaModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'email', type: 'string', nullable: false },
						],
						primaryKey: 'id',
						indexes: [
							{ name: 'idx_users_email', columns: ['email'], unique: true },
						],
					}),
				],
			]);

			const dbModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'email', type: 'string', nullable: false },
						],
						primaryKey: 'id',
						indexes: [],
					}),
				],
			]);

			const result = verify(schemaModel, dbModel);

			expect(result.issues).toContainEqual(
				expect.objectContaining({
					type: 'missing_index_in_db',
					table: 'users',
				}),
			);
		});

		it('should detect extra index in database', () => {
			const schemaModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [{ name: 'id', type: 'uuid', nullable: false }],
						primaryKey: 'id',
						indexes: [],
					}),
				],
			]);

			const dbModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [{ name: 'id', type: 'uuid', nullable: false }],
						primaryKey: 'id',
						indexes: [{ name: 'idx_old', columns: ['id'], unique: false }],
					}),
				],
			]);

			const result = verify(schemaModel, dbModel);

			expect(result.issues).toContainEqual(
				expect.objectContaining({
					severity: 'info',
					type: 'missing_index_in_schema',
					table: 'users',
				}),
			);
		});
	});

	describe('default drift', () => {
		it('should detect default value mismatch', () => {
			const schemaModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{
								name: 'role',
								type: 'string',
								nullable: false,
								default: 'user',
							},
						],
						primaryKey: 'id',
					}),
				],
			]);

			const dbModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{
								name: 'role',
								type: 'string',
								nullable: false,
								default: 'admin',
							},
						],
						primaryKey: 'id',
					}),
				],
			]);

			const result = verify(schemaModel, dbModel);

			expect(result.issues).toContainEqual(
				expect.objectContaining({
					severity: 'warning',
					type: 'default_mismatch',
					table: 'users',
					column: 'role',
				}),
			);
		});
	});

	describe('primary key drift', () => {
		it('should detect PK change', () => {
			const schemaModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'email', type: 'string', nullable: false },
						],
						primaryKey: ['id', 'email'],
					}),
				],
			]);

			const dbModel = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'email', type: 'string', nullable: false },
						],
						primaryKey: 'id',
					}),
				],
			]);

			const result = verify(schemaModel, dbModel);

			expect(result.valid).toBe(false);
			expect(result.issues).toContainEqual(
				expect.objectContaining({
					type: 'primary_key_mismatch',
				}),
			);
		});
	});

	describe('result metadata', () => {
		it('should include diff in result', () => {
			const model = makeModel([
				[
					'users',
					makeTable({
						name: 'users',
						columns: [{ name: 'id', type: 'uuid', nullable: false }],
						primaryKey: 'id',
					}),
				],
			]);

			const result = verify(model, model);

			expect(result.diff).toBeDefined();
			expect(result.diff.changes).toEqual([]);
			expect(result.diff.hasDestructive).toBe(false);
		});

		it('should populate schemaTables and dbTables', () => {
			const schemaModel = makeModel([
				['users', makeTable({ name: 'users' })],
				['posts', makeTable({ name: 'posts' })],
			]);

			const dbModel = makeModel([
				['users', makeTable({ name: 'users' })],
				['comments', makeTable({ name: 'comments' })],
			]);

			const result = verify(schemaModel, dbModel);

			expect(result.schemaTables).toEqual(['users', 'posts']);
			expect(result.dbTables).toEqual(['users', 'comments']);
		});
	});
});

describe('formatVerifyResult', () => {
	it('should format valid result', () => {
		const result = verifyFromDiff(
			{
				changes: [],
				hasDestructive: false,
				summary: {
					tables: { added: 0, dropped: 0 },
					columns: { added: 0, dropped: 0, altered: 0 },
					indexes: { added: 0, dropped: 0 },
					constraints: { added: 0, dropped: 0, altered: 0 },
				},
			},
			['users', 'posts'],
			['users', 'posts'],
		);

		const output = formatVerifyResult(result);

		expect(output).toContain('✅ Schema matches database');
		expect(output).toContain('Tables in schema: 2');
		expect(output).toContain('Tables in database: 2');
	});

	it('should format result with errors', () => {
		const diff = compareSchemata(
			makeModel([
				['users', makeTable({ name: 'users' })],
				['posts', makeTable({ name: 'posts' })],
			]),
			makeModel([['users', makeTable({ name: 'users' })]]),
		);
		const result = verifyFromDiff(diff, ['users', 'posts'], ['users']);

		const output = formatVerifyResult(result);

		expect(output).toContain('❌ Schema drift detected');
		expect(output).toContain('1 error(s)');
	});

	it('should format result with warnings', () => {
		const diff = compareSchemata(
			makeModel([['users', makeTable({ name: 'users' })]]),
			makeModel([
				['users', makeTable({ name: 'users' })],
				['legacy', makeTable({ name: 'legacy' })],
			]),
		);
		const result = verifyFromDiff(diff, ['users'], ['users', 'legacy']);

		const output = formatVerifyResult(result);

		expect(output).toContain('✅ Schema matches database');
		expect(output).toContain('1 warning(s)');
	});
});
