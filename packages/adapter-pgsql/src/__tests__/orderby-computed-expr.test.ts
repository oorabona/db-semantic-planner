// ORDERBY-COMPUTED-EXPR regression test

import { createOrm, op, exprRef as ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		start_line: 'integer',
		end_line: 'integer',
	},
	rankings: {
		id: { type: 'integer', primaryKey: true },
		score: 'integer',
		bonus: 'integer',
	},
});
const orm = createOrm({
	model: db.model,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});

describe('ORDERBY-COMPUTED-EXPR: orderBy(op(...)) generates correct SQL', () => {
	it('op("-", ref("end_line"), ref("start_line")) produces arithmetic in ORDER BY', () => {
		const { sql, params } = orm
			.select('symbols')
			.orderBy(op('-', ref('end_line'), ref('start_line')), 'asc')
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT symbols.* FROM symbols ORDER BY end_line - start_line ASC',
			params: [],
		});
	});

	it('ASC direction preserved for op("-") orderBy', () => {
		const { sql, params } = orm
			.select('symbols')
			.orderBy(op('-', ref('end_line'), ref('start_line')), 'asc')
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT symbols.* FROM symbols ORDER BY end_line - start_line ASC',
			params: [],
		});
	});

	it('DESC direction preserved for op("-") orderBy', () => {
		const { sql, params } = orm
			.select('symbols')
			.orderBy(op('-', ref('end_line'), ref('start_line')), 'desc')
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT symbols.* FROM symbols ORDER BY end_line - start_line DESC',
			params: [],
		});
	});

	it('op("+") in ORDER BY produces addition expression', () => {
		const { sql, params } = orm
			.select('rankings')
			.orderBy(op('+', ref('score'), ref('bonus')), 'desc')
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT rankings.* FROM rankings ORDER BY score + bonus DESC',
			params: [],
		});
	});
});
