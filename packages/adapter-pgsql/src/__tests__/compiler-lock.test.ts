/**
 * PlanCompiler — Locking clause tests (E15)
 *
 * Tests that SimplifiedPlanReport.lock compiles correctly
 * for all 4 strengths × 3 wait policies, and that lock scoping
 * works with JOINs (INV-E15-05).
 */

import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';

function sql(plan: SimplifiedPlanReport): string {
	return normalizeSQL(compilePlan(plan).sql);
}

describe('Compiler — lock clause', () => {
	// ==========================================================================
	// All 4 strengths × default policy (block)
	// ==========================================================================

	it('FOR UPDATE (block)', () => {
		const result = sql({
			rootTable: 'jobs',
			decisions: [],
			lock: { strength: 'forUpdate', waitPolicy: 'block' },
		});
		expect(result).toContain('for update');
		expect(result).not.toContain('skip locked');
		expect(result).not.toContain('nowait');
	});

	it('FOR SHARE (block)', () => {
		const result = sql({
			rootTable: 'jobs',
			decisions: [],
			lock: { strength: 'forShare', waitPolicy: 'block' },
		});
		expect(result).toContain('for share');
	});

	it('FOR NO KEY UPDATE (block)', () => {
		const result = sql({
			rootTable: 'jobs',
			decisions: [],
			lock: { strength: 'forNoKeyUpdate', waitPolicy: 'block' },
		});
		expect(result).toContain('for no key update');
	});

	it('FOR KEY SHARE (block)', () => {
		const result = sql({
			rootTable: 'jobs',
			decisions: [],
			lock: { strength: 'forKeyShare', waitPolicy: 'block' },
		});
		expect(result).toContain('for key share');
	});

	// ==========================================================================
	// Wait policies
	// ==========================================================================

	it('FOR UPDATE SKIP LOCKED', () => {
		const result = sql({
			rootTable: 'jobs',
			decisions: [],
			lock: { strength: 'forUpdate', waitPolicy: 'skipLocked' },
		});
		expect(result).toContain('for update skip locked');
	});

	it('FOR UPDATE NOWAIT', () => {
		const result = sql({
			rootTable: 'jobs',
			decisions: [],
			lock: { strength: 'forUpdate', waitPolicy: 'noWait' },
		});
		expect(result).toContain('for update nowait');
	});

	it('FOR SHARE SKIP LOCKED', () => {
		const result = sql({
			rootTable: 'jobs',
			decisions: [],
			lock: { strength: 'forShare', waitPolicy: 'skipLocked' },
		});
		expect(result).toContain('for share skip locked');
	});

	it('FOR SHARE NOWAIT', () => {
		const result = sql({
			rootTable: 'jobs',
			decisions: [],
			lock: { strength: 'forShare', waitPolicy: 'noWait' },
		});
		expect(result).toContain('for share nowait');
	});

	// ==========================================================================
	// With WHERE + LIMIT (job queue pattern)
	// ==========================================================================

	it('job queue pattern: WHERE + LIMIT + FOR UPDATE SKIP LOCKED', () => {
		const result = sql({
			rootTable: 'jobs',
			decisions: [
				{ type: 'where', column: 'status', operator: '=', value: 'pending' },
				{ type: 'limit', limit: 1 },
			],
			lock: { strength: 'forUpdate', waitPolicy: 'skipLocked' },
		});
		expect(result).toContain('where');
		expect(result).toContain('limit');
		expect(result).toContain('for update skip locked');
	});

	// ==========================================================================
	// Lock scoping with JOINs (INV-E15-05)
	// ==========================================================================

	it('scopes lock to root table when query has JOIN (include)', () => {
		const result = sql({
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*', table: 'orders' },
				{
					type: 'includeStrategy',
					choice: 'join',
					relationName: 'customer',
					targetTable: 'customers',
					relationType: 'belongsTo',
					foreignKey: 'customer_id',
				},
			],
			lock: { strength: 'forUpdate', waitPolicy: 'block' },
		});
		// Should include "OF" to scope lock to root table only
		expect(result).toContain('for update of');
		expect(result).toContain('orders');
	});

	// ==========================================================================
	// No lock when lock is undefined
	// ==========================================================================

	it('no lock clause when lock is undefined', () => {
		const result = sql({
			rootTable: 'jobs',
			decisions: [],
		});
		expect(result).not.toContain('for update');
		expect(result).not.toContain('for share');
		expect(result).not.toContain('skip locked');
		expect(result).not.toContain('nowait');
	});
});
