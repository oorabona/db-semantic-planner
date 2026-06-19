import { ModelIRImpl, type RelationIR, type TableIR } from '@dbsp/core';

const tables = new Map<string, TableIR>([
	[
		'orders',
		{
			name: 'orders',
			columns: [
				{ name: 'order_id', type: 'integer', nullable: false },
				{ name: 'tenant_id', type: 'integer', nullable: false },
				{ name: 'status', type: 'text', nullable: false },
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
				{ name: 'sku', type: 'text', nullable: false },
				{ name: 'quantity', type: 'integer', nullable: false },
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
]);

const relations = new Map<string, RelationIR>([
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
	[
		'order_items.order',
		{
			name: 'order',
			type: 'belongsTo',
			source: 'order_items',
			target: 'orders',
			foreignKey: ['order_id', 'tenant_id'],
			targetKey: ['order_id', 'tenant_id'],
			cardinality: 'one',
			optionality: 'required',
			includeStrategy: 'auto',
			filterStrategy: 'auto',
			joinDefault: 'auto',
		},
	],
]);

export const compositeFkModel = new ModelIRImpl(tables, relations);
