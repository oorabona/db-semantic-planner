/**
 * WINDOW-FN-BARE regression test.
 *
 * Bug: COUNT(*) OVER() not supported — wCount() with no partitionBy/orderBy
 * produces an empty WindowDef ({}) which causes the deparser to omit the OVER
 * clause or emit broken SQL.
 *
 * Root cause: buildWindowDef() returns {} (empty object) when there are no
 * partitions or order-by columns. The deparser requires at least frameOptions
 * to emit a valid OVER() clause.
 *
 * Fix: set frameOptions: 1034 (default frame, no explicit frame clause) in
 * buildWindowDef() even when the window definition is empty, so the OVER()
 * clause is always emitted correctly.
 */

import { createOrm, schema, wCount, wSum } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const testSchema = schema({
	orders: {
		id: { type: 'integer', primaryKey: true },
		total: { type: 'integer' },
		status: { type: 'text' },
		customer_id: { type: 'integer' },
	},
});

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({
		model: testSchema.model,
	});
	return createOrm({ model: testSchema.model, adapter });
}

describe('WINDOW-FN-BARE: window functions with empty OVER() clause compile correctly', () => {
	it('wCount().as("total") produces COUNT(*) OVER() AS total', () => {
		const orm = buildOrm();
		const dump = orm
			.select('orders')
			.columns([wCount().as('total')])
			.dump();

		const sql = normalizeSQL(dump.sql);

		// Must contain count(*) — the agg_star form
		expect(sql).toMatch(/count\(\*\)/i);
		// Must contain the OVER() clause — even when empty
		expect(sql).toMatch(/over\s*\(\s*\)/i);
		// Must alias as total
		expect(sql).toMatch(/\bas\s+total\b/i);
		expect(dump.params).toHaveLength(0);
	});

	it('wCount().partitionBy("status").as("cnt") produces COUNT(*) OVER(PARTITION BY status) — regression', () => {
		const orm = buildOrm();
		const dump = orm
			.select('orders')
			.columns([wCount().partitionBy('status').as('cnt')])
			.dump();

		const sql = normalizeSQL(dump.sql);

		expect(sql).toMatch(/count\(\*\)/i);
		expect(sql).toMatch(/partition\s+by/i);
		expect(sql).toMatch(/status/i);
		expect(sql).toMatch(/\bas\s+cnt\b/i);
		expect(dump.params).toHaveLength(0);
	});

	it('wSum("total").as("running_total") produces SUM(total) OVER() AS running_total', () => {
		const orm = buildOrm();
		const dump = orm
			.select('orders')
			.columns([wSum('total').as('running_total')])
			.dump();

		const sql = normalizeSQL(dump.sql);

		expect(sql).toMatch(/sum\s*\(/i);
		expect(sql).toMatch(/total/);
		expect(sql).toMatch(/over\s*\(\s*\)/i);
		expect(sql).toMatch(/running_total/i);
		expect(dump.params).toHaveLength(0);
	});
});
