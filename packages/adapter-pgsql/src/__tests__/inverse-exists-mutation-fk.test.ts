/**
 * Regression tests for exists()/notExists() on inverse hasMany relations in
 * mutation WHERE clauses. The FK is intentionally non-conventional so fallback
 * derivation (symbols -> symbol_id) would be visibly wrong.
 */

import { exists, notExists, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const inverseFkSchema = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	calls: {
		id: { type: 'integer', primaryKey: true },
		callee_ref: ref('symbols', {
			as: 'callee',
			inverse: 'calleeCalls',
		}),
		body: { type: 'text' },
	},
});

function buildAdapter() {
	return createPgsqlCompileOnlyAdapter({ model: inverseFkSchema.model });
}

function expectInverseCorrelation(sql: string) {
	expect(sql).toMatch(/EXISTS/i);
	expect(sql).toMatch(/FROM\s+"?calls"?/i);
	expect(sql).toContain('callee_ref');
	expect(sql).toMatch(
		/"?symbols"?\."?id"?\s*=\s*"?calls_exists_\d+"?\."?callee_ref"?/,
	);
	expect(sql).not.toContain('symbol_id');
	expect(sql).not.toMatch(
		/"?symbols"?\."?callee_ref"?\s*=\s*"?calls_exists_\d+"?\."?id"?/,
	);
}

const compositeFkRelations = new Map([
	[
		'customers.orders',
		{
			name: 'orders',
			type: 'hasMany',
			source: 'customers',
			target: 'orders',
			foreignKey: 'customer_id',
			cardinality: 'many',
			optionality: 'optional',
			includeStrategy: 'auto',
			filterStrategy: 'auto',
			joinDefault: 'auto',
		},
	],
	[
		'orders.items',
		{
			name: 'items',
			type: 'hasMany',
			source: 'orders',
			target: 'order_items',
			foreignKey: ['order_id', 'tenant_id'],
			sourceKey: ['order_id', 'tenant_id'],
			cardinality: 'many',
			optionality: 'optional',
			includeStrategy: 'auto',
			filterStrategy: 'auto',
			joinDefault: 'auto',
		},
	],
] as const);

const compositeFkModel = {
	relations: compositeFkRelations,
	tables: new Map(),
	getTable: () => undefined,
	getRelation: (qualifiedName: 'customers.orders' | 'orders.items') =>
		compositeFkRelations.get(qualifiedName),
	getRelationsFrom: (source: string) =>
		[...compositeFkRelations.values()].filter(
			(relation) => relation.source === source,
		),
	getRelationsTo: (target: string) =>
		[...compositeFkRelations.values()].filter(
			(relation) => relation.target === target,
		),
	isAmbiguous: () => ({ ambiguous: false, options: [] }),
};

function buildCompositeFkAdapter() {
	const relation = compositeFkModel.getRelation('orders.items');
	expect(relation?.foreignKey).toEqual(['order_id', 'tenant_id']);
	return createPgsqlCompileOnlyAdapter({ model: compositeFkModel });
}

function expectCompositeCorrelation(sql: string, sourceAlias = 'orders') {
	expect(sql).toMatch(/EXISTS/i);
	expect(sql).toMatch(/FROM\s+"?order_items"?/i);
	const quotedSource = sourceAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	expect(sql).toMatch(
		new RegExp(
			`"?${quotedSource}"?\\."?order_id"?\\s*=\\s*"?order_items_exists_\\d+"?\\."?order_id"?`,
		),
	);
	expect(sql).toMatch(
		new RegExp(
			`"?${quotedSource}"?\\."?tenant_id"?\\s*=\\s*"?order_items_exists_\\d+"?\\."?tenant_id"?`,
		),
	);
	expect(sql).not.toMatch(
		/"?orders"?\."?id"?\s*=\s*"?order_items_exists_\d+"?\."?order_id"?/,
	);
}

function compileMutationWhere(
	adapter: ReturnType<typeof createPgsqlCompileOnlyAdapter>,
	entryPoint: string,
	table: string,
	where: unknown,
): string {
	switch (entryPoint) {
		case 'compileInsertFrom':
			return adapter.compileInsertFrom({
				type: 'insert_from',
				table: `${table}_archive`,
				source: table,
				columns: ['id', 'name'],
				where,
			} as any).sql;
		case 'compileUpdate':
			return adapter.compileUpdate({
				type: 'update',
				table,
				set: { name: 'archived' },
				where,
			} as any).sql;
		case 'compileBatchUpdate':
			return adapter.compileBatchUpdate({
				type: 'batchUpdate',
				table,
				matchColumns: ['id'],
				updates: [{ id: 1, name: 'archived' }],
				where,
			} as any).sql;
		case 'compileDelete':
			return adapter.compileDelete({
				type: 'delete',
				table,
				where,
			} as any).sql;
		case 'compileUpsert.action.where':
			return adapter.compileUpsert({
				type: 'upsert',
				table,
				values: [{ id: 1, name: 'active' }],
				onConflict: { columns: ['id'] },
				action: {
					type: 'doUpdate',
					set: { name: 'active' },
					where,
				},
			} as any).sql;
		case 'compileUpsertFrom':
			return adapter.compileUpsertFrom({
				type: 'upsert_from',
				table: `${table}_archive`,
				source: table,
				conflictColumns: ['id'],
				columns: ['id', 'name'],
				where,
			} as any).sql;
		default:
			throw new Error(`Unknown mutation WHERE entry point: ${entryPoint}`);
	}
}

const mutationWhereEntryPoints = [
	'compileInsertFrom',
	'compileUpdate',
	'compileBatchUpdate',
	'compileDelete',
	'compileUpsert.action.where',
	'compileUpsertFrom',
];

describe('inverse relation exists() mutation FK resolution', () => {
	it('upsert VALUES action WHERE exists(inverse) correlates on the real target FK', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileUpsert({
			type: 'upsert',
			table: 'symbols',
			values: [{ id: 1, name: 'Alpha' }],
			onConflict: { columns: ['id'] },
			action: {
				type: 'doUpdate',
				where: exists('calleeCalls'),
			},
		} as any);

		expect(sql).toContain('VALUES');
		expect(sql).not.toContain('unnest(');
		expectInverseCorrelation(sql);
	});

	it('upsert unnest action WHERE exists(inverse) correlates on the real target FK', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileUpsert(
			{
				type: 'upsert',
				table: 'symbols',
				values: [{ id: 1, name: 'Alpha' }],
				onConflict: { columns: ['id'] },
				action: {
					type: 'doUpdate',
					where: exists('calleeCalls'),
				},
			} as any,
			{ batchThreshold: 0 },
		);

		expect(sql).toContain('unnest(');
		expect(sql).not.toContain('VALUES');
		expectInverseCorrelation(sql);
	});

	it('DELETE WHERE exists(inverse) correlates on the real target FK', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete',
			table: 'symbols',
			where: exists('calleeCalls'),
		} as any);

		expect(sql).toMatch(/^DELETE/i);
		expectInverseCorrelation(sql);
	});

	it('UPDATE WHERE notExists(inverse) correlates on the real target FK', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileUpdate({
			type: 'update',
			table: 'symbols',
			set: { name: 'archived' },
			where: notExists('calleeCalls'),
		} as any);

		expect(sql).toMatch(/^UPDATE/i);
		expect(sql).toMatch(/NOT.*EXISTS/i);
		expectInverseCorrelation(sql);
	});

	it.each(
		mutationWhereEntryPoints,
	)('%s resolves single-column exists() relation metadata', (entryPoint) => {
		const adapter = buildAdapter();

		const sql = compileMutationWhere(
			adapter,
			entryPoint,
			'symbols',
			exists('calleeCalls'),
		);

		expectInverseCorrelation(sql);
	});
});

describe('composite FK exists() mutation correlation', () => {
	it('DELETE WHERE notExists(composite relation) correlates on the full key', () => {
		const adapter = buildCompositeFkAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete',
			table: 'orders',
			where: notExists('items'),
		} as any);

		expect(sql).toMatch(/NOT.*EXISTS/i);
		expectCompositeCorrelation(sql);
	});

	it('UPDATE WHERE exists(composite relation) correlates on the full key', () => {
		const adapter = buildCompositeFkAdapter();

		const { sql } = adapter.compileUpdate({
			type: 'update',
			table: 'orders',
			set: { status: 'archived' },
			where: exists('items'),
		} as any);

		expectCompositeCorrelation(sql);
	});

	it('upsert doUpdate WHERE notExists(composite relation) correlates on the full key', () => {
		const adapter = buildCompositeFkAdapter();

		const { sql } = adapter.compileUpsert({
			type: 'upsert',
			table: 'orders',
			values: [{ order_id: 1, tenant_id: 10, status: 'active' }],
			onConflict: { columns: ['order_id', 'tenant_id'] },
			action: {
				type: 'doUpdate',
				set: { status: 'active' },
				where: notExists('items'),
			},
		} as any);

		expect(sql).toMatch(/NOT.*EXISTS/i);
		expectCompositeCorrelation(sql);
	});

	it.each([
		'compileInsertFrom',
		'compileBatchUpdate',
		'compileUpsertFrom',
	])('%s WHERE exists(composite relation) correlates on the full key', (entryPoint) => {
		const adapter = buildCompositeFkAdapter();

		const sql = compileMutationWhere(
			adapter,
			entryPoint,
			'orders',
			exists('items'),
		);

		expectCompositeCorrelation(sql);
	});

	it('nested exists().where composite relation correlates on the full key', () => {
		const adapter = buildCompositeFkAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete',
			table: 'customers',
			where: exists('orders', { where: exists('items') }),
		} as any);

		expectCompositeCorrelation(sql, 'orders_exists_0');
	});
});
