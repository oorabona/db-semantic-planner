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

	it('handles complex originalDbType like varchar(255)', () => {
		const { sql, parameters } = compileSelect(
			'products',
			[
				{
					name: 'name',
					type: 'string',
					nullable: true,
					originalDbType: 'varchar(255)',
				},
			],
			'name',
			'widget',
		);
		expect(sql).toContain('CAST($1 AS varchar(255))');
		expect(parameters).toEqual(['widget']);
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
