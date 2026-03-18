/**
 * Schema Diff — Error Paths & Edge Cases
 *
 * Covers uncovered branches in schema-diff.ts that the happy-path
 * test file (schema-diff.test.ts) does not exercise:
 *   - normalizeDefault with SQL expression objects
 *   - Default presence/absence asymmetry
 *   - FK onDelete defaulting to NO ACTION
 *   - alter_foreign_key when onDelete differs
 *   - Index without name (fallback formatting)
 *   - Column type change with originalDbType
 */

import { ModelIRImpl } from '@dbsp/core';
import type { ColumnIR, ForeignKeyIR, IndexIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compareSchemata, type SchemaChange } from './schema-diff.js';

// ============================================================================
// Helpers (mirrored from schema-diff.test.ts)
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

function findChange(
	changes: readonly SchemaChange[],
	kind: SchemaChange['kind'],
	column?: string,
): SchemaChange | undefined {
	return changes.find(
		(c) => c.kind === kind && (column === undefined || c.column === column),
	);
}

// ============================================================================
// Tests
// ============================================================================

describe('compareSchemata — edge cases', () => {
	// --------------------------------------------------------------------------
	// normalizeDefault with SQL expression object (line 226)
	// --------------------------------------------------------------------------
	describe('normalizeDefault with { sql } expression objects', () => {
		it('should treat { sql: "NOW()" } as equivalent to string "NOW()"', () => {
			const schema = makeModel([
				makeTable({
					name: 'events',
					columns: [
						makeCol({
							name: 'created_at',
							type: 'datetime',
							default: { sql: 'NOW()' },
						}),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'events',
					columns: [
						makeCol({
							name: 'created_at',
							type: 'datetime',
							default: 'NOW()',
						}),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			// Both normalize to "NOW()" — no change expected
			expect(diff.changes).toHaveLength(0);
		});

		it('should detect difference when { sql } value differs from db string', () => {
			const schema = makeModel([
				makeTable({
					name: 'events',
					columns: [
						makeCol({
							name: 'created_at',
							type: 'datetime',
							default: { sql: 'CURRENT_TIMESTAMP' },
						}),
					],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'events',
					columns: [
						makeCol({
							name: 'created_at',
							type: 'datetime',
							default: 'NOW()',
						}),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0]!.kind).toBe('alter_column_default');
		});
	});

	// --------------------------------------------------------------------------
	// Default comparison edge cases (line 214)
	// --------------------------------------------------------------------------
	describe('default presence/absence asymmetry', () => {
		it('should detect change when schema has default but db does not', () => {
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
					columns: [makeCol({ name: 'active', type: 'boolean' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			const change = findChange(diff.changes, 'alter_column_default', 'active');
			expect(change).toBeDefined();
			expect(change!.details).toContain('from none to true');
		});

		it('should detect change when db has default but schema does not', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'active', type: 'boolean' })],
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

			const change = findChange(diff.changes, 'alter_column_default', 'active');
			expect(change).toBeDefined();
			expect(change!.details).toContain('from false to none');
		});

		it('should produce no change when both have undefined default', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'name', type: 'string' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'name', type: 'string' })],
				}),
			]);

			const diff = compareSchemata(schema, db);
			expect(diff.changes).toHaveLength(0);
		});

		it('should produce no change when both have null default', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'name', type: 'string', default: null })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'name', type: 'string', default: null })],
				}),
			]);

			const diff = compareSchemata(schema, db);
			expect(diff.changes).toHaveLength(0);
		});

		it('should treat null and undefined defaults as equivalent (both normalize to undefined)', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'name', type: 'string', default: null })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'name', type: 'string' })],
				}),
			]);

			const diff = compareSchemata(schema, db);
			expect(diff.changes).toHaveLength(0);
		});
	});

	// --------------------------------------------------------------------------
	// FK alter_foreign_key when onDelete differs (lines 324-326)
	// --------------------------------------------------------------------------
	describe('FK onDelete edge cases', () => {
		const baseFk: ForeignKeyIR = {
			columns: ['user_id'],
			references: { table: 'users', columns: ['id'] },
		};

		it('should produce alter_foreign_key when schema has CASCADE and db has no onDelete (defaults to NO ACTION)', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'orders',
					columns: [makeCol({ name: 'user_id', type: 'integer' })],
					foreignKeys: [{ ...baseFk, onDelete: 'CASCADE' }],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'orders',
					columns: [makeCol({ name: 'user_id', type: 'integer' })],
					foreignKeys: [baseFk], // no onDelete → defaults to NO ACTION
				}),
			]);

			const diff = compareSchemata(schema, db);

			const change = findChange(diff.changes, 'alter_foreign_key');
			expect(change).toBeDefined();
			expect(change!.details).toContain('onDelete/onUpdate/deferred changed');
			expect(change!.meta).toEqual(
				expect.objectContaining({ previousOnDelete: 'NO ACTION' }),
			);
			expect(diff.summary.constraints.altered).toBe(1);
		});

		it('should produce no change when both FKs have no onDelete (both default to NO ACTION)', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'orders',
					columns: [makeCol({ name: 'user_id', type: 'integer' })],
					foreignKeys: [baseFk],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'orders',
					columns: [makeCol({ name: 'user_id', type: 'integer' })],
					foreignKeys: [baseFk],
				}),
			]);

			const diff = compareSchemata(schema, db);
			expect(diff.changes).toHaveLength(0);
		});

		it('should produce alter_foreign_key when schema has RESTRICT and db has SET NULL', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'orders',
					columns: [makeCol({ name: 'user_id', type: 'integer' })],
					foreignKeys: [{ ...baseFk, onDelete: 'RESTRICT' }],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'orders',
					columns: [makeCol({ name: 'user_id', type: 'integer' })],
					foreignKeys: [{ ...baseFk, onDelete: 'SET NULL' }],
				}),
			]);

			const diff = compareSchemata(schema, db);

			const change = findChange(diff.changes, 'alter_foreign_key');
			expect(change).toBeDefined();
			expect(change!.details).toContain('onDelete/onUpdate/deferred changed');
		});

		it('should produce no change when schema has NO ACTION explicitly and db has no onDelete', () => {
			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'orders',
					columns: [makeCol({ name: 'user_id', type: 'integer' })],
					foreignKeys: [{ ...baseFk, onDelete: 'NO ACTION' }],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [makeCol({ name: 'id', type: 'integer' })],
				}),
				makeTable({
					name: 'orders',
					columns: [makeCol({ name: 'user_id', type: 'integer' })],
					foreignKeys: [baseFk],
				}),
			]);

			const diff = compareSchemata(schema, db);
			expect(diff.changes).toHaveLength(0);
		});
	});

	// --------------------------------------------------------------------------
	// Index without name (lines 378, 391)
	// --------------------------------------------------------------------------
	describe('index without name', () => {
		it('should use "on (columns)" format in create_index details when name is undefined', () => {
			const namelessIdx: IndexIR = {
				columns: ['email', 'tenant_id'],
				unique: false,
			};

			const schema = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'email', type: 'string' }),
						makeCol({ name: 'tenant_id', type: 'integer' }),
					],
					indexes: [namelessIdx],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'users',
					columns: [
						makeCol({ name: 'email', type: 'string' }),
						makeCol({ name: 'tenant_id', type: 'integer' }),
					],
				}),
			]);

			const diff = compareSchemata(schema, db);

			const change = findChange(diff.changes, 'create_index');
			expect(change).toBeDefined();
			expect(change!.details).toBe('Create index on (email, tenant_id)');
		});

		it('should use "on (columns)" format in drop_index details when name is undefined', () => {
			const namelessIdx: IndexIR = {
				columns: ['status'],
				unique: false,
			};

			const schema = makeModel([
				makeTable({
					name: 'orders',
					columns: [makeCol({ name: 'status', type: 'string' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'orders',
					columns: [makeCol({ name: 'status', type: 'string' })],
					indexes: [namelessIdx],
				}),
			]);

			const diff = compareSchemata(schema, db);

			const change = findChange(diff.changes, 'drop_index');
			expect(change).toBeDefined();
			expect(change!.details).toBe('Drop index on (status)');
		});

		it('should use index name in drop_index details when name is present', () => {
			const namedIdx: IndexIR = {
				name: 'idx_orders_status',
				columns: ['status'],
				unique: false,
			};

			const schema = makeModel([
				makeTable({
					name: 'orders',
					columns: [makeCol({ name: 'status', type: 'string' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'orders',
					columns: [makeCol({ name: 'status', type: 'string' })],
					indexes: [namedIdx],
				}),
			]);

			const diff = compareSchemata(schema, db);

			const change = findChange(diff.changes, 'drop_index');
			expect(change).toBeDefined();
			expect(change!.details).toBe('Drop index idx_orders_status');
		});
	});

	// --------------------------------------------------------------------------
	// Column type change detection
	// --------------------------------------------------------------------------
	describe('column type change detection', () => {
		it('should detect type change from text to string', () => {
			const schema = makeModel([
				makeTable({
					name: 'posts',
					columns: [makeCol({ name: 'body', type: 'text' })],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'posts',
					columns: [makeCol({ name: 'body', type: 'string' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			const change = findChange(diff.changes, 'alter_column_type', 'body');
			expect(change).toBeDefined();
			expect(change!.destructive).toBe(true);
			expect(change!.details).toBe('Change type of "body" from string to text');
			expect(change!.meta).toEqual(
				expect.objectContaining({
					fromType: 'string',
					toType: 'text',
				}),
			);
		});

		it('should include column schema in meta for type change', () => {
			const schemaCol = makeCol({
				name: 'amount',
				type: 'number',
				originalDbType: 'numeric(10,2)',
			});

			const schema = makeModel([
				makeTable({
					name: 'payments',
					columns: [schemaCol],
				}),
			]);
			const db = makeModel([
				makeTable({
					name: 'payments',
					columns: [makeCol({ name: 'amount', type: 'integer' })],
				}),
			]);

			const diff = compareSchemata(schema, db);

			const change = findChange(diff.changes, 'alter_column_type', 'amount');
			expect(change).toBeDefined();
			expect(change!.meta).toEqual(
				expect.objectContaining({
					fromType: 'integer',
					toType: 'number',
					column: schemaCol,
				}),
			);
		});
	});
});
