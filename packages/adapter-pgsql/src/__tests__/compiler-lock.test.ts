/**
 * Locking clause tests (E15)
 *
 * Tests that the query builder's lock methods compile correctly
 * for all 4 strengths × 3 wait policies, and that lock scoping
 * works with JOINs (INV-E15-05).
 */

import { createOrm, eq, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	jobs: {
		id: { type: 'integer', primaryKey: true },
		status: { type: 'text' },
	},
	customers: {
		id: { type: 'integer', primaryKey: true },
	},
	orders: {
		id: { type: 'integer', primaryKey: true },
		customer_id: ref('customers', { as: 'customer', inverse: 'orders' }),
	},
} as const);
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});

describe('Compiler — lock clause', () => {
	// ==========================================================================
	// All 4 strengths × default policy (block)
	// ==========================================================================

	it('FOR UPDATE (block)', () => {
		const { sql, params } = orm.select('jobs').forUpdate().dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT jobs.* FROM jobs FOR UPDATE',
			params: [],
		});
	});

	it('FOR SHARE (block)', () => {
		const { sql, params } = orm.select('jobs').forShare().dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT jobs.* FROM jobs FOR SHARE',
			params: [],
		});
	});

	it('FOR NO KEY UPDATE (block)', () => {
		const { sql, params } = orm.select('jobs').forNoKeyUpdate().dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT jobs.* FROM jobs FOR NO KEY UPDATE',
			params: [],
		});
	});

	it('FOR KEY SHARE (block)', () => {
		const { sql, params } = orm.select('jobs').forKeyShare().dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT jobs.* FROM jobs FOR KEY SHARE',
			params: [],
		});
	});

	// ==========================================================================
	// Wait policies
	// ==========================================================================

	it('FOR UPDATE SKIP LOCKED', () => {
		const { sql, params } = orm.select('jobs').forUpdate().skipLocked().dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT jobs.* FROM jobs FOR UPDATE SKIP LOCKED',
			params: [],
		});
	});

	it('FOR UPDATE NOWAIT', () => {
		const { sql, params } = orm.select('jobs').forUpdate().noWait().dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT jobs.* FROM jobs FOR UPDATE NOWAIT',
			params: [],
		});
	});

	it('FOR SHARE SKIP LOCKED', () => {
		const { sql, params } = orm.select('jobs').forShare().skipLocked().dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT jobs.* FROM jobs FOR SHARE SKIP LOCKED',
			params: [],
		});
	});

	it('FOR SHARE NOWAIT', () => {
		const { sql, params } = orm.select('jobs').forShare().noWait().dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT jobs.* FROM jobs FOR SHARE NOWAIT',
			params: [],
		});
	});

	// ==========================================================================
	// With WHERE + LIMIT (job queue pattern)
	// ==========================================================================

	it('job queue pattern: WHERE + LIMIT + FOR UPDATE SKIP LOCKED', () => {
		const { sql, params } = orm
			.select('jobs')
			.where(eq('status', 'pending'))
			.limit(1)
			.forUpdate()
			.skipLocked()
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT jobs.* FROM jobs WHERE jobs.status = $1 LIMIT 1 FOR UPDATE SKIP LOCKED',
			params: ['pending'],
		});
	});

	// ==========================================================================
	// Lock scoping with JOINs (INV-E15-05)
	// ==========================================================================

	it('scopes lock to root table when query has JOIN (include)', () => {
		const { sql, params } = orm
			.select('orders')
			.include('customer', { join: 'left' })
			.forUpdate()
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT orders.*, customer.id AS "customer.id", customer.id AS __dbsp_presence_customer FROM orders LEFT JOIN customers AS customer ON orders.customer_id = customer.id FOR UPDATE OF orders',
			params: [],
		});
	});
});
