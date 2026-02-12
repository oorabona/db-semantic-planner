import { ModelIRImpl } from '@dbsp/core';
import type { ColumnIR, ForeignKeyIR, IndexIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compareSchemata, type SchemaChange } from './schema-diff.js';

// ============================================================================
// Helpers
// ============================================================================

function makeTable(overrides: Partial<TableIR> & { name: string }): TableIR {
	return {
		columns: [],
		foreignKeys: [],
		indexes: [],
		...overrides,
	};
}

function makeCol(overrides: Partial<ColumnIR> & { name: string }): ColumnIR {
	return {
		type: 'string',
		nullable: false,
		...overrides,
	};
}

function makeModel(tables: TableIR[]) {
	const tableMap = new Map(tables.map((t) => [t.name, t]));
	return new ModelIRImpl(tableMap, new Map());
}

function changeKinds(changes: readonly SchemaChange[]) {
	return changes.map((c) => c.kind);
}

// ============================================================================
// Tests
// ============================================================================

describe('compareSchemata', () => {
	describe('table-level changes', () => {
		it('should detect new tables', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
			]);
			const db = makeModel([]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('create_table');
			expect(diff.changes[0]!.table).toBe('users');
			expect(diff.changes[0]!.destructive).toBe(false);
			expect(diff.summary.tables.added).toBe(1);
		});

		it('should detect dropped tables', () => {
			const schema = makeModel([]);
			const db = makeModel([
				makeTable({
					name: 'legacy',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('drop_table');
			expect(diff.changes[0]!.table).toBe('legacy');
			expect(diff.changes[0]!.destructive).toBe(true);
			expect(diff.hasDestructive).toBe(true);
			expect(diff.summary.tables.dropped).toBe(1);
		});

		it('should produce no changes for identical schemas', () => {
			const table = makeTable({
				name: 'users',
				columns: [makeCol({ name: 'id', type: 'integer' })],
				primaryKey: 'id',
			});
			const schema = makeModel([table]);
			const db = makeModel([table]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(0);
			expect(diff.hasDestructive).toBe(false);
		});
	});

	describe('column-level changes', () => {
		it('should detect added columns', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'email', type: 'string' }),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('add_column');
			expect(diff.changes[0]!.column).toBe('email');
			expect(diff.summary.columns.added).toBe(1);
		});

		it('should detect dropped columns', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'legacy_col', type: 'string' }),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('drop_column');
			expect(diff.changes[0]!.destructive).toBe(true);
		});

		it('should detect type changes', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'age', type: 'integer' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'age', type: 'string' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('alter_column_type');
			expect(diff.changes[0]!.destructive).toBe(true);
		});

		it('should detect nullable changes', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'email', type: 'string', nullable: true })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'email', type: 'string', nullable: false }),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('alter_column_nullable');
			expect(diff.changes[0]!.destructive).toBe(false);
		});

		it('should detect default changes', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'active', type: 'boolean', default: true }),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'active', type: 'boolean', default: false }),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('alter_column_default');
		});

		it('should not flag identical defaults', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'active', type: 'boolean', default: true }),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'active', type: 'boolean', default: true }),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);
			expect(diff.changes).toHaveLength(0);
		});
	});

	describe('primary key changes', () => {
		it('should detect added PK', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
					primaryKey: 'id',
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('add_primary_key');
		});

		it('should detect dropped PK', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
					primaryKey: 'id',
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('drop_primary_key');
			expect(diff.changes[0]!.destructive).toBe(true);
		});

		it('should detect PK column change (drop+add)', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'uuid', type: 'uuid' }),
					],
					primaryKey: 'uuid',
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'uuid', type: 'uuid' }),
					],
					primaryKey: 'id',
				}),
			]);

			const diff = compareSchemata(schema, db);

			const kinds = changeKinds(diff.changes);
			expect(kinds).toContain('drop_primary_key');
			expect(kinds).toContain('add_primary_key');
		});

		it('should handle composite PK', () => {
			const schema = makeModel([
				makeTable({
					name: 'order_items',
					columns: [
						makeCol({ name: 'order_id', type: 'integer' }),
						makeCol({ name: 'product_id', type: 'integer' }),
					],
					primaryKey: ['order_id', 'product_id'],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'order_items',
					columns: [
						makeCol({ name: 'order_id', type: 'integer' }),
						makeCol({ name: 'product_id', type: 'integer' }),
					],
					primaryKey: ['order_id', 'product_id'],
				}),
			]);

			const diff = compareSchemata(schema, db);
			expect(diff.changes).toHaveLength(0);
		});
	});

	describe('foreign key changes', () => {
		const usersFk: ForeignKeyIR = {
			columns: ['author_id'],
			references: { table: 'users', columns: ['id'] },
			onDelete: 'CASCADE',
		};

		it('should detect added FK', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'posts',
					columns: [makeCol({ name: 'author_id', type: 'integer' })],
					foreignKeys: [usersFk],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'posts',
					columns: [makeCol({ name: 'author_id', type: 'integer' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('add_foreign_key');
			expect(diff.summary.constraints.added).toBe(1);
		});

		it('should detect dropped FK', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'posts',
					columns: [makeCol({ name: 'author_id', type: 'integer' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'posts',
					columns: [makeCol({ name: 'author_id', type: 'integer' })],
					foreignKeys: [usersFk],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('drop_foreign_key');
			expect(diff.changes[0]!.destructive).toBe(true);
		});

		it('should detect onDelete change', () => {
			const fkSetNull: ForeignKeyIR = { ...usersFk, onDelete: 'SET NULL' };

			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'posts',
					columns: [makeCol({ name: 'author_id', type: 'integer' })],
					foreignKeys: [usersFk],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'posts',
					columns: [makeCol({ name: 'author_id', type: 'integer' })],
					foreignKeys: [fkSetNull],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('alter_foreign_key');
			expect(diff.summary.constraints.altered).toBe(1);
		});
	});

	describe('index changes', () => {
		const emailIdx: IndexIR = {
			name: 'idx_users_email',
			columns: ['email'],
			unique: true,
		};

		it('should detect new index', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'email', type: 'string' })],
					indexes: [emailIdx],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'email', type: 'string' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('create_index');
			expect(diff.summary.indexes.added).toBe(1);
		});

		it('should detect dropped index', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'email', type: 'string' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'email', type: 'string' })],
					indexes: [emailIdx],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('drop_index');
		});

		it('should match indexes by columns+unique, not name', () => {
			const schemaIdx: IndexIR = {
				name: 'new_name',
				columns: ['email'],
				unique: true,
			};

			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'email', type: 'string' })],
					indexes: [schemaIdx],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'email', type: 'string' })],
					indexes: [emailIdx],
				}),
			]);

			// Same columns, same unique → no change (names differ but that's cosmetic)
			const diff = compareSchemata(schema, db);
			expect(diff.changes).toHaveLength(0);
		});
	});

	describe('complex scenarios', () => {
		it('should handle multiple changes across tables', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'email', type: 'string' }),
					],
					primaryKey: 'id',
				}),
				makeTable({
					name: 'orders',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'user_id', type: 'integer' }),
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
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
					primaryKey: 'id',
				}),
			]);

			const diff = compareSchemata(schema, db);

			const kinds = changeKinds(diff.changes);
			// orders is new table, email is new column
			expect(kinds).toContain('create_table');
			expect(kinds).toContain('add_column');
			expect(diff.summary.tables.added).toBe(1);
			expect(diff.summary.columns.added).toBe(1);
		});

		it('should correctly set hasDestructive', () => {
			// No destructive changes
			const schema1 = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'id', type: 'integer' }),
						makeCol({ name: 'new_col', type: 'string' }),
					],
				}),
			]);
			const db1 = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
			]);

			expect(compareSchemata(schema1, db1).hasDestructive).toBe(false);

			// With destructive changes
			const schema2 = makeModel([]);
			const db2 = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
			]);

			expect(compareSchemata(schema2, db2).hasDestructive).toBe(true);
		});
	});
});
