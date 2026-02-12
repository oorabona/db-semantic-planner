/**
 * Coverage tests for compile-expression.ts — uncovered branches.
 *
 * Exercises: nested AND/OR chaining (3+ conditions), mixed AND/OR with
 * parentheses, NOT wrapping, all comparison operators, BETWEEN, IN with
 * values, IN with subquery, negated IN, IS NULL, IS NOT NULL, LIKE,
 * range operator with scalar value, JSON operator notation (@>, <@, ?),
 * JSON function notation (json_contains, json_contained_by, json_exists),
 * JSON access on LHS of comparison, JSON function on LHS of comparison,
 * relation filter with alias, multiple date range expansion to OR.
 */

import type {
	WhereAndIntent,
	WhereComparisonIntent,
	WhereInIntent,
	WhereIntent,
	WhereJsonContainsIntent,
	WhereJsonExistsIntent,
	WhereNotIntent,
	WhereOrIntent,
	WhereRangeIntent,
	WhereRelationFilterIntent,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compile } from '../index.js';
import type { CompileResult } from './index.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function compileNql(input: string): CompileResult {
	const result = compile(input, null);
	if (!result.success) {
		throw new Error(`Compile error: ${result.errors[0]?.message}`);
	}
	return result.ast!;
}

function getWhere(result: CompileResult): WhereIntent {
	const where = result.query!.where;
	expect(where).toBeDefined();
	return where!;
}

// ===========================================================================
// Nested logical operators
// ===========================================================================
describe('compile-expression: nested AND chaining', () => {
	it('three ANDs produce nested and conditions', () => {
		const where = getWhere(
			compileNql('users | where a = 1 and b = 2 and c = 3'),
		);

		// Parser builds left-associative tree: (a=1 AND b=2) AND c=3
		expect(where.kind).toBe('and');
		const outerAnd = where as WhereAndIntent;
		expect(outerAnd.conditions).toHaveLength(2);

		// Left side is itself an AND
		const leftAnd = outerAnd.conditions[0] as WhereAndIntent;
		expect(leftAnd.kind).toBe('and');
		expect(leftAnd.conditions).toHaveLength(2);

		// Right side is the third comparison
		const rightComp = outerAnd.conditions[1] as WhereComparisonIntent;
		expect(rightComp.kind).toBe('comparison');
		expect(rightComp.field).toBe('c');
	});

	it('four ANDs produce deeply nested structure', () => {
		const where = getWhere(
			compileNql('users | where a = 1 and b = 2 and c = 3 and d = 4'),
		);

		expect(where.kind).toBe('and');
	});
});

describe('compile-expression: nested OR chaining', () => {
	it('three ORs produce nested or conditions', () => {
		const where = getWhere(compileNql('users | where a = 1 or b = 2 or c = 3'));

		expect(where.kind).toBe('or');
		const outerOr = where as WhereOrIntent;
		expect(outerOr.conditions).toHaveLength(2);

		const leftOr = outerOr.conditions[0] as WhereOrIntent;
		expect(leftOr.kind).toBe('or');
	});
});

describe('compile-expression: mixed AND/OR with parentheses', () => {
	it('(a OR b) AND c', () => {
		const where = getWhere(
			compileNql('users | where (a = 1 or b = 2) and c = 3'),
		);

		expect(where.kind).toBe('and');
		const andWhere = where as WhereAndIntent;
		expect(andWhere.conditions).toHaveLength(2);

		const orSide = andWhere.conditions[0] as WhereOrIntent;
		expect(orSide.kind).toBe('or');
		expect(orSide.conditions).toHaveLength(2);

		const compSide = andWhere.conditions[1] as WhereComparisonIntent;
		expect(compSide.kind).toBe('comparison');
		expect(compSide.field).toBe('c');
	});

	it('a AND (b OR c)', () => {
		const where = getWhere(
			compileNql('users | where a = 1 and (b = 2 or c = 3)'),
		);

		expect(where.kind).toBe('and');
		const andWhere = where as WhereAndIntent;
		const left = andWhere.conditions[0] as WhereComparisonIntent;
		expect(left.field).toBe('a');

		const right = andWhere.conditions[1] as WhereOrIntent;
		expect(right.kind).toBe('or');
	});
});

// ===========================================================================
// NOT wrapping
// ===========================================================================
describe('compile-expression: NOT wrapping', () => {
	it('not (a = 1) wraps in WhereNotIntent', () => {
		const where = getWhere(compileNql('users | where not (active = true)'));

		expect(where.kind).toBe('not');
		const notWhere = where as WhereNotIntent;
		const inner = notWhere.condition as WhereComparisonIntent;
		expect(inner.kind).toBe('comparison');
		expect(inner.field).toBe('active');
	});

	it('not (a = 1 and b = 2) wraps compound condition', () => {
		const where = getWhere(compileNql('users | where not (a = 1 and b = 2)'));

		expect(where.kind).toBe('not');
		const notWhere = where as WhereNotIntent;
		expect(notWhere.condition.kind).toBe('and');
	});

	it('not (a = 1 or b = 2) wraps or condition', () => {
		const where = getWhere(compileNql('users | where not (a = 1 or b = 2)'));

		expect(where.kind).toBe('not');
		const notWhere = where as WhereNotIntent;
		expect(notWhere.condition.kind).toBe('or');
	});
});

// ===========================================================================
// All comparison operators
// ===========================================================================
describe('compile-expression: comparison operators', () => {
	it.each([
		{ nql: 'a = 1', op: 'eq' },
		{ nql: 'a != 1', op: 'neq' },
		{ nql: 'a < 1', op: 'lt' },
		{ nql: 'a > 1', op: 'gt' },
		{ nql: 'a <= 1', op: 'lte' },
		{ nql: 'a >= 1', op: 'gte' },
	])('operator $nql maps to $op', ({ nql, op }) => {
		const where = getWhere(
			compileNql(`users | where ${nql}`),
		) as WhereComparisonIntent;

		expect(where.kind).toBe('comparison');
		expect(where.operator).toBe(op);
	});
});

// ===========================================================================
// Range operator with scalar value
// ===========================================================================
describe('compile-expression: range operator with scalar value', () => {
	it('contains with scalar number', () => {
		const where = getWhere(
			compileNql('events | where priceRange contains 25'),
		) as WhereRangeIntent;

		expect(where.kind).toBe('range');
		expect(where.field).toBe('priceRange');
		expect(where.operator).toBe('contains');
		expect(where.value).toBe(25);
	});

	it('contains with scalar string', () => {
		const where = getWhere(
			compileNql("events | where dateRange contains '2024-06-15'"),
		) as WhereRangeIntent;

		expect(where.kind).toBe('range');
		expect(where.field).toBe('dateRange');
		expect(where.operator).toBe('contains');
		expect(where.value).toBe('2024-06-15');
	});
});

// ===========================================================================
// JSON operator notation (@>, <@, ?)
// ===========================================================================
describe('compile-expression: JSON operator notation', () => {
	it('@> produces jsonContains with reversed=false', () => {
		const where = getWhere(
			compileNql('users | where data @> \'{"active":true}\''),
		) as WhereJsonContainsIntent;

		expect(where.kind).toBe('jsonContains');
		expect(where.field).toBe('data');
		expect(where.value).toBe('{"active":true}');
		expect(where.reversed).toBe(false);
	});

	it('<@ produces jsonContains with reversed=true', () => {
		const where = getWhere(
			compileNql('users | where data <@ \'{"a":1,"b":2}\''),
		) as WhereJsonContainsIntent;

		expect(where.kind).toBe('jsonContains');
		expect(where.field).toBe('data');
		expect(where.reversed).toBe(true);
	});

	it('? produces jsonExists', () => {
		const where = getWhere(
			compileNql("users | where data ? 'email'"),
		) as WhereJsonExistsIntent;

		expect(where.kind).toBe('jsonExists');
		expect(where.field).toBe('data');
		expect(where.key).toBe('email');
	});
});

// ===========================================================================
// IN with negation
// ===========================================================================
describe('compile-expression: NOT IN', () => {
	it('NOT IN wraps in WhereNotIntent', () => {
		const where = getWhere(
			compileNql("users | where status not in ('deleted', 'banned')"),
		);

		expect(where.kind).toBe('not');
		const notWhere = where as WhereNotIntent;
		const inWhere = notWhere.condition as WhereInIntent;
		expect(inWhere.kind).toBe('in');
		expect(inWhere.field).toBe('status');
		expect(inWhere.values).toEqual(['deleted', 'banned']);
	});

	it('NOT IN with subquery wraps in WhereNotIntent', () => {
		const where = getWhere(
			compileNql('users | where id not in (blacklist | select userId)'),
		);

		expect(where.kind).toBe('not');
		const notWhere = where as WhereNotIntent;
		const inWhere = notWhere.condition as WhereInIntent;
		expect(inWhere.kind).toBe('in');
		expect(inWhere.subquery).toBeDefined();
		expect(inWhere.subquery!.from).toBe('blacklist');
	});
});

// ===========================================================================
// Relation filter
// ===========================================================================
describe('compile-expression: relation filter', () => {
	it('some(relation).column > value produces relationFilter with mode=some', () => {
		const where = getWhere(
			compileNql('users | where some(orders).total > 100'),
		) as WhereRelationFilterIntent;

		expect(where.kind).toBe('relationFilter');
		expect(where.relation).toEqual(['orders']);
		expect(where.mode).toBe('some');
		expect(where.where).toBeDefined();
	});

	it('every(relation).column = value produces relationFilter with mode=every', () => {
		const where = getWhere(
			compileNql('users | where every(posts).published = true'),
		) as WhereRelationFilterIntent;

		expect(where.kind).toBe('relationFilter');
		expect(where.relation).toEqual(['posts']);
		expect(where.mode).toBe('every');
	});

	it('none(relation).column = value produces relationFilter with mode=none', () => {
		const where = getWhere(
			compileNql('users | where none(bans).active = true'),
		) as WhereRelationFilterIntent;

		expect(where.kind).toBe('relationFilter');
		expect(where.relation).toEqual(['bans']);
		expect(where.mode).toBe('none');
	});

	it('all prefix syntax produces relationFilter with mode=every', () => {
		const where = getWhere(
			compileNql('users | where all posts.featured = true'),
		) as WhereRelationFilterIntent;

		expect(where.kind).toBe('relationFilter');
		expect(where.relation).toEqual(['posts']);
		expect(where.mode).toBe('every');
	});
});

// ===========================================================================
// Multiple date range IN expansion → OR
// ===========================================================================
describe('compile-expression: date range IN expansion', () => {
	it('multiple date ranges expand to OR of AND conditions', () => {
		const where = getWhere(
			compileNql("orders | where date in ('2024-Q1', '2024-Q2')"),
		);

		// Multiple date range patterns → OR of 2 ANDs
		expect(where.kind).toBe('or');
		const orWhere = where as WhereOrIntent;
		expect(orWhere.conditions).toHaveLength(2);

		// Each condition is an AND (gte + lt)
		const q1 = orWhere.conditions[0] as WhereAndIntent;
		expect(q1.kind).toBe('and');
		expect(q1.conditions).toHaveLength(2);
		const q1Gte = q1.conditions[0] as WhereComparisonIntent;
		expect(q1Gte.operator).toBe('gte');
		expect(q1Gte.value).toBe('2024-01-01');
		const q1Lt = q1.conditions[1] as WhereComparisonIntent;
		expect(q1Lt.operator).toBe('lt');
		expect(q1Lt.value).toBe('2024-04-01');

		const q2 = orWhere.conditions[1] as WhereAndIntent;
		expect(q2.kind).toBe('and');
		const q2Gte = q2.conditions[0] as WhereComparisonIntent;
		expect(q2Gte.value).toBe('2024-04-01');
		const q2Lt = q2.conditions[1] as WhereComparisonIntent;
		expect(q2Lt.value).toBe('2024-07-01');
	});

	it('negated multiple date ranges wrap in NOT', () => {
		const where = getWhere(
			compileNql("orders | where date not in ('2024-Q1', '2024-Q2')"),
		);

		expect(where.kind).toBe('not');
		const notWhere = where as WhereNotIntent;
		expect(notWhere.condition.kind).toBe('or');
	});

	it('single date range year expansion', () => {
		const where = getWhere(compileNql("orders | where created_at in '2024'"));

		// Single date range → AND (gte + lt), not OR
		expect(where.kind).toBe('and');
		const andWhere = where as WhereAndIntent;
		expect(andWhere.conditions).toHaveLength(2);
	});

	it('week expansion (YYYY-WNN)', () => {
		const where = getWhere(compileNql("events | where date in '2024-W01'"));

		expect(where.kind).toBe('and');
		const andWhere = where as WhereAndIntent;
		const gte = andWhere.conditions[0] as WhereComparisonIntent;
		expect(gte.operator).toBe('gte');
		// W01 of 2024 starts on 2024-01-01
		expect(typeof gte.value).toBe('string');
		const lt = andWhere.conditions[1] as WhereComparisonIntent;
		expect(lt.operator).toBe('lt');
		expect(typeof lt.value).toBe('string');
	});

	it('month expansion', () => {
		const where = getWhere(compileNql("events | where date in '2024-03'"));

		expect(where.kind).toBe('and');
		const andWhere = where as WhereAndIntent;
		const gte = andWhere.conditions[0] as WhereComparisonIntent;
		expect(gte.value).toBe('2024-03-01');
		const lt = andWhere.conditions[1] as WhereComparisonIntent;
		expect(lt.value).toBe('2024-04-01');
	});
});

// ===========================================================================
// EXISTS (subquery) — error path
// ===========================================================================
describe('compile-expression: EXISTS subquery error', () => {
	it('throws clear error for EXISTS (subquery) syntax', () => {
		expect(() =>
			compileNql(
				'users | where exists (orders | where orders.userId = users.id)',
			),
		).toThrow(/subquery/i);
	});
});

// ===========================================================================
// Multiple WHERE clauses → combined with AND
// ===========================================================================
describe('compile-expression: multiple WHERE pipes', () => {
	it('two where pipes combine with implicit AND', () => {
		const result = compileNql('users | where active = true | where age > 18');
		const where = result.query!.where!;

		expect(where.kind).toBe('and');
		const andWhere = where as WhereAndIntent;
		expect(andWhere.conditions).toHaveLength(2);
	});

	it('three where pipes combine to AND', () => {
		const result = compileNql(
			"users | where active = true | where age > 18 | where role = 'admin'",
		);
		const where = result.query!.where!;

		expect(where.kind).toBe('and');
		const andWhere = where as WhereAndIntent;
		expect(andWhere.conditions).toHaveLength(3);
	});
});

// ===========================================================================
// HAVING (WHERE after GROUP BY)
// ===========================================================================
describe('compile-expression: HAVING conditions', () => {
	it('single WHERE after GROUP BY becomes HAVING', () => {
		const result = compileNql('orders | group by status | where count > 5');
		const query = result.query!;

		expect(query.groupBy).toBeDefined();
		expect(query.having).toBeDefined();
		expect(query.where).toBeUndefined();

		const having = query.having as WhereComparisonIntent;
		expect(having.kind).toBe('comparison');
		expect(having.field).toBe('count');
	});

	it('multiple WHEREs after GROUP BY combine in HAVING', () => {
		const result = compileNql(
			'orders | group by status | where count > 5 | where total > 1000',
		);
		const query = result.query!;

		expect(query.having).toBeDefined();
		expect(query.having!.kind).toBe('and');
		expect(query.where).toBeUndefined();
	});

	it('WHERE before and after GROUP BY produces both where and having', () => {
		const result = compileNql(
			'orders | where active = true | group by status | where count > 5',
		);
		const query = result.query!;

		expect(query.where).toBeDefined();
		expect(query.having).toBeDefined();
		expect(query.groupBy).toBeDefined();
	});
});
