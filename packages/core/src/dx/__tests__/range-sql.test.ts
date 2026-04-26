/**
 * SQL output spot-check for range helpers.
 * Verifies the compiled SQL and params match the documented API.
 */

import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../../../../adapter-pgsql/src/pgsql-adapter.js';
import { createOrm } from '../orm.js';
import { rangeContainedBy, rangeContains, rangeOverlaps } from '../range.js';
import { schema } from '../schema.js';

const db = schema({
	bookings: { id: 'integer', period: 'string' },
	events: { id: 'integer', dateRange: 'string' },
} as const);

const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

describe('range helpers SQL output', () => {
	it('rangeOverlaps compiles to col && daterange($1, $2)', () => {
		const { sql, params } = orm
			.select('bookings')
			.where(rangeOverlaps('period', ['2024-01-01', '2024-01-31']))
			.dump();
		expect(sql).toContain('period && daterange($1, $2)');
		expect(params).toEqual(['2024-01-01', '2024-01-31']);
	});

	it('rangeContains compiles to col @> daterange($1, $2)', () => {
		const { sql, params } = orm
			.select('events')
			.where(rangeContains('dateRange', ['2024-06-15', '2024-06-15']))
			.dump();
		expect(sql).toContain('"dateRange" @> daterange($1, $2)');
		expect(params).toEqual(['2024-06-15', '2024-06-15']);
	});

	it('rangeContainedBy compiles to col <@ daterange($1, $2)', () => {
		const { sql, params } = orm
			.select('events')
			.where(rangeContainedBy('dateRange', ['2024-01-01', '2024-12-31']))
			.dump();
		expect(sql).toContain('"dateRange" <@ daterange($1, $2)');
		expect(params).toEqual(['2024-01-01', '2024-12-31']);
	});

	it('rangeOverlaps with int4range produces int4range constructor', () => {
		const db2 = schema({ spans: { id: 'integer', span: 'string' } } as const);
		const orm2 = createOrm({
			schema: db2,
			adapter: createPgsqlCompileOnlyAdapter(),
		});
		const { sql } = orm2
			.select('spans')
			.where(rangeOverlaps('span', [1, 100], 'int4range'))
			.dump();
		expect(sql).toContain('span && int4range($1, $2)');
	});
});
