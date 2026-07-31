import { createOrm, eq, exists } from '@dbsp/core';
import { compile } from '@dbsp/nql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	compositeFkModel,
	createCompositeFkSchema,
	dropCompositeFkSchema,
	getTestAdapter,
	seedCompositeFkData,
} from './testkit/index.js';

const SCHEMA = 'composite_fk_e2e';

beforeAll(async () => {
	await dropCompositeFkSchema(SCHEMA);
	await createCompositeFkSchema(SCHEMA);
	await seedCompositeFkData(SCHEMA);
});

afterAll(async () => {
	await dropCompositeFkSchema(SCHEMA);
	await closeTestDb();
});

// The ORM hydrates top-level result columns to camelCase (order_id → orderId),
// so result rows are read with camelCase keys here. Nested json_agg items
// (e.g. `items[].sku` below) keep their raw to_jsonb DB names (snake_case) —
// this top-level-camel / nested-snake asymmetry is intentional ORM behavior.
function orderKey(row: { orderId: number; tenantId: number }): string {
	return `${row.orderId}:${row.tenantId}`;
}

describe('Composite FK correlation', () => {
	it('include() hydrates only rows matching the full composite key', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: compositeFkModel, adapter });

		const rows = (await orm
			.withSchema(SCHEMA)
			.select('orders')
			.include('items')
			.columns(['order_id', 'tenant_id', 'status'])
			.execute()) as unknown as Array<{
			orderId: number;
			tenantId: number;
			status: string;
			items: Array<{ sku: string }>;
		}>;

		const skusByOrder = new Map(
			rows.map((row) => [
				orderKey(row),
				row.items.map((item) => item.sku).sort(),
			]),
		);

		expect(skusByOrder.get('100:1')).toEqual(['sku-a', 'sku-b']);
		expect(skusByOrder.get('100:2')).toEqual(['sku-c']);
		expect(skusByOrder.get('101:1')).toEqual(['sku-a']);
	});

	it('exists() filters on the full composite key', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: compositeFkModel, adapter });

		const rows = (await orm
			.withSchema(SCHEMA)
			.select('orders')
			.where(exists('items', { where: eq('sku', 'sku-a') }))
			.columns(['order_id', 'tenant_id'])
			.execute()) as unknown as Array<{ orderId: number; tenantId: number }>;

		expect(rows.map(orderKey).sort()).toEqual(['100:1', '101:1']);
	});

	it('binding relation columns resolve through the full composite key', async () => {
		const adapter = await getTestAdapter();
		const compiled = compile(
			`order_items | select id, order_id, tenant_id, sku | bind projected_items
projected_items | select id, sku, order.status`,
			compositeFkModel,
		);
		if (!compiled.success || !compiled.ast) {
			throw new Error(
				`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
			);
		}

		const query = adapter.compile(compiled.ast, {
			model: compositeFkModel,
			schemaName: SCHEMA,
		});
		const rows = (await adapter.execute(query)) as Array<{
			id: number;
			sku: string;
			'order.status': string;
		}>;

		const statusByItem = new Map(
			rows.map((row) => [row.id, row['order.status']]),
		);

		expect(statusByItem.get(1)).toBe('tenant-1-open');
		expect(statusByItem.get(2)).toBe('tenant-1-open');
		expect(statusByItem.get(3)).toBe('tenant-2-open');
		expect(statusByItem.get(4)).toBe('tenant-1-review');
	});
});
