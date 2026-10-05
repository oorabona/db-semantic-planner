import { ModelIRImpl, type TableIR } from '@dbsp/core';
import type { RelationIR } from '@dbsp/core/internal';

const tables = new Map<string, TableIR>([
	[
		'orders',
		{
			name: 'orders',
			columns: [
				{ name: 'orderId', type: 'integer', nullable: false },
				{ name: 'tenantId', type: 'integer', nullable: false },
				{ name: 'status', type: 'text', nullable: false },
			],
			primaryKey: ['orderId', 'tenantId'],
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
				{ name: 'orderId', type: 'integer', nullable: false },
				{ name: 'tenantId', type: 'integer', nullable: false },
				{ name: 'sku', type: 'text', nullable: false },
				{ name: 'quantity', type: 'integer', nullable: false },
			],
			primaryKey: 'id',
			foreignKeys: [
				{
					columns: ['orderId', 'tenantId'],
					references: { table: 'orders', columns: ['orderId', 'tenantId'] },
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
			foreignKey: ['orderId', 'tenantId'],
			sourceKey: ['orderId', 'tenantId'],
			cardinality: 'many',
			optionality: 'optional',
			includeStrategy: 'auto',
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
			foreignKey: ['orderId', 'tenantId'],
			targetKey: ['orderId', 'tenantId'],
			cardinality: 'one',
			optionality: 'required',
			includeStrategy: 'auto',
			joinDefault: 'auto',
		},
	],
]);

export const compositeFkModel = new ModelIRImpl(tables, relations);
