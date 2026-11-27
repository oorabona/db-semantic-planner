/**
 * FN-REF-ALIAS regression tests.
 *
 * Verifies that exprRef('col') / string args inside fn() emit an unqualified
 * column reference, not a root-table-qualified one.
 *
 * The pgsql deparser emits unquoted lowercase identifiers for simple column names.
 * So `exprRef('id')` → `id` (no table prefix, no quotes) in normalized SQL.
 * And `exprRef('callee.id')` → `callee.id` (table-qualified, no quotes).
 *
 * Previously the compiler would have emitted `calls.id` (root table qualified).
 */

import { createOrm, eq, exprRef, fn, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
	},
	calls: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		active: { type: 'boolean' },
		callee_id: ref('symbols', { as: 'callee', inverse: 'callee_calls' }),
	},
} as const);
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});

describe('FN-REF-ALIAS: exprRef() inside fn() column qualification', () => {
	it('exprRef("id") without dot → unqualified id, not calls.id', () => {
		const { sql, params } = orm
			.select('calls')
			.columns([fn('array_agg', exprRef('id')).as('result')])
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT array_agg(id) AS result FROM calls',
			params: [],
		});
	});

	it('exprRef("name") without dot → unqualified name', () => {
		const { sql, params } = orm
			.select('calls')
			.columns([fn('array_agg', exprRef('name')).as('result')])
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT array_agg(name) AS result FROM calls',
			params: [],
		});
	});

	it('exprRef("callee.id") with dot → table-qualified callee.id', () => {
		const { sql, params } = orm
			.select('calls')
			.join('callee')
			.columns([fn('array_agg', exprRef('callee.id')).as('result')])
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT array_agg(callee.id) AS result FROM calls JOIN symbols AS callee ON calls.callee_id = callee.id',
			params: [],
		});
	});

	it('fn() with exprRef() arg + filter: arg is unqualified, filter uses rootTable', () => {
		const { sql, params } = orm
			.select('calls')
			.columns([
				fn('array_agg', exprRef('id')).filter(eq('active', true)).as('result'),
			])
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT array_agg(id) FILTER (WHERE calls.active = $1) AS result FROM calls',
			params: [true],
		});
	});

	it('string arg shorthand inside fn() → same as exprRef() — unqualified', () => {
		// fn('array_agg', 'id') is equivalent to fn('array_agg', exprRef('id'))
		const { sql, params } = orm
			.select('calls')
			.columns([fn('array_agg', 'id').as('result')])
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT array_agg(id) AS result FROM calls',
			params: [],
		});
	});

	it('nested fn(): inner exprRef() stays unqualified', () => {
		// The outer function is concat, not coalesce: fn('coalesce', ...) emits a
		// quoted "coalesce"(...) that PostgreSQL rejects (#1109).
		const { sql, params } = orm
			.select('calls')
			.columns([
				fn(
					'concat',
					fn('array_agg', exprRef('id')),
					fn('array_agg', exprRef('name')),
				).as('result'),
			])
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT concat(array_agg(id), array_agg(name)) AS result FROM calls',
			params: [],
		});
	});
});
