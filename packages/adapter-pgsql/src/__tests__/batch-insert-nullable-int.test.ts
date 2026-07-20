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

function buildSingleTableModel(table: TableIR): ModelIR {
	const tables = new Map([[table.name, table]]);

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

	it('keeps target schema verbatim for target-scoped custom batch casts', () => {
		const columns = [
			{
				name: 'state',
				type: 'string' as const,
				nullable: false,
				originalDbType: 'status',
				originalDbTypeSchema: 'tenant_one',
				originalDbTypeSchemaScope: 'target' as const,
			},
		];
		const table = {
			name: 'events',
			columns,
			relations: [],
			indexes: [],
			rlsEnabled: false,
			policies: [],
		} as unknown as TableIR;
		const tables = new Map([['events', table]]);
		const model = {
			tables,
			relations: new Map(),
			getTable: (name: string) => tables.get(name),
			getRelation: () => undefined,
			getRelationsFrom: () => [],
			getRelationsTo: () => [],
			isAmbiguous: () => ({ ambiguous: false }),
		} as unknown as ModelIR;
		const adapter = createPgsqlCompileOnlyAdapter({
			model,
			schemaName: 'tenantOne',
			dbCasing: 'snake_case',
		});

		const result = adapter.compileInsert(
			{
				type: 'insert' as const,
				table: 'events',
				values: [{ state: 'active' }],
			},
			UNNEST_OPTIONS,
		);

		expect({ sql: result.sql, parameters: result.parameters }).toEqual({
			sql: 'INSERT INTO "tenantOne".events (state) SELECT unnest(CAST($1 AS "tenantOne".status[])) AS state',
			parameters: [['active']],
		});
	});

	it('routes originalDbType through cast-safe batch array targets', () => {
		const table = {
			name: 'flags',
			columns: [
				{
					name: 'bits',
					type: 'string',
					nullable: false,
					originalDbType: 'bit(8)',
				},
			],
			relations: [],
			indexes: [],
			rlsEnabled: false,
			policies: [],
		} as unknown as TableIR;
		const tables = new Map([['flags', table]]);
		const model = {
			tables,
			relations: new Map(),
			getTable: (name: string) => tables.get(name),
			getRelation: () => undefined,
			getRelationsFrom: () => [],
			getRelationsTo: () => [],
			isAmbiguous: () => ({ ambiguous: false }),
		} as unknown as ModelIR;
		const adapter = createPgsqlCompileOnlyAdapter({ model });

		const result = adapter.compileInsert(
			{
				type: 'insert',
				table: 'flags',
				values: [{ bits: '10101010' }, { bits: '11110000' }],
			},
			UNNEST_OPTIONS,
		);

		expect(result.sql).toBe(
			'INSERT INTO flags (bits) SELECT unnest(CAST($1 AS bit varying[])) AS bits',
		);
		expect(result.parameters).toEqual([['10101010', '11110000']]);
		expect(result.columnMetadata?.size).toBe(0);
	});

	it('casts numeric originalDbType as numeric[] without precision loss', () => {
		const table = {
			name: 'invoices',
			columns: [
				{
					name: 'amount',
					type: 'decimal',
					nullable: false,
					originalDbType: 'numeric(10,2)',
				},
			],
			relations: [],
			indexes: [],
			rlsEnabled: false,
			policies: [],
		} as unknown as TableIR;
		const adapter = createPgsqlCompileOnlyAdapter({
			model: buildSingleTableModel(table),
		});

		const result = adapter.compileInsert(
			{
				type: 'insert',
				table: 'invoices',
				values: [{ amount: '10.25' }, { amount: '20.50' }],
			},
			UNNEST_OPTIONS,
		);

		expect(result.sql).toBe(
			'INSERT INTO invoices (amount) SELECT unnest(CAST($1 AS numeric[])) AS amount',
		);
		expect(result.parameters).toEqual([['10.25', '20.50']]);
		expect(result.columnMetadata?.size).toBe(0);
	});

	it('compiles faithful adapter DB types in batch insert casts', () => {
		const table = {
			name: 'places',
			columns: [
				{
					name: 'shape',
					type: 'string',
					nullable: false,
					originalDbType: 'geometry(Point,4326)',
				},
				{
					name: 'label',
					type: 'string',
					nullable: false,
					originalDbType: '"LabelType"',
				},
				{
					name: 'duration',
					type: 'string',
					nullable: false,
					originalDbType: 'interval day to second(3)',
				},
			],
			relations: [],
			indexes: [],
			rlsEnabled: false,
			policies: [],
		} as unknown as TableIR;
		const adapter = createPgsqlCompileOnlyAdapter({
			model: buildSingleTableModel(table),
		});

		const result = adapter.compileInsert(
			{
				type: 'insert',
				table: 'places',
				values: [
					{
						shape: 'POINT(1 2)',
						label: 'home',
						duration: '1 day 02:03:04',
					},
					{
						shape: 'POINT(3 4)',
						label: 'work',
						duration: '2 days 03:04:05',
					},
				],
			},
			UNNEST_OPTIONS,
		);

		expect(result.sql).toBe(
			'INSERT INTO places (shape, label, duration) SELECT unnest(CAST($1 AS geometry(Point,4326)[])) AS shape, unnest(CAST($2 AS "LabelType"[])) AS label, unnest(CAST($3 AS interval day to second[])) AS duration',
		);
		expect(result.parameters).toEqual([
			['POINT(1 2)', 'POINT(3 4)'],
			['home', 'work'],
			['1 day 02:03:04', '2 days 03:04:05'],
		]);
		expect(result.columnMetadata?.size).toBe(0);
	});

	it('fails loud on batch insert into an array-typed column (unnest cannot express it)', () => {
		const table = {
			name: 'events',
			columns: [
				{
					name: 'id',
					type: 'integer',
					nullable: false,
					originalDbType: 'int4',
				},
				{
					name: 'tags',
					type: 'string',
					nullable: false,
					// unnest flattens a multi-dimensional array, so an array column
					// cannot be batch-inserted via the unnest path.
					originalDbType: 'integer[]',
				},
			],
			relations: [],
			indexes: [],
			rlsEnabled: false,
			policies: [],
		} as unknown as TableIR;
		const adapter = createPgsqlCompileOnlyAdapter({
			model: buildSingleTableModel(table),
		});

		expect(() =>
			adapter.compileInsert(
				{
					type: 'insert',
					table: 'events',
					values: [
						{ id: 1, tags: [10, 20] },
						{ id: 2, tags: [30, 40] },
					],
				},
				UNNEST_OPTIONS,
			),
		).toThrow(/array-typed column 'tags'.*not supported/);
	});

	it('quotes case-sensitive UDT names in batch insert casts', () => {
		const table = {
			name: 'payments',
			columns: [
				{
					name: 'amount',
					type: 'decimal',
					nullable: false,
					// Introspection stores a case-sensitive custom type quoted.
					originalDbType: '"Money"',
				},
			],
			relations: [],
			indexes: [],
			rlsEnabled: false,
			policies: [],
		} as unknown as TableIR;
		const adapter = createPgsqlCompileOnlyAdapter({
			model: buildSingleTableModel(table),
		});

		const result = adapter.compileInsert(
			{
				type: 'insert',
				table: 'payments',
				values: [{ amount: '10.25' }, { amount: '20.50' }],
			},
			UNNEST_OPTIONS,
		);

		expect(result.sql).toBe(
			'INSERT INTO payments (amount) SELECT unnest(CAST($1 AS "Money"[])) AS amount',
		);
		expect(result.parameters).toEqual([['10.25', '20.50']]);
		expect(result.columnMetadata?.size).toBe(0);
	});
});
