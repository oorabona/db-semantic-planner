/**
 * E15 — Row-level locking (DX QueryBuilder)
 *
 * Tests lock methods on QueryBuilderImpl:
 * - 4 lock strengths, 3 wait policies
 * - Chaining (skipLocked, noWait)
 * - GROUP BY incompatibility
 * - Clone preservation
 * - Transaction warning
 */

import { describe, expect, it, vi } from 'vitest';
import { POSTGRESQL_CAPABILITIES } from '../dialects/index.js';
import { InvalidOperationError } from './errors.js';
import { createOrm } from './orm.js';
import { QueryBuilderImpl } from './query-builder.js';
import { ref, schema, schemaToModelIR } from './schema.js';
import { createMockAdapter } from './test-utils.js';

// ============================================================================
// Test Schema
// ============================================================================

const testSchema = schema({
	jobs: {
		id: 'uuid',
		status: 'string',
		payload: 'string',
	},
	orders: {
		id: 'uuid',
		total: 'integer',
		customer: ref('customers'),
	},
	customers: {
		id: 'uuid',
		name: 'string',
	},
});
const model = schemaToModelIR(testSchema.definition);

const orm = createOrm({ schema: testSchema, adapter: createMockAdapter() });

/** Build a QueryBuilderImpl with explicit inTransaction flag. */
function makeBuilder(inTx: boolean) {
	return new QueryBuilderImpl(
		model,
		false,
		'jobs',
		{},
		undefined,
		undefined,
		POSTGRESQL_CAPABILITIES,
		undefined,
		undefined,
		undefined,
		undefined,
		inTx,
	);
}

// ============================================================================
// Lock strength methods → intent.lock on PlanReport
// ============================================================================

describe('E15 — Lock methods', () => {
	it('forUpdate() sets lock on plan intent', () => {
		const plan = orm.select('jobs').forUpdate().plan();
		expect(plan.intent?.lock).toEqual({
			strength: 'forUpdate',
			waitPolicy: 'block',
		});
	});

	it('forShare() sets lock on plan intent', () => {
		const plan = orm.select('jobs').forShare().plan();
		expect(plan.intent?.lock).toEqual({
			strength: 'forShare',
			waitPolicy: 'block',
		});
	});

	it('forNoKeyUpdate() sets lock on plan intent', () => {
		const plan = orm.select('jobs').forNoKeyUpdate().plan();
		expect(plan.intent?.lock).toEqual({
			strength: 'forNoKeyUpdate',
			waitPolicy: 'block',
		});
	});

	it('forKeyShare() sets lock on plan intent', () => {
		const plan = orm.select('jobs').forKeyShare().plan();
		expect(plan.intent?.lock).toEqual({
			strength: 'forKeyShare',
			waitPolicy: 'block',
		});
	});

	// ========================================================================
	// lock() convenience method
	// ========================================================================

	it('lock() with explicit strength and policy', () => {
		const plan = orm.select('jobs').lock('forUpdate', 'skipLocked').plan();
		expect(plan.intent?.lock).toEqual({
			strength: 'forUpdate',
			waitPolicy: 'skipLocked',
		});
	});

	it('lock() defaults waitPolicy to block', () => {
		const plan = orm.select('jobs').lock('forShare').plan();
		expect(plan.intent?.lock).toEqual({
			strength: 'forShare',
			waitPolicy: 'block',
		});
	});

	// ========================================================================
	// skipLocked / noWait chaining
	// ========================================================================

	it('forUpdate().skipLocked() sets skipLocked policy', () => {
		const plan = orm.select('jobs').forUpdate().skipLocked().plan();
		expect(plan.intent?.lock).toEqual({
			strength: 'forUpdate',
			waitPolicy: 'skipLocked',
		});
	});

	it('forShare().noWait() sets noWait policy', () => {
		const plan = orm.select('jobs').forShare().noWait().plan();
		expect(plan.intent?.lock).toEqual({
			strength: 'forShare',
			waitPolicy: 'noWait',
		});
	});

	// ========================================================================
	// skipLocked / noWait without preceding lock → Error
	// ========================================================================

	it('skipLocked() throws without preceding lock', () => {
		expect(() => orm.select('jobs').skipLocked()).toThrow(
			'skipLocked() requires a preceding lock method',
		);
	});

	it('noWait() throws without preceding lock', () => {
		expect(() => orm.select('jobs').noWait()).toThrow(
			'noWait() requires a preceding lock method',
		);
	});

	// ========================================================================
	// GROUP BY + lock → InvalidOperationError (INV-E15-03)
	// ========================================================================

	it('throws InvalidOperationError when lock + GROUP BY', () => {
		expect(() =>
			orm.select('jobs').forUpdate().groupBy(['status']).plan(),
		).toThrow(InvalidOperationError);
	});

	it('error message mentions GROUP BY', () => {
		try {
			orm.select('jobs').forUpdate().groupBy(['status']).plan();
			expect.unreachable('Should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(InvalidOperationError);
			expect((error as InvalidOperationError).message).toContain('GROUP BY');
		}
	});

	// ========================================================================
	// No lock when not set
	// ========================================================================

	it('no lock on intent when no lock method called', () => {
		const plan = orm.select('jobs').plan();
		expect(plan.intent?.lock).toBeUndefined();
	});

	// ========================================================================
	// Clone preserves lockIntent
	// ========================================================================

	it('chaining preserves lock through other methods', () => {
		const plan = orm
			.select('jobs')
			.forUpdate()
			.skipLocked()
			.where({ status: 'pending' })
			.limit(1)
			.plan();
		expect(plan.intent?.lock).toEqual({
			strength: 'forUpdate',
			waitPolicy: 'skipLocked',
		});
	});

	// ========================================================================
	// Transaction warning (E15 DX)
	// ========================================================================

	it('warns when lock used outside transaction', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		makeBuilder(false).forUpdate().plan();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('outside a transaction'),
		);
		warnSpy.mockRestore();
	});

	it('does not warn when lock used inside transaction', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		makeBuilder(true).forUpdate().plan();
		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it('does not warn when no lock', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		makeBuilder(false).plan();
		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	// ========================================================================
	// Job queue pattern (full chain)
	// ========================================================================

	it('job queue pattern: where + limit + forUpdate + skipLocked', () => {
		const plan = orm
			.select('jobs')
			.where({ status: 'pending' })
			.limit(1)
			.forUpdate()
			.skipLocked()
			.plan();

		expect(plan.intent?.lock).toEqual({
			strength: 'forUpdate',
			waitPolicy: 'skipLocked',
		});
		expect(plan.intent?.limit).toBe(1);
		expect(plan.intent?.where).toBeDefined();
	});
});
