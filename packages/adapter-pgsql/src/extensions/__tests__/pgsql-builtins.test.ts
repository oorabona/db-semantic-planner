/**
 * pgsql-builtins Extension Tests
 *
 * Tests generateSeries using the compile-only adapter
 * with the full intent pipeline. Follows the same pattern as pgvector.test.ts.
 */

import { createOrm, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../../pgsql-adapter.js';
import { generateSeries } from '../pgsql-builtins.js';

const db = schema({ items: { id: { type: 'integer', primaryKey: true } } });
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});

describe('generateSeries', () => {
	it('compiles generate_series(start, stop) without step', () => {
		const { sql, params } = orm
			.select('items')
			.columns([generateSeries(1, 100).as('n')])
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT generate_series(1, 100) AS n FROM items',
			params: [],
		});
	});

	it('compiles generate_series(start, stop, step) with step', () => {
		const { sql, params } = orm
			.select('items')
			.columns([generateSeries(0, 50, 5).as('n')])
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT generate_series(0, 50, 5) AS n FROM items',
			params: [],
		});
	});
});
