/**
 * Issue 10: orderBy() with ExpressionSpec and nulls option
 *
 * orderBy(op('-', exprRef('end_line'), exprRef('start_line')), 'desc', { nulls: 'last' })
 * must generate ORDER BY (end_line - start_line) DESC NULLS LAST
 *
 * Previously the ExpressionSpec/ExpressionRef branches in orderBy() did not
 * propagate the options.nulls field, so NULLS LAST/FIRST was silently dropped.
 */

import { createOrm, exprRef, fn, op, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Test schema
// ---------------------------------------------------------------------------

const testSchema = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		start_line: { type: 'integer' },
		end_line: { type: 'integer' },
		complexity: { type: 'integer' },
	},
});

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

// ---------------------------------------------------------------------------
// Tests: ExpressionSpec + nulls option
// ---------------------------------------------------------------------------

describe('orderBy() ExpressionSpec with nulls option', () => {
	it('op() expression with desc + nulls: last produces NULLS LAST', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.orderBy(op('-', exprRef('end_line'), exprRef('start_line')), 'desc', {
				nulls: 'last',
			})
			.dump();

		expect(dump.sql).toContain('DESC');
		expect(dump.sql).toContain('NULLS LAST');
	});

	it('op() expression with asc + nulls: first produces NULLS FIRST', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.orderBy(op('-', exprRef('end_line'), exprRef('start_line')), 'asc', {
				nulls: 'first',
			})
			.dump();

		expect(dump.sql).toContain('ASC');
		expect(dump.sql).toContain('NULLS FIRST');
	});

	it('op() expression without nulls option has no NULLS clause', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.orderBy(op('-', exprRef('end_line'), exprRef('start_line')), 'desc')
			.dump();

		expect(dump.sql).not.toContain('NULLS');
	});

	it('fn() expression with desc + nulls: last produces NULLS LAST', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.orderBy(fn('ABS', exprRef('complexity')), 'desc', { nulls: 'last' })
			.dump();

		expect(dump.sql).toContain('DESC');
		expect(dump.sql).toContain('NULLS LAST');
	});

	it('chained: string column and expression column each with nulls', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.orderBy('name', 'asc', { nulls: 'first' })
			.orderBy(op('-', exprRef('end_line'), exprRef('start_line')), 'desc', {
				nulls: 'last',
			})
			.dump();

		expect(dump.sql).toContain('NULLS FIRST');
		expect(dump.sql).toContain('NULLS LAST');
	});

	it('expression orderBy appears before NULLS keyword in SQL', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.orderBy(op('-', exprRef('end_line'), exprRef('start_line')), 'desc', {
				nulls: 'last',
			})
			.dump();

		// NULLS LAST must follow the ORDER BY expression
		const orderByIdx = dump.sql.indexOf('ORDER BY');
		const nullsIdx = dump.sql.indexOf('NULLS LAST');
		expect(orderByIdx).toBeGreaterThan(-1);
		expect(nullsIdx).toBeGreaterThan(orderByIdx);
	});
});
