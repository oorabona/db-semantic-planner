/**
 * Regression tests: IN-subquery modifier guard on the compilePlan / PlanCompiler path.
 *
 * BACKGROUND
 * ----------
 * The normalizeToDecision guard (handlers/index.ts) fires only when the raw
 * input carries `kind: 'in'` (WhereIntent format).  When a caller constructs a
 * SimplifiedPlanReport directly and sets `decision.operator = 'in'` with a
 * `decision.subquery` that carries forbidden modifiers (GROUP BY, HAVING,
 * OFFSET, DISTINCT, joins, includes, invalid projections), dispatchWhere
 * (compiler.ts ~515) detects the sub, remaps operator to 'inSubquery', and
 * dispatches the already-normalized HandlerDecision — bypassing normalizeToDecision's
 * `case 'in'` branch entirely (normalizeToDecision short-circuits at
 * `input.column !== undefined → return input`).
 *
 * Similarly, mapInSubqueryCondition (compiler.ts ~581) handles nested IN
 * subqueries (an IN inside another subquery's WHERE) via the same build path
 * and must also be guarded.
 *
 * FIX
 * ---
 * assertNoUnsupportedSubqueryModifiers(sub as unknown as QueryIntent, 'IN') is
 * now called in both dispatchWhere and mapInSubqueryCondition before building
 * the HandlerDecision, mirroring the normalizeToDecision and convertIn guards.
 *
 * TEST STRATEGY
 * -------------
 * 1. compilePlan path (dispatchWhere): directly-constructed SimplifiedPlanReport
 *    with operator:'in' + subquery carrying forbidden modifiers → THROWS.
 * 2. Nested IN subquery path (mapInSubqueryCondition): outer IN subquery whose
 *    inner WHERE is itself an 'in' with a sub-subquery carrying forbidden
 *    modifiers → THROWS.
 * 3. Valid plain IN-subquery (select single field / from / optional where) via
 *    compilePlan → compiles correctly (no false positives).
 * 4. Existing mutation-path and decisions-path behavior is not regressed
 *    (verified by the other guard test files).
 */

import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal SimplifiedPlanReport with an IN-subquery WHERE decision.
 * Extra fields on `subqueryOverrides` simulate a directly-constructed plan
 * that carries forbidden modifiers on the subquery object.
 */
function makePlan(
	subqueryOverrides: Record<string, unknown>,
): SimplifiedPlanReport {
	return {
		rootTable: 'orders',
		decisions: [
			{ type: 'select', column: '*' },
			{
				type: 'where',
				column: 'customer_id',
				operator: 'in',
				subquery: {
					from: 'customers',
					select: 'id',
					...subqueryOverrides,
				} as any,
			},
		],
	};
}

// ============================================================================
// 1. compilePlan path (dispatchWhere) — forbidden modifiers → throws
// ============================================================================

describe('compilePlan: IN-subquery with dropped modifiers → throws (dispatchWhere guard)', () => {
	it('GROUP BY in IN-subquery → throws before producing SQL', () => {
		const plan = makePlan({ groupBy: ['region'] });
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with GROUP BY is not supported/,
		);
	});

	it('HAVING in IN-subquery → throws', () => {
		const plan = makePlan({
			having: { kind: 'comparison', field: 'id', operator: 'gt', value: 0 },
		});
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with HAVING is not supported/,
		);
	});

	it('OFFSET in IN-subquery → throws', () => {
		const plan = makePlan({ offset: 5 });
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with OFFSET is not supported/,
		);
	});

	it('DISTINCT in IN-subquery → throws', () => {
		const plan = makePlan({ distinct: true });
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with DISTINCT is not supported/,
		);
	});

	it('DISTINCT ON in IN-subquery → throws', () => {
		const plan = makePlan({ distinctOn: ['region'] });
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with DISTINCT ON is not supported/,
		);
	});

	it('joins in IN-subquery → throws', () => {
		const plan = makePlan({
			joins: [
				{
					table: 'regions',
					on: { kind: 'comparison', field: 'id', operator: 'eq', value: 1 },
				},
			],
		});
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with joins is not supported/,
		);
	});

	it('include (relation hydration) in IN-subquery → throws', () => {
		const plan = makePlan({ include: [{ relation: 'addresses' }] });
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with include \(relation hydration\) is not supported/,
		);
	});

	it('multi-field projection in IN-subquery → throws (would silently truncate)', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: {
							type: 'fields',
							fields: ['id', 'region'],
						} as any,
					} as any,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with multi-field projection \[id, region\].*is not supported/,
		);
	});

	it('GROUP BY + HAVING combined → throws with both in message', () => {
		const plan = makePlan({
			groupBy: ['region'],
			having: { kind: 'comparison', field: 'id', operator: 'gt', value: 0 },
		});
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with .* is not supported/,
		);
	});

	it('error message tells caller to restructure or use a CTE', () => {
		const plan = makePlan({ groupBy: ['region'] });
		expect(() => compilePlan(plan)).toThrow(
			/restructure the query or use a CTE/,
		);
	});

	it('notIn operator with GROUP BY in subquery → also throws', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'notIn',
					subquery: {
						from: 'customers',
						select: 'id',
						groupBy: ['region'],
					} as any,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with GROUP BY is not supported/,
		);
	});

	it('subquery in decision.value (alternate shape) with GROUP BY → also throws', () => {
		// dispatchWhere also checks decision.value when decision.subquery is absent
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					value: {
						from: 'customers',
						select: 'id',
						groupBy: ['region'],
					} as any,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with GROUP BY is not supported/,
		);
	});
});

// ============================================================================
// 2. Nested IN subquery path (mapInSubqueryCondition) — forbidden modifiers → throws
// ============================================================================

describe('compilePlan: nested IN-subquery (mapInSubqueryCondition) — forbidden modifiers → throws', () => {
	/**
	 * Outer IN: orders.customer_id IN (SELECT id FROM customers WHERE id IN subquery)
	 * Inner IN subquery carries a forbidden modifier — must be caught by
	 * mapInSubqueryCondition's guard before producing corrupted SQL.
	 */
	it('nested IN subquery with GROUP BY → throws (mapInSubqueryCondition guard)', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: 'id',
						// Inner WHERE is itself an IN subquery with a forbidden modifier
						where: {
							type: 'where',
							column: 'id',
							operator: 'in',
							subquery: {
								from: 'preferred',
								select: 'customer_id',
								// The forbidden modifier that must be caught
								groupBy: ['tier'],
							},
						} as any,
					} as any,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with GROUP BY is not supported/,
		);
	});

	it('nested IN subquery with HAVING → throws', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: 'id',
						where: {
							type: 'where',
							column: 'id',
							operator: 'in',
							subquery: {
								from: 'preferred',
								select: 'customer_id',
								having: {
									kind: 'comparison',
									field: 'id',
									operator: 'gt',
									value: 0,
								},
							},
						} as any,
					} as any,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with HAVING is not supported/,
		);
	});

	it('nested IN subquery with DISTINCT → throws', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: 'id',
						where: {
							type: 'where',
							column: 'id',
							operator: 'in',
							subquery: {
								from: 'preferred',
								select: 'customer_id',
								distinct: true,
							},
						} as any,
					} as any,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with DISTINCT is not supported/,
		);
	});

	it('nested IN subquery error message tells caller to restructure or use a CTE', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: 'id',
						where: {
							type: 'where',
							column: 'id',
							operator: 'in',
							subquery: {
								from: 'preferred',
								select: 'customer_id',
								groupBy: ['tier'],
							},
						} as any,
					} as any,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/restructure the query or use a CTE/,
		);
	});
});

// ============================================================================
// 3. Valid IN-subquery via compilePlan → compiles correctly (no false positives)
// ============================================================================

describe('compilePlan: valid IN-subquery still compiles (no false positives)', () => {
	it('plain IN-subquery (select/from only) → produces ANY subquery SQL', () => {
		const plan = makePlan({});
		const result = compilePlan(plan);
		expect(normalizeSQL(result.sql)).toContain('= any');
		expect(normalizeSQL(result.sql)).toContain('customers');
	});

	it('IN-subquery with inner WHERE → compiles correctly', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: 'id',
						where: {
							type: 'where',
							column: 'active',
							operator: '=',
							value: true,
							table: 'customers',
						},
					},
				},
			],
		};
		const result = compilePlan(plan);
		expect(normalizeSQL(result.sql)).toContain('= any');
		expect(normalizeSQL(result.sql)).toContain('customers');
	});

	it('IN-subquery with LIMIT → compiles correctly (LIMIT is supported)', () => {
		const plan = makePlan({ limit: 10 });
		const result = compilePlan(plan);
		expect(normalizeSQL(result.sql)).toContain('= any');
		expect(normalizeSQL(result.sql)).toMatch(/limit/i);
	});

	it('IN-subquery with single-field orderBy → compiles correctly (field ORDER BY is supported)', () => {
		const plan = makePlan({ orderBy: [{ field: 'id', direction: 'asc' }] });
		const result = compilePlan(plan);
		expect(normalizeSQL(result.sql)).toContain('= any');
	});

	it('NOT IN subquery (plain) → compiles to <> all subquery', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'notIn',
					subquery: { from: 'blocked', select: 'id' },
				},
			],
		};
		const result = compilePlan(plan);
		expect(normalizeSQL(result.sql)).toContain('<> all');
		expect(normalizeSQL(result.sql)).toContain('blocked');
	});

	it('valid nested IN (inner subquery plain, no modifiers) → compiles correctly', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: 'id',
						where: {
							type: 'where',
							column: 'id',
							operator: 'in',
							subquery: {
								from: 'preferred',
								select: 'customer_id',
								// No forbidden modifiers — valid
							},
						} as any,
					} as any,
				},
			],
		};
		const result = compilePlan(plan);
		expect(normalizeSQL(result.sql)).toContain('= any');
		expect(normalizeSQL(result.sql)).toContain('preferred');
	});
});

// ============================================================================
// 4. Nested IN with subquery in `value` (not `subquery`) — DEFECT 1 guard
// ============================================================================

describe('compilePlan: nested IN with subquery in pd.value — mapInSubqueryCondition guard', () => {
	/**
	 * Outer IN uses `subquery` (normal shape).
	 * Inner WHERE uses `value` instead of `subquery` to carry the nested subquery
	 * (the shape the plan-decision-extractor produces).
	 * The inner value-shape subquery carries GROUP BY — must be caught.
	 */
	it('nested IN with value-shape subquery carrying GROUP BY → throws', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: 'id',
						where: {
							type: 'where',
							column: 'id',
							operator: 'in',
							// value-shape: subquery in `value`, not `subquery`
							value: {
								from: 'preferred',
								select: 'customer_id',
								groupBy: ['tier'],
							},
						} as any,
					} as any,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with GROUP BY is not supported/,
		);
	});

	it('nested IN with value-shape subquery carrying HAVING → throws', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: 'id',
						where: {
							type: 'where',
							column: 'id',
							operator: 'in',
							value: {
								from: 'preferred',
								select: 'customer_id',
								having: {
									kind: 'comparison',
									field: 'count',
									operator: 'gt',
									value: 0,
								},
							},
						} as any,
					} as any,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with HAVING is not supported/,
		);
	});

	it('nested IN with value-shape subquery carrying OFFSET → throws', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: 'id',
						where: {
							type: 'where',
							column: 'id',
							operator: 'in',
							value: {
								from: 'preferred',
								select: 'customer_id',
								offset: 5,
							},
						} as any,
					} as any,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with OFFSET is not supported/,
		);
	});

	it('nested IN with value-shape subquery carrying DISTINCT → throws', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: 'id',
						where: {
							type: 'where',
							column: 'id',
							operator: 'in',
							value: {
								from: 'preferred',
								select: 'customer_id',
								distinct: true,
							},
						} as any,
					} as any,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with DISTINCT is not supported/,
		);
	});

	it('nested IN with value-shape plain subquery (no modifiers) → compiles as real subquery, NOT bound param', () => {
		// This is the primary regression test for DEFECT 1:
		// a value-shape nested IN with a valid plain subquery must compile to
		// a real IN (SELECT ...) subquery, NOT bind the object as a $n parameter.
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: 'id',
						where: {
							type: 'where',
							column: 'id',
							operator: 'in',
							// value-shape: plain subquery (valid — no forbidden modifiers)
							value: {
								from: 'preferred',
								select: 'customer_id',
							},
						} as any,
					} as any,
				},
			],
		};
		const result = compilePlan(plan);
		// Must contain the inner table name (proves the subquery was compiled, not bound)
		expect(normalizeSQL(result.sql)).toContain('preferred');
		// The outer IN subquery must be present
		expect(normalizeSQL(result.sql)).toContain('= any');
		// No parameter should be a subquery object (the inner subquery must not appear in params)
		for (const p of result.parameters) {
			const isSubqueryObject =
				p !== null &&
				typeof p === 'object' &&
				!Array.isArray(p) &&
				'from' in (p as object);
			expect(isSubqueryObject).toBe(false);
		}
	});
});

// ============================================================================
// 5. Typeless { fields: [...] } shape — DEFECT 2 guard
// ============================================================================

describe('compilePlan: typeless { fields: [...] } select shape — assertNoUnsupportedSubqueryModifiers guard', () => {
	it('typeless multi-field select { fields: ["id", "region"] } → throws', () => {
		// Previously: assertNoUnsupportedSubqueryModifiers only checked select.type === 'fields'.
		// A typeless { fields: ['id', 'region'] } (no `type` property) silently slipped through
		// and the compiler truncated to fields[0], producing wrong SQL.
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: { fields: ['id', 'region'] } as any, // typeless, no `type`
					} as any,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with multi-field projection \[id, region\].*is not supported/,
		);
	});

	it('typeless single-field select { fields: ["id"] } → compiles correctly', () => {
		// Single-field typeless shape is valid and must not be rejected.
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: { fields: ['id'] } as any, // typeless, no `type`, single field
					} as any,
				},
			],
		};
		const result = compilePlan(plan);
		expect(normalizeSQL(result.sql)).toContain('= any');
		expect(normalizeSQL(result.sql)).toContain('customers');
	});

	it('typed { type: "fields", fields: ["id", "region"] } still throws (no regression)', () => {
		// Existing behaviour: typed multi-field must still be caught.
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: { type: 'fields', fields: ['id', 'region'] } as any,
					} as any,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with multi-field projection \[id, region\].*is not supported/,
		);
	});

	it('typeless { fields: undefined } select → throws (undefined fields key present)', () => {
		// { fields: undefined } has the key present — isSelectWithFields in the compiler
		// matches it and falls back to '*', producing invalid ANY(*) SQL.
		// assertNoUnsupportedSubqueryModifiers must catch it.
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: { fields: undefined } as any,
					} as any,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with empty fields list.*is not supported/,
		);
	});

	it('typeless { fields: [] } select → throws (empty array)', () => {
		// Empty array also triggers the '*' fallback — must be rejected.
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: { fields: [] } as any,
					} as any,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with empty fields list.*is not supported/,
		);
	});

	it('typeless { fields: ["id"] } select → compiles correctly (single field, no type key)', () => {
		// A single-field typeless shape must be accepted — it is valid.
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: { fields: ['id'] } as any,
					} as any,
				},
			],
		};
		const result = compilePlan(plan);
		expect(normalizeSQL(result.sql)).toContain('= any');
		expect(normalizeSQL(result.sql)).toContain('customers');
	});
});

// ============================================================================
// 6. DEFECT 1 — logical group wrapping in inner WHERE
// ============================================================================

describe('compilePlan: IN subquery with logical group (whereAnd/whereOr) wrapping child IN — DEFECT 1 recursion guard', () => {
	/**
	 * Outer IN subquery's `where` is a whereAnd group. One child of the group is
	 * itself an IN-subquery carrying a forbidden modifier (GROUP BY).
	 * mapInSubqueryCondition must recurse into the group's children and fire the
	 * guard, rather than letting mapToHandlerDecision silently drop the subquery
	 * and fall through to the plain-in handler.
	 */
	it('outer IN whose inner WHERE is whereAnd( eq, in+groupBy ) → throws', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: 'id',
						// inner WHERE is a logical AND group, one child carries GROUP BY
						where: {
							type: 'whereAnd',
							conditions: [
								{
									type: 'where',
									column: 'active',
									operator: '=',
									value: true,
									table: 'customers',
								},
								{
									type: 'where',
									column: 'id',
									operator: 'in',
									subquery: {
										from: 'preferred',
										select: 'customer_id',
										groupBy: ['tier'], // forbidden modifier — must be caught
									},
								},
							],
						} as any,
					} as any,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with GROUP BY is not supported/,
		);
	});

	it('outer IN whose inner WHERE is whereOr( eq, in+having ) → throws', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: 'id',
						where: {
							type: 'whereOr',
							conditions: [
								{
									type: 'where',
									column: 'region',
									operator: '=',
									value: 'EU',
									table: 'customers',
								},
								{
									type: 'where',
									column: 'id',
									operator: 'in',
									subquery: {
										from: 'preferred',
										select: 'customer_id',
										having: {
											kind: 'comparison',
											field: 'id',
											operator: 'gt',
											value: 0,
										},
									},
								},
							],
						} as any,
					} as any,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with HAVING is not supported/,
		);
	});

	it('outer IN whose inner WHERE is whereAnd( eq, in+plain ) → compiles correctly (no false positive)', () => {
		// A logical group whose IN-subquery child is valid (no forbidden modifiers)
		// must compile without error and produce correct SQL.
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: 'id',
						where: {
							type: 'whereAnd',
							conditions: [
								{
									type: 'where',
									column: 'active',
									operator: '=',
									value: true,
									table: 'customers',
								},
								{
									type: 'where',
									column: 'id',
									operator: 'in',
									subquery: {
										from: 'preferred',
										select: 'customer_id',
										// No forbidden modifiers — valid plain subquery
									},
								},
							],
						} as any,
					} as any,
				},
			],
		};
		const result = compilePlan(plan);
		expect(normalizeSQL(result.sql)).toContain('= any');
		expect(normalizeSQL(result.sql)).toContain('preferred');
	});

	it('outer IN whose inner WHERE is whereNot wrapping in+distinct → throws', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: 'id',
						where: {
							type: 'whereNot',
							conditions: [
								{
									type: 'where',
									column: 'id',
									operator: 'in',
									subquery: {
										from: 'preferred',
										select: 'customer_id',
										distinct: true, // forbidden
									},
								},
							],
						} as any,
					} as any,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with DISTINCT is not supported/,
		);
	});
});
