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

import {
	createOrm,
	lag,
	ref,
	rowNumber,
	schema,
	wCount,
	wSum,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const testSchema = schema({
	orders: {
		id: { type: 'integer', primaryKey: true },
		total: { type: 'integer' },
		status: { type: 'text' },
		customer_id: { type: 'integer' },
	},
});

function buildOrm() {
	const adapter = createPgCompileOnlyAdapter({
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

// Qualified window fields resolve through the query scope (#988).
describe('window fields: qualified names through the ORM', () => {
	const db = schema({
		files: { id: { type: 'integer', primaryKey: true }, path: 'text' },
		symbols: {
			id: { type: 'integer', primaryKey: true },
			body_hash: 'text',
			start_line: 'integer',
			file_id: ref('files', { as: 'file' }),
		},
	});
	const orm = createOrm({
		schema: db,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
	const FROM = 'FROM symbols JOIN files AS file ON symbols.file_id = file.id';

	it('PARTITION BY a relation join alias, ORDER BY a bare name', () => {
		const { sql } = orm
			.select('symbols')
			.join('file')
			.columns([
				'id',
				rowNumber().partitionBy('file.path').orderBy('start_line').as('rn'),
			])
			.dump();
		expect(sql).toBe(
			`SELECT symbols.id, row_number() OVER (PARTITION BY file.path ORDER BY symbols.start_line ASC) AS rn ${FROM}`,
		);
	});

	it('ORDER BY a relation join alias', () => {
		const { sql } = orm
			.select('symbols')
			.join('file')
			.columns(['id', rowNumber().orderBy('file.path', 'desc').as('rn')])
			.dump();
		expect(sql).toBe(
			`SELECT symbols.id, row_number() OVER (ORDER BY file.path DESC) AS rn ${FROM}`,
		);
	});

	it('the root table qualifies a window column argument', () => {
		const { sql } = orm
			.select('symbols')
			.join('file')
			.columns([
				'id',
				wSum('symbols.start_line').partitionBy('symbols.body_hash').as('tot'),
			])
			.dump();
		expect(sql).toBe(
			`SELECT symbols.id, sum(symbols.start_line) OVER (PARTITION BY symbols.body_hash) AS tot ${FROM}`,
		);
	});

	it('a joined column as a LAG argument', () => {
		const { sql } = orm
			.select('symbols')
			.join('file')
			.columns(['id', lag('file.path').orderBy('start_line').as('prev')])
			.dump();
		expect(sql).toBe(
			`SELECT symbols.id, lag(file.path) OVER (ORDER BY symbols.start_line ASC) AS prev ${FROM}`,
		);
	});

	it('an explicit join alias qualifies the field', () => {
		const { sql } = orm
			.select('symbols')
			.join('file', { as: 'f' })
			.columns(['id', rowNumber().partitionBy('f.path').as('rn')])
			.dump();
		expect(sql).toBe(
			'SELECT symbols.id, row_number() OVER (PARTITION BY f.path) AS rn FROM symbols JOIN files AS f ON symbols.file_id = f.id',
		);
	});

	it('a column absent from the qualified table is refused', () => {
		expect(() =>
			orm
				.select('symbols')
				.join('file')
				.columns(['id', rowNumber().partitionBy('file.nope').as('rn')])
				.dump(),
		).toThrow(
			"Declared column 'files.nope' is absent from the physical model.",
		);
	});
});
