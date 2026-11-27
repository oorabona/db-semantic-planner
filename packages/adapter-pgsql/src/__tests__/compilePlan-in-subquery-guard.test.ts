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

import {
	compilePlan,
	type SimplifiedPlanReport,
} from '@dbsp/adapter-pgsql/internal';
import { createOrm, schema } from '@dbsp/core';
import { NotYetSupportedError, type WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

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

// ---------------------------------------------------------------------------
// Public entry: the ORM carries the model and compiles through the adapter
// ---------------------------------------------------------------------------

const db = schema({
	orders: {
		id: { type: 'integer', primaryKey: true },
		customer_id: { type: 'integer' },
	},
	customers: {
		id: { type: 'integer', primaryKey: true },
		active: { type: 'boolean' },
		region: { type: 'text' },
	},
});
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});

/** An IN-subquery body over `customers` projecting `id`, plus extra modifiers. */
function inBody(extra: Record<string, unknown> = {}) {
	return {
		type: 'select' as const,
		from: 'customers',
		select: { type: 'fields' as const, fields: ['id'] as const },
		...extra,
	};
}

/** `orders.customer_id IN (<body>)` as a WhereIntent, through the public ORM. */
function dumpIn(body: Record<string, unknown>, not = false) {
	const where = {
		kind: 'in' as const,
		...(not ? { not: true } : {}),
		field: 'customer_id',
		subquery: body,
	} as unknown as WhereIntent;
	const { sql, params } = orm.select('orders').where(where).dump();
	return { sql, params };
}

const groupByRegion = { groupBy: ['region'] };
const havingIdGtZero = {
	having: { kind: 'comparison', field: 'id', operator: 'gt', value: 0 },
};
const inRefusal = (modifier: string) =>
	new NotYetSupportedError(modifier, 'IN subquery body', 1087);

// ============================================================================
// 1. compilePlan path (dispatchWhere) — forbidden modifiers → throws
// ============================================================================

describe('compilePlan: IN-subquery with dropped modifiers → throws (dispatchWhere guard)', () => {
	it('OFFSET in IN-subquery → throws', () => {
		expect(() => dumpIn(inBody({ offset: 5 }))).toThrow(inRefusal('OFFSET'));
	});

	it('DISTINCT in IN-subquery → throws', () => {
		expect(() => dumpIn(inBody({ distinct: true }))).toThrow(
			inRefusal('DISTINCT'),
		);
	});

	it('the refusal is a NotYetSupportedError', () => {
		expect(() => dumpIn(inBody(groupByRegion))).toThrow(NotYetSupportedError);
		expect(() => dumpIn(inBody(groupByRegion))).toThrow(
			new NotYetSupportedError('GROUP BY', 'IN subquery body', 1087),
		);
	});

	it('notIn operator with GROUP BY in subquery → also throws', () => {
		expect(() => dumpIn(inBody(groupByRegion), true)).toThrow(
			inRefusal('GROUP BY'),
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
			/GROUP BY in an IN subquery body is not supported yet \(#1087\)/,
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
		expect(() =>
			dumpIn(
				inBody({
					where: { kind: 'in', field: 'id', subquery: inBody(groupByRegion) },
				}),
			),
		).toThrow(inRefusal('GROUP BY'));
	});

	it('nested IN subquery with HAVING → throws', () => {
		expect(() =>
			dumpIn(
				inBody({
					where: { kind: 'in', field: 'id', subquery: inBody(havingIdGtZero) },
				}),
			),
		).toThrow(inRefusal('HAVING'));
	});

	it('nested IN subquery with DISTINCT → throws', () => {
		expect(() =>
			dumpIn(
				inBody({
					where: {
						kind: 'in',
						field: 'id',
						subquery: inBody({ distinct: true }),
					},
				}),
			),
		).toThrow(inRefusal('DISTINCT'));
	});

	it('nested IN subquery refusal is a NotYetSupportedError', () => {
		const nestedGroupBy = () =>
			dumpIn(
				inBody({
					where: { kind: 'in', field: 'id', subquery: inBody(groupByRegion) },
				}),
			);
		expect(nestedGroupBy).toThrow(NotYetSupportedError);
		expect(nestedGroupBy).toThrow(
			new NotYetSupportedError('GROUP BY', 'IN subquery body', 1087),
		);
	});
});

// ============================================================================
// 3. Valid IN-subquery via compilePlan → compiles correctly (no false positives)
// ============================================================================

describe('compilePlan: valid IN-subquery still compiles (no false positives)', () => {
	it('IN-subquery with inner WHERE → compiles correctly', () => {
		expect(
			dumpIn(
				inBody({
					where: {
						kind: 'comparison',
						field: 'active',
						operator: 'eq',
						value: true,
					},
				}),
			),
		).toEqual({
			sql: 'SELECT orders.* FROM orders WHERE orders.customer_id = ANY (SELECT customers_subq_0.id FROM customers AS customers_subq_0 WHERE customers_subq_0.active = $1)',
			params: [true],
		});
	});

	it('IN-subquery with LIMIT → compiles correctly (LIMIT is supported)', () => {
		expect(dumpIn(inBody({ limit: 10 }))).toEqual({
			sql: 'SELECT orders.* FROM orders WHERE orders.customer_id = ANY (SELECT customers_subq_0.id FROM customers AS customers_subq_0 LIMIT 10)',
			params: [],
		});
	});

	it('IN-subquery with single-field orderBy → compiles correctly (field ORDER BY is supported)', () => {
		expect(
			dumpIn(inBody({ orderBy: [{ field: 'id', direction: 'asc' }] })),
		).toEqual({
			sql: 'SELECT orders.* FROM orders WHERE orders.customer_id = ANY (SELECT customers_subq_0.id FROM customers AS customers_subq_0 ORDER BY customers_subq_0.id ASC)',
			params: [],
		});
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
		expect(
			dumpIn(
				inBody({ where: { kind: 'in', field: 'id', subquery: inBody() } }),
			),
		).toEqual({
			sql: 'SELECT orders.* FROM orders WHERE orders.customer_id = ANY (SELECT customers_subq_0.id FROM customers AS customers_subq_0 WHERE customers_subq_0.id = ANY (SELECT customers_subq_1.id FROM customers AS customers_subq_1))',
			params: [],
		});
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
			/GROUP BY in an IN subquery body is not supported yet \(#1087\)/,
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
			/HAVING in an IN subquery body is not supported yet \(#1087\)/,
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
			/OFFSET in an IN subquery body is not supported yet \(#1087\)/,
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
			/DISTINCT in an IN subquery body is not supported yet \(#1087\)/,
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
	it('outer IN whose inner WHERE is an AND of eq and in+groupBy → throws', () => {
		expect(() =>
			dumpIn(
				inBody({
					where: {
						kind: 'and',
						conditions: [
							{
								kind: 'comparison',
								field: 'active',
								operator: 'eq',
								value: true,
							},
							{ kind: 'in', field: 'id', subquery: inBody(groupByRegion) },
						],
					},
				}),
			),
		).toThrow(inRefusal('GROUP BY'));
	});

	it('outer IN whose inner WHERE is an OR of eq and in+having → throws', () => {
		expect(() =>
			dumpIn(
				inBody({
					where: {
						kind: 'or',
						conditions: [
							{
								kind: 'comparison',
								field: 'active',
								operator: 'eq',
								value: true,
							},
							{ kind: 'in', field: 'id', subquery: inBody(havingIdGtZero) },
						],
					},
				}),
			),
		).toThrow(inRefusal('HAVING'));
	});

	it('outer IN whose inner WHERE is an AND of eq and in+plain → compiles correctly (no false positive)', () => {
		// A logical group whose IN-subquery child is valid (no forbidden modifiers)
		// must compile without error and produce correct SQL.
		expect(
			dumpIn(
				inBody({
					where: {
						kind: 'and',
						conditions: [
							{
								kind: 'comparison',
								field: 'active',
								operator: 'eq',
								value: true,
							},
							{ kind: 'in', field: 'id', subquery: inBody() },
						],
					},
				}),
			),
		).toEqual({
			sql: 'SELECT orders.* FROM orders WHERE orders.customer_id = ANY (SELECT customers_subq_0.id FROM customers AS customers_subq_0 WHERE customers_subq_0.active = $1 AND customers_subq_0.id = ANY (SELECT customers_subq_1.id FROM customers AS customers_subq_1))',
			params: [true],
		});
	});

	it('outer IN whose inner WHERE is a NOT wrapping in+distinct → throws', () => {
		expect(() =>
			dumpIn(
				inBody({
					where: {
						kind: 'not',
						condition: {
							kind: 'in',
							field: 'id',
							subquery: inBody({ distinct: true }),
						},
					},
				}),
			),
		).toThrow(inRefusal('DISTINCT'));
	});
});
