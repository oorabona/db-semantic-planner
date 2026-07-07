/**
 * PARAM-TYPE-CAST: Explicit parameter type casting in WHERE comparisons.
 *
 * When originalDbType is set on a column (populated by introspection), WHERE
 * comparisons emit CAST($N AS type) to eliminate PostgreSQL type inference
 * ambiguity for nullable columns.
 *
 * Regression: pg driver sends parameters without explicit type OIDs; PostgreSQL
 * may infer $1 as text instead of integer for nullable columns, causing runtime errors.
 */

import type { ModelIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

type ColumnDef = {
	name: string;
	type: string;
	nullable?: boolean;
	originalDbType?: string;
};

function buildModel(tableName: string, columns: ColumnDef[]): ModelIR {
	const tableColumns = columns.map((c) => ({
		name: c.name,
		type: c.type,
		nullable: c.nullable ?? false,
		...(c.originalDbType !== undefined && { originalDbType: c.originalDbType }),
	}));
	const table = {
		name: tableName,
		columns: tableColumns,
		relations: [],
		indexes: [],
		rlsEnabled: false,
		policies: [],
	} as unknown as TableIR;
	const tables = new Map([[tableName, table]]);
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

function compileSelect(
	tableName: string,
	columns: ColumnDef[],
	whereColumn: string,
	whereValue: unknown,
	operator = '=',
): { sql: string; parameters: readonly unknown[] } {
	const model = buildModel(tableName, columns);
	const adapter = createPgsqlCompileOnlyAdapter({ model });
	return adapter.compile({
		rootTable: tableName,
		decisions: [
			{ type: 'select', column: '*' },
			{
				type: 'where',
				column: whereColumn,
				operator,
				value: whereValue,
			},
		],
	} as Parameters<typeof adapter.compile>[0]);
}

describe('PARAM-TYPE-CAST: comparison handler emits CAST when originalDbType set', () => {
	it('casts integer column via originalDbType', () => {
		const { sql, parameters } = compileSelect(
			'items',
			[
				{
					name: 'id',
					type: 'number',
					nullable: false,
					originalDbType: 'integer',
				},
			],
			'id',
			42,
		);
		// pg-deparse converts $N::type to CAST($N AS type)
		expect(sql).toContain('CAST($1 AS integer)');
		expect(parameters).toEqual([42]);
	});

	it('casts nullable integer column (primary use-case for this feature)', () => {
		const { sql, parameters } = compileSelect(
			'orders',
			[
				{
					name: 'user_id',
					type: 'number',
					nullable: true,
					originalDbType: 'integer',
				},
			],
			'user_id',
			99,
		);
		expect(sql).toContain('CAST($1 AS integer)');
		expect(parameters).toEqual([99]);
	});

	it('casts uuid column via originalDbType', () => {
		const { sql, parameters } = compileSelect(
			'sessions',
			[
				{
					name: 'user_id',
					type: 'uuid',
					nullable: true,
					originalDbType: 'uuid',
				},
			],
			'user_id',
			'abc-123',
		);
		expect(sql).toContain('CAST($1 AS uuid)');
		expect(parameters).toEqual(['abc-123']);
	});

	it('casts timestamptz column via originalDbType', () => {
		const date = new Date('2024-01-01');
		const { sql, parameters } = compileSelect(
			'events',
			[
				{
					name: 'created_at',
					type: 'datetime',
					nullable: true,
					originalDbType: 'timestamptz',
				},
			],
			'created_at',
			date,
		);
		expect(sql).toContain('CAST($1 AS timestamptz)');
		expect(parameters).toEqual([date]);
	});

	it('casts boolean column via originalDbType', () => {
		const { sql, parameters } = compileSelect(
			'users',
			[
				{
					name: 'active',
					type: 'boolean',
					nullable: true,
					originalDbType: 'bool',
				},
			],
			'active',
			true,
		);
		expect(sql).toContain('CAST($1 AS bool)');
		expect(parameters).toEqual([true]);
	});

	it('does NOT cast when originalDbType is absent (non-introspected schema)', () => {
		const { sql, parameters } = compileSelect(
			'items',
			[{ name: 'id', type: 'number', nullable: false }],
			'id',
			42,
		);
		expect(sql).not.toContain('CAST');
		expect(sql).toContain('$1');
		expect(parameters).toEqual([42]);
	});

	it('does NOT cast when no model is provided (backward compat)', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const { sql, parameters } = adapter.compile({
			rootTable: 'items',
			decisions: [
				{ type: 'select', column: '*' },
				{ type: 'where', column: 'id', operator: '=', value: 42 },
			],
		} as Parameters<typeof adapter.compile>[0]);
		expect(sql).not.toContain('CAST');
		expect(sql).toContain('$1');
		expect(parameters).toEqual([42]);
	});

	it('does NOT cast FieldRef comparisons (column-to-column)', () => {
		const model = buildModel('employees', [
			{ name: 'manager_id', type: 'number', originalDbType: 'integer' },
			{ name: 'id', type: 'number', originalDbType: 'integer' },
		]);
		const adapter = createPgsqlCompileOnlyAdapter({ model });
		const { sql } = adapter.compile({
			rootTable: 'employees',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'manager_id',
					operator: '=',
					value: { kind: 'fieldRef', column: 'id', scope: 'inner' },
				},
			],
		} as Parameters<typeof adapter.compile>[0]);
		expect(sql).not.toContain('$1');
		expect(sql).not.toContain('CAST');
	});

	it('casts varchar typmod columns using the base type to avoid truncation', () => {
		const { sql, parameters } = compileSelect(
			'products',
			[
				{
					name: 'name',
					type: 'string',
					nullable: true,
					originalDbType: 'varchar(8)',
				},
			],
			'name',
			'abcdefghi',
		);
		expect(sql).toContain('CAST($1 AS varchar)');
		expect(sql).not.toContain('varchar(8)');
		expect(parameters).toEqual(['abcdefghi']);
	});

	it('casts numeric typmod columns using the base type to avoid rounding', () => {
		const { sql, parameters } = compileSelect(
			'products',
			[
				{
					name: 'price',
					type: 'decimal',
					nullable: true,
					originalDbType: 'numeric(10,2)',
				},
			],
			'price',
			12.345,
		);
		expect(sql).toContain('CAST($1 AS numeric)');
		expect(sql).not.toContain('numeric(10,2)');
		expect(parameters).toEqual([12.345]);
	});

	it('casts char typmod columns as text to avoid length-1 truncation', () => {
		const { sql, parameters } = compileSelect(
			'products',
			[
				{
					name: 'code',
					type: 'string',
					nullable: true,
					originalDbType: 'char(4)',
				},
			],
			'code',
			'ABCDE',
		);
		expect(sql).toContain('CAST($1 AS text)');
		expect(sql).not.toContain('CAST($1 AS char)');
		expect(sql).not.toContain('char(4)');
		expect(parameters).toEqual(['ABCDE']);
	});

	it('casts bit typmod columns as unbounded bit varying', () => {
		const { sql, parameters } = compileSelect(
			'products',
			[
				{
					name: 'flags',
					type: 'string',
					nullable: true,
					originalDbType: 'bit(4)',
				},
			],
			'flags',
			'1010',
		);
		expect(sql).toContain('CAST($1 AS bit varying)');
		expect(sql).not.toContain('CAST($1 AS text)');
		expect(sql).not.toContain('bit(4)');
		expect(parameters).toEqual(['1010']);
	});

	it('casts varbit typmod columns as unbounded bit varying', () => {
		const { sql, parameters } = compileSelect(
			'products',
			[
				{
					name: 'flags',
					type: 'string',
					nullable: true,
					originalDbType: 'varbit(8)',
				},
			],
			'flags',
			'10101010',
		);
		expect(sql).toContain('CAST($1 AS bit varying)');
		expect(sql).not.toContain('CAST($1 AS text)');
		expect(sql).not.toContain('varbit(8)');
		expect(parameters).toEqual(['10101010']);
	});

	it('preserves temporal precision typmod columns', () => {
		const date = new Date('2024-01-01T00:00:00.123Z');
		const { sql, parameters } = compileSelect(
			'events',
			[
				{
					name: 'created_at',
					type: 'datetime',
					nullable: true,
					originalDbType: 'timestamptz(3)',
				},
			],
			'created_at',
			date,
		);
		expect(sql).toContain('CAST($1 AS timestamptz(3))');
		expect(parameters).toEqual([date]);
	});

	it('rejects malformed originalDbType before deriving a cast type', () => {
		expect(() =>
			compileSelect(
				'items',
				[
					{
						name: 'id',
						type: 'number',
						nullable: true,
						originalDbType: 'integer(foo)',
					},
				],
				'id',
				42,
			),
		).toThrow(/Unsafe database type name/);
	});
});

describe('PARAM-TYPE-CAST: IN handler emits CAST when originalDbType set', () => {
	it('casts integer IN list', () => {
		const model = buildModel('items', [
			{ name: 'status', type: 'number', originalDbType: 'integer' },
		]);
		const adapter = createPgsqlCompileOnlyAdapter({ model });
		const { sql, parameters } = adapter.compile({
			rootTable: 'items',
			decisions: [
				{ type: 'select', column: '*' },
				{ type: 'where', column: 'status', operator: 'in', value: [1, 2, 3] },
			],
		} as Parameters<typeof adapter.compile>[0]);
		expect(sql).toContain('CAST($1 AS integer[])');
		expect(parameters).toEqual([[1, 2, 3]]);
	});

	it('casts uuid IN list via originalDbType', () => {
		const model = buildModel('users', [
			{ name: 'role_id', type: 'uuid', originalDbType: 'uuid' },
		]);
		const adapter = createPgsqlCompileOnlyAdapter({ model });
		const { sql, parameters } = adapter.compile({
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'role_id',
					operator: 'in',
					value: ['aaa', 'bbb'],
				},
			],
		} as Parameters<typeof adapter.compile>[0]);
		expect(sql).toContain('CAST($1 AS uuid[])');
		expect(parameters).toEqual([['aaa', 'bbb']]);
	});

	it('casts typmod IN lists using the base array type', () => {
		const model = buildModel('products', [
			{ name: 'token', type: 'string', originalDbType: 'varchar(8)' },
		]);
		const adapter = createPgsqlCompileOnlyAdapter({ model });
		const { sql, parameters } = adapter.compile({
			rootTable: 'products',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'token',
					operator: 'in',
					value: ['abcdefghi'],
				},
			],
		} as Parameters<typeof adapter.compile>[0]);
		expect(sql).toContain('CAST($1 AS varchar[])');
		expect(sql).not.toContain('varchar(8)');
		expect(parameters).toEqual([['abcdefghi']]);
	});

	it('casts fixed-length char IN lists as text arrays', () => {
		const model = buildModel('products', [
			{ name: 'code', type: 'string', originalDbType: 'char(4)' },
		]);
		const adapter = createPgsqlCompileOnlyAdapter({ model });
		const { sql, parameters } = adapter.compile({
			rootTable: 'products',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'code',
					operator: 'in',
					value: ['ABCDE'],
				},
			],
		} as Parameters<typeof adapter.compile>[0]);
		expect(sql).toContain('CAST($1 AS text[])');
		expect(sql).not.toContain('char');
		expect(parameters).toEqual([['ABCDE']]);
	});

	it('casts bit typmod IN lists as bit varying arrays', () => {
		const model = buildModel('products', [
			{ name: 'flags', type: 'string', originalDbType: 'bit(4)' },
		]);
		const adapter = createPgsqlCompileOnlyAdapter({ model });
		const { sql, parameters } = adapter.compile({
			rootTable: 'products',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'flags',
					operator: 'in',
					value: ['1010'],
				},
			],
		} as Parameters<typeof adapter.compile>[0]);
		expect(sql).toContain('CAST($1 AS bit varying[])');
		expect(sql).not.toContain('CAST($1 AS text[])');
		expect(sql).not.toContain('bit(4)');
		expect(parameters).toEqual([['1010']]);
	});

	it('casts varbit typmod IN lists as bit varying arrays', () => {
		const model = buildModel('products', [
			{ name: 'flags', type: 'string', originalDbType: 'varbit(8)' },
		]);
		const adapter = createPgsqlCompileOnlyAdapter({ model });
		const { sql, parameters } = adapter.compile({
			rootTable: 'products',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'flags',
					operator: 'in',
					value: ['10101010'],
				},
			],
		} as Parameters<typeof adapter.compile>[0]);
		expect(sql).toContain('CAST($1 AS bit varying[])');
		expect(sql).not.toContain('CAST($1 AS text[])');
		expect(sql).not.toContain('varbit(8)');
		expect(parameters).toEqual([['10101010']]);
	});

	it('casts integer NOT IN list', () => {
		const model = buildModel('orders', [
			{ name: 'state', type: 'number', originalDbType: 'integer' },
		]);
		const adapter = createPgsqlCompileOnlyAdapter({ model });
		const { sql, parameters } = adapter.compile({
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{ type: 'where', column: 'state', operator: 'notIn', value: [0, 9] },
			],
		} as Parameters<typeof adapter.compile>[0]);
		expect(sql).toContain('CAST($1 AS integer[])');
		expect(parameters).toEqual([[0, 9]]);
	});

	it('does NOT cast IN when no model is provided (backward compat)', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const { sql, parameters } = adapter.compile({
			rootTable: 'items',
			decisions: [
				{ type: 'select', column: '*' },
				{ type: 'where', column: 'status', operator: 'in', value: [1, 2, 3] },
			],
		} as Parameters<typeof adapter.compile>[0]);
		expect(sql).not.toContain('CAST');
		expect(sql).toContain('$1');
		expect(parameters).toEqual([[1, 2, 3]]);
	});

	it('does NOT cast IN when originalDbType is absent', () => {
		const model = buildModel('items', [{ name: 'status', type: 'number' }]);
		const adapter = createPgsqlCompileOnlyAdapter({ model });
		const { sql, parameters } = adapter.compile({
			rootTable: 'items',
			decisions: [
				{ type: 'select', column: '*' },
				{ type: 'where', column: 'status', operator: 'in', value: [1, 2, 3] },
			],
		} as Parameters<typeof adapter.compile>[0]);
		expect(sql).not.toContain('CAST');
		expect(sql).toContain('$1');
		expect(parameters).toEqual([[1, 2, 3]]);
	});
});

describe('PARAM-TYPE-CAST [P0-T1]: originalDbType from introspection flows to compiled SQL CAST', () => {
	it('vector column — introspected originalDbType produces CAST($1 AS vector)', () => {
		// Simulates: buildTableIR sets col.originalDbType = col.udt_name ('vector')
		// A parameterized WHERE clause against that column should emit CAST
		const { sql, parameters } = compileSelect(
			'embeddings',
			[
				{
					name: 'vec',
					type: 'string',
					nullable: false,
					originalDbType: 'vector',
				},
			],
			'vec',
			'[0.1,0.2,0.3]',
		);
		expect(sql).toContain('CAST($1 AS vector)');
		expect(parameters).toEqual(['[0.1,0.2,0.3]']);
	});

	it('jsonb column — introspected originalDbType produces CAST($1 AS jsonb)', () => {
		const { sql, parameters } = compileSelect(
			'events',
			[
				{
					name: 'payload',
					type: 'json',
					nullable: true,
					originalDbType: 'jsonb',
				},
			],
			'payload',
			'{"key":"val"}',
		);
		expect(sql).toContain('CAST($1 AS jsonb)');
		expect(parameters).toEqual(['{"key":"val"}']);
	});

	it('without originalDbType (manually defined schema) — no CAST emitted', () => {
		// Manually defined schemas omit originalDbType; no automatic CAST should be emitted
		const { sql } = compileSelect(
			'items',
			[{ name: 'code', type: 'string', nullable: false }],
			'code',
			'ABC',
		);
		expect(sql).not.toContain('CAST');
	});
});
