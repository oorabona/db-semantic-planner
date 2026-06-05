/**
 * Regression tests: IN-subquery modifier guard on the mutation
 * (UPDATE / DELETE) path via normalizeToDecision.
 *
 * BACKGROUND
 * ----------
 * compileUpdate and compileDelete bridge a WhereIntent into the compiler
 * via whereIntentAsDecision() (a type-cast, not a real conversion), then pass
 * the result directly into config.where[].  mutation-compiler.ts dispatches
 * those decisions through createWhereDispatcher() → normalizeToDecision().
 *
 * The `case 'in'` branch in normalizeToDecision() previously built the
 * inSubquery Decision by extracting only from/select/where/limit/orderBy from
 * the raw subquery object, silently dropping GROUP BY, HAVING, OFFSET, DISTINCT,
 * joins, include, and invalid projections.  This means a caller that wrote:
 *
 *   orm.delete('users').where(
 *     inSubquery('id', subquery('sessions').select('user_id').groupBy('user_id'))
 *   )
 *
 * would get SQL like `DELETE FROM users WHERE id = ANY(SELECT user_id FROM sessions)`
 * — broader than intended (GROUP BY removed).
 *
 * FIX
 * ---
 * assertNoUnsupportedSubqueryModifiers(sub, 'IN') is now called in
 * normalizeToDecision's `case 'in'` branch before building the Decision.
 * This makes the mutation path fail-closed just like the SELECT/decisions path.
 *
 * TEST STRATEGY
 * -------------
 * - Call adapter.compileUpdate / adapter.compileDelete with raw WhereIntent
 *   objects (kind:'in') that carry forbidden modifiers on their subquery.
 * - Assert each throws with a message matching the existing guard format.
 * - Assert that plain IN subqueries (select/from/where only) still compile.
 * - Assert that IN-with-values (no subquery) still compiles.
 */

import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const adapter = createPgsqlCompileOnlyAdapter();

// ---------------------------------------------------------------------------
// Helpers — build raw WhereIntent objects (bypassing the fluent builder to
// exercise the normalizeToDecision path directly)
// ---------------------------------------------------------------------------

function makeUpdateIntent(subqueryOverrides: Record<string, unknown>) {
	return {
		type: 'update' as const,
		table: 'users',
		set: { name: 'updated' },
		where: {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'sessions',
				select: { type: 'fields' as const, fields: ['user_id'] as const },
				...subqueryOverrides,
			},
		} as any,
	};
}

function makeDeleteIntent(subqueryOverrides: Record<string, unknown>) {
	return {
		type: 'delete' as const,
		table: 'users',
		where: {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'sessions',
				select: { type: 'fields' as const, fields: ['user_id'] as const },
				...subqueryOverrides,
			},
		} as any,
	};
}

// ============================================================================
// UPDATE — forbidden modifiers throw (fail-closed security guard)
// ============================================================================

describe('UPDATE: IN-subquery with dropped modifiers → throws (fail-closed)', () => {
	it('UPDATE with GROUP BY in IN-subquery → throws before compiling', () => {
		const intent = makeUpdateIntent({ groupBy: ['user_id'] });
		expect(() => adapter.compileUpdate(intent)).toThrow(
			/IN subquery with GROUP BY is not supported/,
		);
	});

	it('UPDATE with HAVING in IN-subquery → throws', () => {
		const intent = makeUpdateIntent({
			having: {
				kind: 'comparison',
				field: 'user_id',
				operator: 'gt',
				value: 0,
			},
		});
		expect(() => adapter.compileUpdate(intent)).toThrow(
			/IN subquery with HAVING is not supported/,
		);
	});

	it('UPDATE with GROUP BY + HAVING in IN-subquery → throws', () => {
		const intent = makeUpdateIntent({
			groupBy: ['user_id'],
			having: {
				kind: 'comparison',
				field: 'user_id',
				operator: 'gt',
				value: 1,
			},
		});
		expect(() => adapter.compileUpdate(intent)).toThrow(
			/IN subquery with .* is not supported/,
		);
	});

	it('UPDATE with OFFSET in IN-subquery → throws', () => {
		const intent = makeUpdateIntent({ offset: 5 });
		expect(() => adapter.compileUpdate(intent)).toThrow(
			/IN subquery with OFFSET is not supported/,
		);
	});

	it('UPDATE with DISTINCT in IN-subquery → throws', () => {
		const intent = makeUpdateIntent({ distinct: true });
		expect(() => adapter.compileUpdate(intent)).toThrow(
			/IN subquery with DISTINCT is not supported/,
		);
	});

	it('UPDATE with multi-field projection in IN-subquery → throws (would silently truncate)', () => {
		const intent = {
			type: 'update' as const,
			table: 'users',
			set: { name: 'updated' },
			where: {
				kind: 'in' as const,
				field: 'id',
				subquery: {
					type: 'select' as const,
					from: 'sessions',
					select: {
						type: 'fields' as const,
						fields: ['user_id', 'token'] as const,
					},
				},
			} as any,
		};
		expect(() => adapter.compileUpdate(intent)).toThrow(
			/IN subquery with multi-field projection \[user_id, token\].*is not supported/,
		);
	});

	it('error message tells caller to restructure or use a CTE', () => {
		const intent = makeUpdateIntent({ groupBy: ['user_id'] });
		expect(() => adapter.compileUpdate(intent)).toThrow(
			/restructure the query or use a CTE/,
		);
	});
});

// ============================================================================
// DELETE — forbidden modifiers throw (fail-closed security guard)
// ============================================================================

describe('DELETE: IN-subquery with dropped modifiers → throws (fail-closed)', () => {
	it('DELETE with GROUP BY in IN-subquery → throws before compiling', () => {
		const intent = makeDeleteIntent({ groupBy: ['user_id'] });
		expect(() => adapter.compileDelete(intent)).toThrow(
			/IN subquery with GROUP BY is not supported/,
		);
	});

	it('DELETE with HAVING in IN-subquery → throws', () => {
		const intent = makeDeleteIntent({
			having: {
				kind: 'comparison',
				field: 'user_id',
				operator: 'gt',
				value: 0,
			},
		});
		expect(() => adapter.compileDelete(intent)).toThrow(
			/IN subquery with HAVING is not supported/,
		);
	});

	it('DELETE with OFFSET in IN-subquery → throws', () => {
		const intent = makeDeleteIntent({ offset: 10 });
		expect(() => adapter.compileDelete(intent)).toThrow(
			/IN subquery with OFFSET is not supported/,
		);
	});

	it('DELETE with DISTINCT in IN-subquery → throws', () => {
		const intent = makeDeleteIntent({ distinct: true });
		expect(() => adapter.compileDelete(intent)).toThrow(
			/IN subquery with DISTINCT is not supported/,
		);
	});

	it('DELETE with multi-field projection in IN-subquery → throws (would silently truncate)', () => {
		const intent = {
			type: 'delete' as const,
			table: 'users',
			where: {
				kind: 'in' as const,
				field: 'id',
				subquery: {
					type: 'select' as const,
					from: 'sessions',
					select: {
						type: 'fields' as const,
						fields: ['user_id', 'token'] as const,
					},
				},
			} as any,
		};
		expect(() => adapter.compileDelete(intent)).toThrow(
			/IN subquery with multi-field projection \[user_id, token\].*is not supported/,
		);
	});

	it('error message tells caller to restructure or use a CTE', () => {
		const intent = makeDeleteIntent({ groupBy: ['user_id'] });
		expect(() => adapter.compileDelete(intent)).toThrow(
			/restructure the query or use a CTE/,
		);
	});
});

// ============================================================================
// UPDATE / DELETE — plain IN-subquery still compiles (no false positives)
// ============================================================================

describe('UPDATE / DELETE: plain IN-subquery (select/from/where) still compiles', () => {
	it('UPDATE with plain IN-subquery (no extra modifiers) → compiles correctly', () => {
		const intent = makeUpdateIntent({});
		const result = adapter.compileUpdate(intent);
		expect(result.sql).toMatch(/ANY\s*\(/i);
		expect(result.sql).toMatch(/sessions/i);
	});

	it('UPDATE with IN-subquery + inner WHERE → compiles correctly', () => {
		const intent = makeUpdateIntent({
			where: {
				kind: 'comparison',
				field: 'token',
				operator: 'eq',
				value: 'abc',
			},
		});
		const result = adapter.compileUpdate(intent);
		expect(result.sql).toMatch(/ANY\s*\(/i);
		expect(result.parameters).toContain('abc');
	});

	it('DELETE with plain IN-subquery (no extra modifiers) → compiles correctly', () => {
		const intent = makeDeleteIntent({});
		const result = adapter.compileDelete(intent);
		expect(result.sql).toMatch(/ANY\s*\(/i);
		expect(result.sql).toMatch(/sessions/i);
	});

	it('DELETE with IN-subquery + LIMIT → compiles correctly (LIMIT is propagated)', () => {
		const intent = makeDeleteIntent({ limit: 10 });
		const result = adapter.compileDelete(intent);
		expect(result.sql).toMatch(/ANY\s*\(/i);
		// LIMIT propagates into the subquery
		expect(result.sql).toMatch(/LIMIT/i);
	});
});

// ============================================================================
// UPDATE / DELETE — IN-with-values (no subquery) still compiles (no false positives)
// ============================================================================

describe('UPDATE / DELETE: IN-values (not subquery) still compiles', () => {
	it('UPDATE with IN-values clause → compiles correctly', () => {
		const intent = {
			type: 'update' as const,
			table: 'users',
			set: { name: 'updated' },
			where: {
				kind: 'in' as const,
				field: 'id',
				values: [1, 2, 3],
			} as any,
		};
		const result = adapter.compileUpdate(intent);
		// SET name=$1 consumes the first parameter; the IN-values array is $2
		expect(result.sql).toMatch(/ANY\s*\(\s*\$2/i);
		expect(result.parameters[1]).toEqual([1, 2, 3]);
	});

	it('DELETE with IN-values clause → compiles correctly', () => {
		const intent = {
			type: 'delete' as const,
			table: 'users',
			where: {
				kind: 'in' as const,
				field: 'id',
				values: [10, 20],
			} as any,
		};
		const result = adapter.compileDelete(intent);
		expect(result.sql).toMatch(/ANY\s*\(\s*\$1/i);
		expect(result.parameters[0]).toEqual([10, 20]);
	});
});

// ============================================================================
// Scalar-subquery audit: normalizeToDecision `default` branch for kind:'subquery'
//
// A WhereIntent with kind:'subquery' falls through to `default: return input` in
// normalizeToDecision — it is returned as-is (with operator:'eq' etc., not
// 'scalarSubquery').  This causes the handler lookup to fail loudly ("No WHERE
// handler registered for operator: eq"), which is fail-closed, not fail-open.
// There is no silent modifier-dropping on this path, so no additional guard is
// needed.  This test documents and locks that behavior.
// ============================================================================

describe('scalar-subquery audit: normalizeToDecision default branch is fail-closed', () => {
	it('UPDATE with kind:subquery WHERE → throws loudly (no silent drop)', () => {
		const intent = {
			type: 'update' as const,
			table: 'users',
			set: { name: 'updated' },
			where: {
				kind: 'subquery' as const,
				field: 'id',
				operator: 'eq' as const,
				subquery: {
					type: 'select' as const,
					from: 'sessions',
					select: { type: 'fields' as const, fields: ['user_id'] as const },
					// These modifiers would be silently dropped IF normalizeToDecision
					// processed kind:'subquery' — but it returns input as-is, so the
					// handler lookup fails first.
					groupBy: ['user_id'],
					having: {
						kind: 'comparison',
						field: 'user_id',
						operator: 'gt',
						value: 1,
					},
				},
			} as any,
		};
		// Fails loudly (handler not found or wrong type), never silently drops modifiers.
		expect(() => adapter.compileUpdate(intent)).toThrow();
	});
});
