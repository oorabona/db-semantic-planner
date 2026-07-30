import { createOrm, exists, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { compilePlan, type PlanDecision } from '../compiler.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const tables = new Map([
	[
		'orders',
		{
			name: 'orders',
			columns: [
				{ name: 'order_id', type: 'integer', nullable: false },
				{ name: 'tenant_id', type: 'integer', nullable: false },
			],
			primaryKey: ['order_id', 'tenant_id'],
			foreignKeys: [],
			indexes: [],
		},
	],
	[
		'order_items',
		{
			name: 'order_items',
			columns: [
				{ name: 'id', type: 'integer', nullable: false },
				{ name: 'order_id', type: 'integer', nullable: false },
				{ name: 'tenant_id', type: 'integer', nullable: false },
			],
			primaryKey: 'id',
			foreignKeys: [
				{
					columns: ['order_id', 'tenant_id'],
					references: { table: 'orders', columns: ['order_id', 'tenant_id'] },
				},
			],
			indexes: [],
		},
	],
] as const);

const relations = new Map([
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

const model = {
	tables,
	relations,
	getTable: (name: 'orders' | 'order_items') => tables.get(name),
	getRelation: (qualifiedName: 'orders.items') => relations.get(qualifiedName),
	getRelationsFrom: (source: string) =>
		[...relations.values()].filter((relation) => relation.source === source),
	getRelationsTo: (target: string) =>
		[...relations.values()].filter((relation) => relation.target === target),
	isAmbiguous: () => ({ ambiguous: false, options: [] }),
};

describe('composite FK correlation SQL', () => {
	it('schema() table-level composite FK constraints expose navigable relations', () => {
		const db = schema(
			{
				orders: {
					order_id: { type: 'integer', primaryKey: true },
					tenant_id: { type: 'integer', primaryKey: true },
				},
				items: {
					id: { type: 'integer', primaryKey: true },
					order_id: 'integer',
					tenant_id: 'integer',
				},
			},
			{
				items: {
					foreignKeys: [
						ref('orders', {
							columns: ['order_id', 'tenant_id'],
							references: ['order_id', 'tenant_id'],
						}),
					],
				},
			},
		);

		const ordersItems = db.model.getRelation('orders.items');
		expect(ordersItems).toMatchObject({
			name: 'items',
			type: 'hasMany',
			source: 'orders',
			target: 'items',
			foreignKey: ['order_id', 'tenant_id'],
			sourceKey: ['order_id', 'tenant_id'],
		});
		expect(db.model.getRelationsFrom('orders')).toContainEqual(ordersItems);

		const itemsOrder = db.model.getRelation('items.order');
		expect(itemsOrder).toMatchObject({
			name: 'order',
			type: 'belongsTo',
			source: 'items',
			target: 'orders',
			foreignKey: ['order_id', 'tenant_id'],
			targetKey: ['order_id', 'tenant_id'],
		});
		expect(db.model.getRelationsFrom('items')).toContainEqual(itemsOrder);

		const adapter = createPgsqlCompileOnlyAdapter({ model: db.model });
		const orm = createOrm({ model: db.model, adapter });
		const { sql } = (orm as any).select('orders').where(exists('items')).dump();

		expect(sql).toMatch(/EXISTS/i);
		expect(sql).toMatch(
			/orders\.order_id\s*=\s*items_exists_\d+\.order_id\s+AND\s+orders\.tenant_id\s*=\s*items_exists_\d+\.tenant_id/i,
		);
	});

	it('SELECT exists() correlates on every composite FK column', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model });
		const orm = createOrm({ model, adapter });

		const { sql } = (orm as any).select('orders').where(exists('items')).dump();

		expect(sql).toMatch(/EXISTS/i);
		expect(sql).toMatch(
			/orders\.order_id\s*=\s*order_items_exists_\d+\.order_id\s+AND\s+orders\.tenant_id\s*=\s*order_items_exists_\d+\.tenant_id/i,
		);
		expect(sql).not.toMatch(
			/orders\.id\s*=\s*order_items_exists_\d+\.order_id/i,
		);
	});

	it('fails closed when source and target correlation widths differ', () => {
		expect(() =>
			compilePlan({
				rootTable: 'orders',
				decisions: [
					{ type: 'select', column: '*', table: 'orders' },
					{
						type: 'join',
						targetTable: 'order_items',
						alias: 'items',
						sourceColumn: ['order_id'],
						targetColumn: ['order_id', 'tenant_id'],
					} satisfies PlanDecision,
				],
			}),
		).toThrow(/Invalid relation correlation/);
	});
});
