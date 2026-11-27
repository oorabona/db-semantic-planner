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

import { compilePlan } from '@dbsp/adapter-pgsql/internal';
import { createOrm, eq, inArray, not } from '@dbsp/core';
import type { ModelIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	createPgCompileOnlyAdapter,
	type PgAdapterOptions,
} from '../pgsql-adapter.js';

type ColumnDef = {
	name: string;
	type: string;
	nullable?: boolean;
	originalDbType?: string;
	originalDbTypeSchema?: string;
	originalDbTypeSchemaScope?: 'target' | 'absolute';
};

function buildModel(tableName: string, columns: ColumnDef[]): ModelIR {
	const tableColumns = columns.map((c) => ({
		name: c.name,
		type: c.type,
		nullable: c.nullable ?? false,
		...(c.originalDbType !== undefined && { originalDbType: c.originalDbType }),
		...(c.originalDbTypeSchema !== undefined && {
			originalDbTypeSchema: c.originalDbTypeSchema,
		}),
		...(c.originalDbTypeSchemaScope !== undefined && {
			originalDbTypeSchemaScope: c.originalDbTypeSchemaScope,
		}),
	}));
	const table = {
		name: tableName,
		columns: tableColumns,
		relations: [],
		primaryKey: 'id',
		foreignKeys: [],
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

function ormFor(
	tableName: string,
	columns: ColumnDef[],
	adapterOptions: Pick<PgAdapterOptions, 'schemaName' | 'dbCasing'> = {},
) {
	const model = buildModel(tableName, columns);
	return createOrm({
		model,
		adapter: createPgCompileOnlyAdapter({ model, ...adapterOptions }),
		suppressDxWarnings: true,
	});
}

function compileSelect(
	tableName: string,
	columns: ColumnDef[],
	whereColumn: string,
	whereValue: unknown,
	adapterOptions: Pick<PgAdapterOptions, 'schemaName' | 'dbCasing'> = {},
): { sql: string; params: readonly unknown[] } {
	const { sql, params } = ormFor(tableName, columns, adapterOptions)
		.select(tableName)
		.where(eq(whereColumn, whereValue as never))
		.dump();
	return { sql, params };
}

describe('PARAM-TYPE-CAST: comparison handler emits CAST when originalDbType set', () => {
	it('casts integer column via originalDbType', () => {
		const result = compileSelect(
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
		expect(result).toEqual({
			sql: 'SELECT items.* FROM items WHERE items.id = CAST($1 AS integer)',
			params: [42],
		});
	});

	it('casts nullable integer column (primary use-case for this feature)', () => {
		const result = compileSelect(
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
		expect(result).toEqual({
			sql: 'SELECT orders.* FROM orders WHERE orders.user_id = CAST($1 AS integer)',
			params: [99],
		});
	});

	it('casts uuid column via originalDbType', () => {
		const result = compileSelect(
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
		expect(result).toEqual({
			sql: 'SELECT sessions.* FROM sessions WHERE sessions.user_id = CAST($1 AS uuid)',
			params: ['abc-123'],
		});
	});

	it('casts timestamptz column via originalDbType', () => {
		const date = new Date('2024-01-01');
		const result = compileSelect(
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
		expect(result).toEqual({
			sql: 'SELECT events.* FROM events WHERE events.created_at = CAST($1 AS timestamptz)',
			params: [date],
		});
	});

	it('casts boolean column via originalDbType', () => {
		const result = compileSelect(
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
		expect(result).toEqual({
			sql: 'SELECT users.* FROM users WHERE users.active = CAST($1 AS bool)',
			params: [true],
		});
	});

	it('does NOT cast when no model is provided (backward compat)', () => {
		const { sql, parameters } = compilePlan({
			rootTable: 'items',
			decisions: [
				{ type: 'select', column: '*' },
				{ type: 'where', column: 'id', operator: '=', value: 42 },
			],
		});
		expect(sql).not.toContain('CAST');
		expect(sql).toContain('$1');
		expect(parameters).toEqual([42]);
	});

	it('does NOT cast FieldRef comparisons (column-to-column)', () => {
		const orm = ormFor('employees', [
			{ name: 'manager_id', type: 'number', originalDbType: 'integer' },
			{ name: 'id', type: 'number', originalDbType: 'integer' },
		]);
		const { sql, params } = orm
			.select('employees')
			.where(eq('manager_id', orm.tables.employees?.id as never))
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT employees.* FROM employees WHERE employees.manager_id = employees.id',
			params: [],
		});
	});

	it('routes faithful originalDbType through cast-safe WHERE targets', () => {
		const cases = [
			{
				column: {
					name: 'name',
					type: 'string',
					nullable: true,
					originalDbType: 'varchar(120)',
				},
				value: 'widget',
			},
			{
				column: {
					name: 'price',
					type: 'decimal',
					nullable: true,
					originalDbType: 'numeric(10,2)',
				},
				value: 12.34,
			},
			{
				column: {
					name: 'created_at',
					type: 'datetime',
					nullable: true,
					originalDbType: 'timestamp(3) with time zone',
				},
				value: '2024-01-01T00:00:00.000Z',
			},
			{
				column: {
					name: 'count',
					type: 'integer',
					nullable: true,
					originalDbType: 'integer',
				},
				value: 7,
			},
		];

		expect(
			cases.map(({ column, value }) =>
				compileSelect('products', [column], column.name, value),
			),
		).toEqual([
			{
				sql: 'SELECT products.* FROM products WHERE products.name = CAST($1 AS varchar)',
				params: ['widget'],
			},
			{
				sql: 'SELECT products.* FROM products WHERE products.price = CAST($1 AS numeric)',
				params: [12.34],
			},
			{
				sql: 'SELECT products.* FROM products WHERE products.created_at = CAST($1 AS timestamp with time zone)',
				params: ['2024-01-01T00:00:00.000Z'],
			},
			{
				sql: 'SELECT products.* FROM products WHERE products.count = CAST($1 AS integer)',
				params: [7],
			},
		]);
	});

	it('keeps target schema verbatim for target-scoped custom type casts', () => {
		const result = compileSelect(
			'events',
			[
				{
					name: 'state',
					type: 'string',
					nullable: false,
					originalDbType: 'status',
					originalDbTypeSchema: 'tenant_one',
					originalDbTypeSchemaScope: 'target',
				},
			],
			'state',
			'active',
			{ schemaName: 'tenantOne', dbCasing: 'snake_case' },
		);

		expect(result).toEqual({
			sql: 'SELECT events.* FROM "tenantOne".events WHERE events.state = CAST($1 AS "tenantOne".status)',
			params: ['active'],
		});
	});
});

describe('PARAM-TYPE-CAST: IN handler emits CAST when originalDbType set', () => {
	it('casts integer IN list', () => {
		const { sql, params } = ormFor('items', [
			{ name: 'status', type: 'number', originalDbType: 'integer' },
		])
			.select('items')
			.where(inArray('status', [1, 2, 3]))
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT items.* FROM items WHERE items.status = ANY (CAST($1 AS integer[]))',
			params: [[1, 2, 3]],
		});
	});

	it('casts uuid IN list via originalDbType', () => {
		const { sql, params } = ormFor('users', [
			{ name: 'role_id', type: 'uuid', originalDbType: 'uuid' },
		])
			.select('users')
			.where(inArray('role_id', ['aaa', 'bbb']))
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users.role_id = ANY (CAST($1 AS uuid[]))',
			params: [['aaa', 'bbb']],
		});
	});

	it('casts integer NOT IN list', () => {
		const { sql, params } = ormFor('orders', [
			{ name: 'state', type: 'number', originalDbType: 'integer' },
		])
			.select('orders')
			.where(not(inArray('state', [0, 9])))
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT orders.* FROM orders WHERE NOT (orders.state = ANY (CAST($1 AS integer[])))',
			params: [[0, 9]],
		});
	});

	it('does NOT cast IN when no model is provided (backward compat)', () => {
		const { sql, parameters } = compilePlan({
			rootTable: 'items',
			decisions: [
				{ type: 'select', column: '*' },
				{ type: 'where', column: 'status', operator: 'in', value: [1, 2, 3] },
			],
		});
		expect(sql).not.toContain('CAST');
		expect(sql).toContain('$1');
		expect(parameters).toEqual([[1, 2, 3]]);
	});
});

describe('PARAM-TYPE-CAST [P0-T1]: originalDbType from introspection flows to compiled SQL CAST', () => {
	it('vector column — introspected originalDbType produces CAST($1 AS vector)', () => {
		// Simulates: buildTableIR sets col.originalDbType = col.udt_name ('vector')
		// A parameterized WHERE clause against that column should emit CAST
		const result = compileSelect(
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
		expect(result).toEqual({
			sql: 'SELECT embeddings.* FROM embeddings WHERE embeddings.vec = CAST($1 AS vector)',
			params: ['[0.1,0.2,0.3]'],
		});
	});

	it('jsonb column — introspected originalDbType produces CAST($1 AS jsonb)', () => {
		const result = compileSelect(
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
		expect(result).toEqual({
			sql: 'SELECT events.* FROM events WHERE events.payload = CAST($1 AS jsonb)',
			params: ['{"key":"val"}'],
		});
	});
});
