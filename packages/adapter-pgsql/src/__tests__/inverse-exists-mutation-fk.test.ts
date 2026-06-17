/**
 * Regression tests for exists()/notExists() on inverse hasMany relations in
 * mutation WHERE clauses. The FK is intentionally non-conventional so fallback
 * derivation (symbols -> symbol_id) would be visibly wrong.
 */

import { defineModel, exists, notExists, ref, schema } from '@dbsp/core';
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

const compositeFkModel = defineModel({
	relations: {
		'customers.orders': {
			cardinality: '1:N',
			target: 'orders',
			fk: 'customer_id',
		},
		'orders.items': {
			cardinality: '1:N',
			target: 'order_items',
			fk: ['order_id', 'tenant_id'],
		},
	},
});

function buildCompositeFkAdapter() {
	const relation = compositeFkModel.getRelation('orders.items');
	expect(relation?.foreignKey).toEqual(['order_id', 'tenant_id']);
	return createPgsqlCompileOnlyAdapter({ model: compositeFkModel });
}

function expectCompositeFkGuardError(compile: () => unknown) {
	try {
		compile();
	} catch (error) {
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain('orders.items');
		expect(message).toContain('foreignKey');
		expect(message).toContain('#179');
		return;
	}
	throw new Error('Expected composite FK mutation guard to throw');
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

describe('composite FK exists() mutation guard fail-loud behavior', () => {
	it('DELETE WHERE notExists(composite relation) throws a clear #179 error', () => {
		const adapter = buildCompositeFkAdapter();

		expectCompositeFkGuardError(() =>
			adapter.compileDelete({
				type: 'delete',
				table: 'orders',
				where: notExists('items'),
			} as any),
		);
	});

	it('UPDATE WHERE exists(composite relation) throws a clear #179 error', () => {
		const adapter = buildCompositeFkAdapter();

		expectCompositeFkGuardError(() =>
			adapter.compileUpdate({
				type: 'update',
				table: 'orders',
				set: { status: 'archived' },
				where: exists('items'),
			} as any),
		);
	});

	it('upsert doUpdate WHERE notExists(composite relation) throws a clear #179 error', () => {
		const adapter = buildCompositeFkAdapter();

		expectCompositeFkGuardError(() =>
			adapter.compileUpsert({
				type: 'upsert',
				table: 'orders',
				values: [{ id: 1, tenant_id: 10, status: 'active' }],
				onConflict: { columns: ['id', 'tenant_id'] },
				action: {
					type: 'doUpdate',
					set: { status: 'active' },
					where: notExists('items'),
				},
			} as any),
		);
	});

	it.each([
		'compileInsertFrom',
		'compileBatchUpdate',
		'compileUpsertFrom',
	])('%s WHERE exists(composite relation) throws a clear #179 error', (entryPoint) => {
		const adapter = buildCompositeFkAdapter();

		expectCompositeFkGuardError(() =>
			compileMutationWhere(adapter, entryPoint, 'orders', exists('items')),
		);
	});

	it('nested exists().where composite relation throws a clear #179 error', () => {
		const adapter = buildCompositeFkAdapter();

		expectCompositeFkGuardError(() =>
			adapter.compileDelete({
				type: 'delete',
				table: 'customers',
				where: exists('orders', { where: exists('items') }),
			} as any),
		);
	});
});
