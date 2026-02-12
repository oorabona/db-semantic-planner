/**
 * E15 — NQL Lock clause tests
 *
 * Tests parse + compile for lock clauses:
 * - 4 lock strengths (forUpdate, forShare, forNoKeyUpdate, forKeyShare)
 * - 3 wait policies (block default, skipLocked, noWait)
 * - Combined with WHERE + LIMIT (job queue pattern)
 * - No conflict with UPDATE mutation
 */

import type { QueryIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.js';

function compileQuery(input: string): QueryIntent {
	const result = compile(input, null);
	if (!result.success) {
		throw new Error(`Compile error: ${result.errors[0]?.message}`);
	}
	return result.ast!.query! as QueryIntent;
}

// ============================================================================
// Lock strengths
// ============================================================================

describe('E15 — NQL Lock clause', () => {
	it('for update → forUpdate strength, block policy', () => {
		const query = compileQuery('jobs | for update');
		expect(query.lock).toEqual({
			strength: 'forUpdate',
			waitPolicy: 'block',
		});
	});

	it('for share → forShare strength, block policy', () => {
		const query = compileQuery('jobs | for share');
		expect(query.lock).toEqual({
			strength: 'forShare',
			waitPolicy: 'block',
		});
	});

	it('for no key update → forNoKeyUpdate strength', () => {
		const query = compileQuery('jobs | for no key update');
		expect(query.lock).toEqual({
			strength: 'forNoKeyUpdate',
			waitPolicy: 'block',
		});
	});

	it('for key share → forKeyShare strength', () => {
		const query = compileQuery('jobs | for key share');
		expect(query.lock).toEqual({
			strength: 'forKeyShare',
			waitPolicy: 'block',
		});
	});

	// ========================================================================
	// Wait policies
	// ========================================================================

	it('for update skip locked → skipLocked policy', () => {
		const query = compileQuery('jobs | for update skip locked');
		expect(query.lock).toEqual({
			strength: 'forUpdate',
			waitPolicy: 'skipLocked',
		});
	});

	it('for update nowait → noWait policy', () => {
		const query = compileQuery('jobs | for update nowait');
		expect(query.lock).toEqual({
			strength: 'forUpdate',
			waitPolicy: 'noWait',
		});
	});

	it('for share skip locked', () => {
		const query = compileQuery('jobs | for share skip locked');
		expect(query.lock).toEqual({
			strength: 'forShare',
			waitPolicy: 'skipLocked',
		});
	});

	it('for share nowait', () => {
		const query = compileQuery('jobs | for share nowait');
		expect(query.lock).toEqual({
			strength: 'forShare',
			waitPolicy: 'noWait',
		});
	});

	it('for no key update skip locked', () => {
		const query = compileQuery('jobs | for no key update skip locked');
		expect(query.lock).toEqual({
			strength: 'forNoKeyUpdate',
			waitPolicy: 'skipLocked',
		});
	});

	it('for key share nowait', () => {
		const query = compileQuery('jobs | for key share nowait');
		expect(query.lock).toEqual({
			strength: 'forKeyShare',
			waitPolicy: 'noWait',
		});
	});

	// ========================================================================
	// Combined with other clauses (job queue pattern)
	// ========================================================================

	it('job queue: where + limit + for update skip locked', () => {
		const query = compileQuery(
			"jobs | where status = 'pending' | limit 1 | for update skip locked",
		);
		expect(query.lock).toEqual({
			strength: 'forUpdate',
			waitPolicy: 'skipLocked',
		});
		expect(query.limit).toBe(1);
		expect(query.where).toBeDefined();
	});

	it('lock combined with order by', () => {
		const query = compileQuery('jobs | order by created_at asc | for update');
		expect(query.lock).toEqual({
			strength: 'forUpdate',
			waitPolicy: 'block',
		});
		expect(query.orderBy).toBeDefined();
	});

	// ========================================================================
	// No lock when not specified
	// ========================================================================

	it('no lock when not specified', () => {
		const query = compileQuery('jobs');
		expect(query.lock).toBeUndefined();
	});

	// ========================================================================
	// Case insensitivity
	// ========================================================================

	it('case insensitive: FOR UPDATE SKIP LOCKED', () => {
		const query = compileQuery('jobs | FOR UPDATE SKIP LOCKED');
		expect(query.lock).toEqual({
			strength: 'forUpdate',
			waitPolicy: 'skipLocked',
		});
	});

	it('case insensitive: For Share NoWait', () => {
		const query = compileQuery('jobs | For Share NoWait');
		expect(query.lock).toEqual({
			strength: 'forShare',
			waitPolicy: 'noWait',
		});
	});

	// ========================================================================
	// No conflict with UPDATE mutation
	// ========================================================================

	it('update mutation does not conflict with for update', () => {
		const result = compile(
			"update jobs set status = 'done' where id = 1",
			null,
		);
		expect(result.success).toBe(true);
		// This is a mutation, not a query with lock
		expect(result.ast!.mutation).toBeDefined();
		expect(result.ast!.query).toBeUndefined();
	});
});
