
/**
 * BATCH-INSERT-NULLABLE-INT: Schema-driven array type inference for nullable integer columns.
 *
 * Root cause: getColumnTypes() previously filtered to RANGE_TYPES only, so nullable integer
 * columns had no entry in the columnTypes map. When all batch values for such a column were
 * NULL, sampleValue was undefined → inferPgArrayType() defaulted to text[] → PostgreSQL
 * error: "column X is of type integer but expression is of type text".
 *
 * Fix: getColumnTypes() now covers ALL column types; mapToPgBaseType() handles ColumnType
 * aliases (e.g. 'integer' → int4, 'string' → text, 'datetime' → timestamptz).
 */

import type { ModelIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Test schema: variable_uses table with nullable integer FK
// ---------------------------------------------------------------------------

function buildModel(): ModelIR {
	const columns = [
		{ name: 'id', type: 'integer' as const, nullable: false },
		{ name: 'symbol_id', type: 'integer' as const, nullable: false },
		{ name: 'enclosing_symbol_id', type: 'integer' as const, nullable: true },
	];

	const table = {
		name: 'variable_uses',
		columns,
		relations: [],
		indexes: [],
		rlsEnabled: false,
		policies: [],
	} as unknown as TableIR;

	const tables = new Map([['variable_uses', table]]);

	return {
		tables,
		relations: new Map(),
		getTable: (name: string) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false }),
	} as unknown as ModelIR;
}

function buildModelWithOriginalDbType(): ModelIR {
	const columns = [
		{
			name: 'id',
			type: 'integer' as const,
			nullable: false,
			originalDbType: 'integer',
		},
		{
			name: 'symbol_id',
			type: 'integer' as const,
			nullable: false,
			originalDbType: 'integer',
		},
		{
			name: 'enclosing_symbol_id',
			type: 'integer' as const,
			nullable: true,
			originalDbType: 'integer',
		},
	];

	const table = {
		name: 'variable_uses',
		columns,
		relations: [],
		indexes: [],
		rlsEnabled: false,
		policies: [],
	} as unknown as TableIR;

	const tables = new Map([['variable_uses', table]]);

	return {
		tables,
		relations: new Map(),
		getTable: (name: string) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false }),
	} as unknown as ModelIR;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Force unnest strategy by setting batchThreshold=0 */
const UNNEST_OPTIONS = { batchThreshold: 0 } as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BATCH-INSERT-NULLABLE-INT: schema-driven int4[] for nullable integer columns', () => {
	it('uses int4[] (not text[]) when enclosing_symbol_id has mixed null/non-null values', () => {
		const model = buildModel();
		const adapter = createPgsqlCompileOnlyAdapter({ model });

		const intent = {
			type: 'insert' as const,
			table: 'variable_uses',
			values: [
				{ id: 1, symbol_id: 10, enclosing_symbol_id: 100 },
				{ id: 2, symbol_id: 11, enclosing_symbol_id: null },
				{ id: 3, symbol_id: 12, enclosing_symbol_id: 200 },
			],
		};

		const { sql } = adapter.compileInsert(intent, UNNEST_OPTIONS);

		expect(sql).toContain('int4[]');
		expect(sql).not.toContain('text[]');
	});

	it('uses int4[] (not text[]) when enclosing_symbol_id is ALL null (schema-driven, not sample-driven)', () => {
		const model = buildModel();
		const adapter = createPgsqlCompileOnlyAdapter({ model });

		const intent = {
			type: 'insert' as const,
			table: 'variable_uses',
			values: [
				{ id: 1, symbol_id: 10, enclosing_symbol_id: null },
				{ id: 2, symbol_id: 11, enclosing_symbol_id: null },
				{ id: 3, symbol_id: 12, enclosing_symbol_id: null },
			],
		};

		const { sql } = adapter.compileInsert(intent, UNNEST_OPTIONS);

		// Without the fix, sampleValue=undefined → text[]. With fix, schema → int4[].
		expect(sql).toContain('int4[]');
		expect(sql).not.toContain('text[]');
	});

	it('uses int4[] for non-nullable integer column (regression guard)', () => {
		const model = buildModel();
		const adapter = createPgsqlCompileOnlyAdapter({ model });

		const intent = {
			type: 'insert' as const,
			table: 'variable_uses',
			values: [
				{ id: 1, symbol_id: 10, enclosing_symbol_id: 100 },
				{ id: 2, symbol_id: 11, enclosing_symbol_id: 101 },
			],
		};

		const { sql } = adapter.compileInsert(intent, UNNEST_OPTIONS);

		// symbol_id is NOT NULL integer — should also use int4[] (not text[])
		expect(sql).toContain('int4[]');
		expect(sql).not.toContain('text[]');
	});

	it('prefers originalDbType over ColumnType when both are set', () => {
		const model = buildModelWithOriginalDbType();
		const adapter = createPgsqlCompileOnlyAdapter({ model });

		const intent = {
			type: 'insert' as const,
			table: 'variable_uses',
			values: [
				{ id: 1, symbol_id: 10, enclosing_symbol_id: null },
				{ id: 2, symbol_id: 11, enclosing_symbol_id: null },
			],
		};

		const { sql } = adapter.compileInsert(intent, UNNEST_OPTIONS);

		// originalDbType='integer' → mapToPgBaseType('integer') → int4
		expect(sql).toContain('int4[]');
		expect(sql).not.toContain('text[]');
	});
});
