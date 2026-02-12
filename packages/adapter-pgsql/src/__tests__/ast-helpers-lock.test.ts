/**
 * AST Helpers — Locking clause tests (E15)
 *
 * Tests selectStmt() with lockingClause and mapLockToAst() mapping helper.
 */

import { deparseSync } from 'pgsql-deparser';
import { describe, expect, it } from 'vitest';

import {
	columnRef,
	eqExpr,
	integerNode,
	mapLockToAst,
	normalizeSQL,
	rangeVar,
	selectStmt,
	starTarget,
} from '../ast-helpers.js';
import { createParamRef } from '../param-ref.js';

/** Deparse + normalize for consistent comparisons. */
function sql(node: ReturnType<typeof selectStmt>): string {
	return normalizeSQL(deparseSync([node]));
}

// ============================================================================
// mapLockToAst — domain → AST mapping
// ============================================================================

describe('mapLockToAst', () => {
	it('maps forUpdate + block', () => {
		const result = mapLockToAst({
			strength: 'forUpdate',
			waitPolicy: 'block',
		});
		expect(result.strength).toBe('LCS_FORUPDATE');
		expect(result.waitPolicy).toBe('LockWaitBlock');
	});

	it('maps forShare + skipLocked', () => {
		const result = mapLockToAst({
			strength: 'forShare',
			waitPolicy: 'skipLocked',
		});
		expect(result.strength).toBe('LCS_FORSHARE');
		expect(result.waitPolicy).toBe('LockWaitSkip');
	});

	it('maps forNoKeyUpdate + noWait', () => {
		const result = mapLockToAst({
			strength: 'forNoKeyUpdate',
			waitPolicy: 'noWait',
		});
		expect(result.strength).toBe('LCS_FORNOKEYUPDATE');
		expect(result.waitPolicy).toBe('LockWaitError');
	});

	it('maps forKeyShare + block', () => {
		const result = mapLockToAst({
			strength: 'forKeyShare',
			waitPolicy: 'block',
		});
		expect(result.strength).toBe('LCS_FORKEYSHARE');
		expect(result.waitPolicy).toBe('LockWaitBlock');
	});
});

// ============================================================================
// selectStmt with lockingClause — deparse tests
// ============================================================================

describe('selectStmt with lockingClause', () => {
	it('emits FOR UPDATE', () => {
		const stmt = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('jobs')],
			lockingClause: {
				strength: 'LCS_FORUPDATE',
				waitPolicy: 'LockWaitBlock',
			},
		});
		expect(sql(stmt)).toBe('select * from jobs for update');
	});

	it('emits FOR UPDATE SKIP LOCKED', () => {
		const stmt = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('jobs')],
			lockingClause: {
				strength: 'LCS_FORUPDATE',
				waitPolicy: 'LockWaitSkip',
			},
		});
		expect(sql(stmt)).toBe('select * from jobs for update skip locked');
	});

	it('emits FOR UPDATE NOWAIT', () => {
		const stmt = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('jobs')],
			lockingClause: {
				strength: 'LCS_FORUPDATE',
				waitPolicy: 'LockWaitError',
			},
		});
		expect(sql(stmt)).toBe('select * from jobs for update nowait');
	});

	it('emits FOR SHARE', () => {
		const stmt = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('jobs')],
			lockingClause: {
				strength: 'LCS_FORSHARE',
			},
		});
		expect(sql(stmt)).toBe('select * from jobs for share');
	});

	it('emits FOR SHARE NOWAIT', () => {
		const stmt = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('jobs')],
			lockingClause: {
				strength: 'LCS_FORSHARE',
				waitPolicy: 'LockWaitError',
			},
		});
		expect(sql(stmt)).toBe('select * from jobs for share nowait');
	});

	it('emits FOR NO KEY UPDATE', () => {
		const stmt = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('jobs')],
			lockingClause: {
				strength: 'LCS_FORNOKEYUPDATE',
			},
		});
		expect(sql(stmt)).toBe('select * from jobs for no key update');
	});

	it('emits FOR KEY SHARE SKIP LOCKED', () => {
		const stmt = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('jobs')],
			lockingClause: {
				strength: 'LCS_FORKEYSHARE',
				waitPolicy: 'LockWaitSkip',
			},
		});
		expect(sql(stmt)).toBe('select * from jobs for key share skip locked');
	});

	it('emits FOR UPDATE OF table (scoped locking)', () => {
		const stmt = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('orders')],
			lockingClause: {
				strength: 'LCS_FORUPDATE',
				waitPolicy: 'LockWaitBlock',
				lockedRels: [rangeVar('orders')],
			},
		});
		expect(sql(stmt)).toBe('select * from orders for update of orders');
	});

	it('works with WHERE and LIMIT', () => {
		const stmt = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('jobs')],
			where: eqExpr(columnRef('status'), createParamRef(1)),
			limit: integerNode(1),
			lockingClause: {
				strength: 'LCS_FORUPDATE',
				waitPolicy: 'LockWaitSkip',
			},
		});
		const result = sql(stmt);
		expect(result).toContain('for update skip locked');
		expect(result).toContain('where');
		expect(result).toContain('limit');
	});

	it('default waitPolicy is LockWaitBlock when omitted', () => {
		const stmt = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('jobs')],
			lockingClause: {
				strength: 'LCS_FORUPDATE',
			},
		});
		// No SKIP LOCKED or NOWAIT suffix — default block behavior
		expect(sql(stmt)).toBe('select * from jobs for update');
	});

	it('mapLockToAst integrates with selectStmt', () => {
		const mapped = mapLockToAst({
			strength: 'forUpdate',
			waitPolicy: 'skipLocked',
		});
		const stmt = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('jobs')],
			lockingClause: mapped,
		});
		expect(sql(stmt)).toBe('select * from jobs for update skip locked');
	});
});
