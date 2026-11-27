/**
 * Regression tests: IN-subquery body modifier refusals and valid bodies,
 * through the public select builder with raw WhereIntent bodies (the public
 * SubqueryBuilder has no groupBy, having, distinct or offset).
 *
 * 1. Forbidden modifiers in an IN-subquery body → NotYetSupportedError.
 * 2. The same refusals in a nested IN body, including under AND/OR/NOT groups.
 * 3. Valid plain IN-subquery bodies compile with their exact SQL and params.
 */

import { createOrm, schema } from '@dbsp/core';
import { NotYetSupportedError, type WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

describe('IN-subquery body with dropped modifiers → throws', () => {
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
});

// ============================================================================
// 2. Nested IN subquery path (mapInSubqueryCondition) — forbidden modifiers → throws
// ============================================================================

describe('nested IN-subquery body — forbidden modifiers → throws', () => {
	/**
	 * Outer IN: orders.customer_id IN (SELECT id FROM customers WHERE id IN subquery)
	 * Inner IN subquery carries a forbidden modifier — must be caught by
	 * mapInSubqueryCondition's guard before producing corrupted SQL.
	 */
	it('nested IN subquery with GROUP BY → throws', () => {
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

describe('valid IN-subquery body still compiles (no false positives)', () => {
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

// ============================================================================
// 5. Typeless { fields: [...] } shape — DEFECT 2 guard
// ============================================================================

// ============================================================================
// 6. DEFECT 1 — logical group wrapping in inner WHERE
// ============================================================================

describe('IN subquery with a logical group (AND/OR/NOT) wrapping a child IN — DEFECT 1 recursion guard', () => {
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
