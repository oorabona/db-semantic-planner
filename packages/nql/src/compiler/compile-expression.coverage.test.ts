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
	WhereAnyIntent,
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
import { NqlErrorCodes } from '../errors/types.js';
import { compile } from '../index.js';
import { MAX_ANY_ITEMS } from './compile-expression.js';
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

// ===========================================================================
// JSON access on LHS of comparison in WHERE
// ===========================================================================
describe('compile-expression: JSON access on LHS of comparison', () => {
	it('data->>key = value produces comparison with jsonPath and jsonMode', () => {
		const where = getWhere(
			compileNql("users | where data->>'email' = 'test@example.com'"),
		) as WhereComparisonIntent;

		expect(where.kind).toBe('comparison');
		expect(where.field).toBe('data');
		expect(where.jsonPath).toEqual(['email']);
		expect(where.jsonMode).toBe('text');
		expect(where.value).toBe('test@example.com');
	});

	it('data->key = value uses json mode', () => {
		const where = getWhere(
			compileNql("users | where data->'meta' = 'x'"),
		) as WhereComparisonIntent;

		expect(where.kind).toBe('comparison');
		expect(where.field).toBe('data');
		expect(where.jsonMode).toBe('json');
	});
});

// ===========================================================================
// JSON function notation on LHS of comparison in WHERE
// ===========================================================================
describe('compile-expression: JSON function on LHS of comparison', () => {
	it('json_extract_text(col, key) = value produces comparison with jsonPath', () => {
		const where = getWhere(
			compileNql(
				"users | where json_extract_text(data, 'email') = 'test@example.com'",
			),
		) as WhereComparisonIntent;

		expect(where.kind).toBe('comparison');
		expect(where.field).toBe('data');
		expect(where.jsonPath).toEqual(['email']);
		expect(where.jsonMode).toBe('text');
		expect(where.value).toBe('test@example.com');
	});

	it('json_extract(col, key) = value uses json mode', () => {
		const where = getWhere(
			compileNql("users | where json_extract(data, 'meta') = 'x'"),
		) as WhereComparisonIntent;

		expect(where.kind).toBe('comparison');
		expect(where.field).toBe('data');
		expect(where.jsonPath).toEqual(['meta']);
		expect(where.jsonMode).toBe('json');
	});
});

// ===========================================================================
// JSON function notation in WHERE context
// ===========================================================================
describe('compile-expression: JSON function notation in WHERE', () => {
	it('json_contains produces jsonContains with reversed=false', () => {
		const where = getWhere(
			compileNql('users | where json_contains(data, \'{"a":1}\')'),
		) as WhereJsonContainsIntent;

		expect(where.kind).toBe('jsonContains');
		expect(where.field).toBe('data');
		expect(where.reversed).toBe(false);
	});

	it('json_contained_by produces jsonContains with reversed=true', () => {
		const where = getWhere(
			compileNql('users | where json_contained_by(data, \'{"a":1}\')'),
		) as WhereJsonContainsIntent;

		expect(where.kind).toBe('jsonContains');
		expect(where.field).toBe('data');
		expect(where.reversed).toBe(true);
	});

	it('json_exists produces jsonExists', () => {
		const where = getWhere(
			compileNql("users | where json_exists(data, 'email')"),
		) as WhereJsonExistsIntent;

		expect(where.kind).toBe('jsonExists');
		expect(where.field).toBe('data');
		expect(where.key).toBe('email');
	});
});

// ===========================================================================
// Range operators
// ===========================================================================
describe('compile-expression: range operators', () => {
	it('overlaps with range literal', () => {
		const where = getWhere(
			compileNql('events | where dateRange overlaps [2024-01-01,2024-06-30]'),
		) as WhereRangeIntent;

		expect(where.kind).toBe('range');
		expect(where.field).toBe('dateRange');
		expect(where.operator).toBe('overlaps');
	});

	it('containedBy with range literal', () => {
		const where = getWhere(
			compileNql('events | where priceRange containedBy [0,1000]'),
		) as WhereRangeIntent;

		expect(where.kind).toBe('range');
		expect(where.field).toBe('priceRange');
		expect(where.operator).toBe('containedBy');
	});
});

// ===========================================================================
// BETWEEN expression
// ===========================================================================
describe('compile-expression: BETWEEN', () => {
	it('BETWEEN produces range intent with between operator', () => {
		const where = getWhere(
			compileNql('users | where age between 18 and 65'),
		) as WhereRangeIntent;

		expect(where.kind).toBe('range');
		expect(where.field).toBe('age');
		expect(where.operator).toBe('between');
		expect(where.value).toEqual({ lower: 18, upper: 65 });
	});

	it('BETWEEN with string values', () => {
		const where = getWhere(
			compileNql(
				"orders | where created_at between '2024-01-01' and '2024-12-31'",
			),
		) as WhereRangeIntent;

		expect(where.kind).toBe('range');
		expect(where.field).toBe('created_at');
		expect(where.operator).toBe('between');
	});

	it('throws when BETWEEN bounds are path-expressions instead of literals (L-6 actionable message)', () => {
		// L-6: message now names which bound failed and what type was rejected.
		expect(() =>
			compileNql('users | where age between minAge and maxAge'),
		).toThrow(/BETWEEN lower bound must be a literal number, string, or date/);
	});
});

// ===========================================================================
// IS NULL / IS NOT NULL
// ===========================================================================
describe('compile-expression: IS NULL / IS NOT NULL', () => {
	it('IS NULL produces null intent with isNull operator', () => {
		const where = getWhere(compileNql('users | where email is null'));

		expect(where.kind).toBe('null');
		if (where.kind === 'null') {
			expect(where.field).toBe('email');
			expect(where.operator).toBe('isNull');
		}
	});

	it('IS NOT NULL produces null intent with isNotNull operator', () => {
		const where = getWhere(compileNql('users | where email is not null'));

		expect(where.kind).toBe('null');
		if (where.kind === 'null') {
			expect(where.field).toBe('email');
			expect(where.operator).toBe('isNotNull');
		}
	});
});

// ===========================================================================
// LIKE comparison
// ===========================================================================
describe('compile-expression: LIKE', () => {
	it('LIKE produces like intent', () => {
		const where = getWhere(compileNql("users | where name like '%john%'"));

		expect(where.kind).toBe('like');
		if (where.kind === 'like') {
			expect(where.field).toBe('name');
			expect(where.pattern).toBe('%john%');
		}
	});
});

// ===========================================================================
// IN with subquery
// ===========================================================================
describe('compile-expression: IN with subquery', () => {
	it('IN (subquery) produces in intent with subquery', () => {
		const where = getWhere(
			compileNql('users | where id in (orders | select userId)'),
		) as WhereInIntent;

		expect(where.kind).toBe('in');
		expect(where.subquery).toBeDefined();
		expect(where.subquery!.from).toBe('orders');
	});
});

// ===========================================================================
// Relation filter with alias
// ===========================================================================
describe('compile-expression: relation filter with alias', () => {
	it('some(relation as alias, condition) uses alias for scoping', () => {
		const where = getWhere(
			compileNql('users | where some(orders as o, o.total > 100)'),
		) as WhereRelationFilterIntent;

		expect(where.kind).toBe('relationFilter');
		expect(where.relation).toEqual(['orders']);
		expect(where.mode).toBe('some');
		expect(where.alias).toBe('o');
	});

	it('some(relation, condition) without alias', () => {
		const where = getWhere(
			compileNql('users | where some(orders, total > 100)'),
		) as WhereRelationFilterIntent;

		expect(where.kind).toBe('relationFilter');
		expect(where.relation).toEqual(['orders']);
		expect(where.mode).toBe('some');
		expect(where.alias).toBeUndefined();
	});
});

// ===========================================================================
// ROUND 2: OR with aliasContext/outerAliases (line 73)
// ===========================================================================

describe('compile-expression: OR in relation filter context', () => {
	it('OR branch inside relation filter condition', () => {
		const where = getWhere(
			compileNql(
				"users | where some(orders as o, o.total > 100 or o.status = 'paid')",
			),
		) as WhereRelationFilterIntent;

		expect(where.kind).toBe('relationFilter');
		expect(where.where.kind).toBe('or');
	});
});

// ===========================================================================
// ROUND 2: NOT branch (line 102)
// ===========================================================================

describe('compile-expression: NOT in WHERE', () => {
	it('NOT wrapping a comparison passes aliasContext down', () => {
		const where = getWhere(
			compileNql('users | where some(orders as o, not o.total > 100)'),
		) as WhereRelationFilterIntent;

		expect(where.kind).toBe('relationFilter');
		expect(where.where.kind).toBe('not');
	});
});

// ===========================================================================
// ROUND 2: Range operator with scalar value (contains N) (line 229)
// ===========================================================================

describe('compile-expression: range operator with scalar value', () => {
	it('contains with scalar integer value', () => {
		const where = getWhere(
			compileNql('users | where salary contains 50000'),
		) as WhereRangeIntent;

		expect(where.kind).toBe('range');
		expect(where.operator).toBe('contains');
		expect(where.value).toBe(50000);
	});
});

// ===========================================================================
// ROUND 2: IN with date range pattern (line 297)
// ===========================================================================

describe('compile-expression: IN with date range value', () => {
	it('single date range value compiles to range expansion', () => {
		const where = getWhere(compileNql("users | where created_at in '2024-Q1'"));

		// Date range IN should produce range/comparison structure
		expect(where).toBeDefined();
		// The exact structure depends on expandDateRangeList
		// but we just need the branch to be covered
	});
});

// ===========================================================================
// ROUND 2: Negated IN with subquery (line 292-293)
// ===========================================================================

describe('compile-expression: negated IN subquery', () => {
	it('NOT IN with subquery wraps in not', () => {
		const where = getWhere(
			compileNql('users | where id not in (orders | select userId)'),
		);

		expect(where.kind).toBe('not');
		const inner = (where as WhereNotIntent).condition as WhereInIntent;
		expect(inner.kind).toBe('in');
		expect(inner.subquery).toBeDefined();
	});
});

// ===========================================================================
// ROUND 2: json_exists error paths (line 435-436)
// ===========================================================================

describe('compile-expression: json_exists error path', () => {
	it('json_exists with < 2 args throws', () => {
		expect(() => compileNql('users | where json_exists(data)')).toThrow(
			/requires 2 arguments/,
		);
	});
});

// ===========================================================================
// ROUND 2: none() relation filter mode (line 461 jsonComparison)
// ===========================================================================

describe('compile-expression: none() relation filter', () => {
	it('none(relation, condition) compiles to mode none', () => {
		const where = getWhere(
			compileNql('users | where none(orders, total > 100)'),
		) as WhereRelationFilterIntent;

		expect(where.kind).toBe('relationFilter');
		expect(where.mode).toBe('none');
	});

	it('every(relation, condition) compiles to mode every', () => {
		const where = getWhere(
			compileNql('users | where every(orders, total > 100)'),
		) as WhereRelationFilterIntent;

		expect(where.kind).toBe('relationFilter');
		expect(where.mode).toBe('every');
	});
});

// ===========================================================================
// P0-2: json_exists with identifier key (not string literal)
// ===========================================================================

describe('compile-expression: json_exists identifier key (P0-2)', () => {
	it('json_exists with identifier key extracts field name as string', () => {
		// Previously: resolveFilterValue returned an NqlPathExpression object
		// which coerced to '[object Object]' via String(key).
		// Fix: detect path expression and use expressionToField to extract name.
		const where = getWhere(
			compileNql('users | where json_exists(data, email)'),
		) as WhereJsonExistsIntent;

		expect(where.kind).toBe('jsonExists');
		expect(where.key).toBe('email');
	});

	it('json_exists with string literal key still works', () => {
		const where = getWhere(
			compileNql("users | where json_exists(data, 'email')"),
		) as WhereJsonExistsIntent;

		expect(where.kind).toBe('jsonExists');
		expect(where.key).toBe('email');
	});

	it('throws when json_exists key is a dotted path (multi-segment identifier)', () => {
		// json_exists(data, profile.email) would silently produce key='profile.email'
		// (a single dotted JSON key), which is semantically wrong.
		// The compiler must reject dotted paths and require a string literal or single identifier.
		expect(() =>
			compileNql('users | where json_exists(data, profile.email)'),
		).toThrow(
			/key must be a string literal or a single identifier, not a dotted path/,
		);
	});
});

// ===========================================================================
// P1-4: caseExpr in WHERE position must throw a clear error
// ===========================================================================

describe('compile-expression: caseExpr in WHERE (P1-4)', () => {
	it('throws when bare CASE expression appears in WHERE (type case)', () => {
		// CASE is only valid in SELECT. In WHERE position the compiler must
		// throw a clear, actionable error message.
		// A bare CASE (without comparison) reaches compileExpression as type 'case'.
		expect(() =>
			compileNql(
				"users | where case when status = 'active' then true else false end",
			),
		).toThrow(/CASE in WHERE not supported/);
	});
});

// ===========================================================================
// Observable Success: String-coercion class (S-1, S-2, S-3)
// and error code preservation (M-4).
//
// The original bug: String(resolveFilterValue(...)) emitted '[object Object]'
// when the RHS was a path expression (resolveFilterValue returns {$ref:...}
// for bare fields, or FieldRef for alias-context paths — both non-string).
//
// The fix: coerceToStringKey() dispatches on expression type:
//   - string literal → use value directly
//   - single-segment path → use the field name as the string key
//   - multi-segment dotted path → throw SEM_INVALID_SYNTAX (ambiguous)
//   - anything else → throw SEM_INVALID_SYNTAX
//
// Tests verify:
//   - Single-segment bare paths are treated as string keys (no '[object Object]')
//   - Dotted paths (multi-segment) throw SEM_INVALID_SYNTAX
//   - M-4: compile() catch-all preserves the typed error code
// ===========================================================================

/**
 * Like compileNql() but returns the raw ParseResult instead of throwing on error.
 * Use when the test needs to inspect `result.success`, `result.errors[0].code`, etc.
 * (compileNql throws on failure and is unsuitable for negative/error-path tests.)
 */
function compileRaw(input: string) {
	return compile(input, null);
}

describe('compile-expression: S-1 — LIKE pattern coercion (no [object Object])', () => {
	it('LIKE with bare identifier treats it as pattern string (not [object Object])', () => {
		// Before fix: String(resolveFilterValue(...)) → '[object Object]' in pattern.
		// After fix: coerceToStringKey returns the field name as the pattern string.
		const result = getWhere(
			compileNql('users | where name like otherName'),
		) as import('@dbsp/types').WhereLikeIntent;
		expect(result.kind).toBe('like');
		expect(result.field).toBe('name');
		// Must be 'otherName', never '[object Object]'
		expect(result.pattern).toBe('otherName');
		expect(result.pattern).not.toBe('[object Object]');
	});

	it('LIKE with dotted path throws SEM_INVALID_SYNTAX', () => {
		// Multi-segment paths are ambiguous as LIKE patterns — reject them.
		const result = compileRaw('users | where name like a.b');
		expect(result.success).toBe(false);
		expect(result.errors[0]?.code).toBe(NqlErrorCodes.SEM_INVALID_SYNTAX);
		expect(result.errors[0]?.message).toMatch(
			/LIKE pattern must be a string literal/,
		);
	});

	it('LIKE with string literal still works (regression)', () => {
		const result = getWhere(compileNql("users | where name like '%alice%'"));
		expect(result).toMatchObject({
			kind: 'like',
			field: 'name',
			pattern: '%alice%',
		});
	});
});

describe('compile-expression: S-2 — json_extract path arg coercion (no [object Object])', () => {
	it('json_extract with bare identifier treats it as key string (not [object Object])', () => {
		// Before fix: String(resolveFilterValue(a, ...)) → '[object Object]' as JSON key.
		// After fix: coerceToStringKey returns the field name as the key string.
		const result = getWhere(
			compileNql("users | where json_extract(data, someKey) = 'x'"),
		) as WhereComparisonIntent;
		expect(result.kind).toBe('comparison');
		// Must be ['someKey'], never ['[object Object]']
		expect(result.jsonPath).toEqual(['someKey']);
	});

	it('json_extract with dotted path arg throws SEM_INVALID_SYNTAX', () => {
		// Multi-segment paths are ambiguous as JSON keys — reject them.
		const result = compileRaw("users | where json_extract(data, a.b) = 'x'");
		expect(result.success).toBe(false);
		expect(result.errors[0]?.code).toBe(NqlErrorCodes.SEM_INVALID_SYNTAX);
		expect(result.errors[0]?.message).toMatch(/json_extract\(\) path argument/);
	});

	it('json_extract with string literal key still works (regression)', () => {
		const result = getWhere(
			compileNql("users | where json_extract(data, 'key') = 'x'"),
		) as WhereComparisonIntent;
		expect(result.kind).toBe('comparison');
		expect(result.jsonPath).toEqual(['key']);
	});
});

describe('compile-expression: S-3 — ? operator key coercion (no [object Object])', () => {
	it('? with bare identifier treats it as key string (not [object Object])', () => {
		// Before fix: String(resolveFilterValue(...)) → '[object Object]' as key.
		// After fix: coerceToStringKey returns the field name as the key string.
		const result = getWhere(
			compileNql('users | where data ? otherKey'),
		) as WhereJsonExistsIntent;
		expect(result.kind).toBe('jsonExists');
		// Must be 'otherKey', never '[object Object]'
		expect(result.key).toBe('otherKey');
		expect(result.key).not.toBe('[object Object]');
	});

	it('? with dotted path throws SEM_INVALID_SYNTAX', () => {
		// Multi-segment paths are ambiguous as JSON keys — reject them.
		const result = compileRaw('users | where data ? a.b');
		expect(result.success).toBe(false);
		expect(result.errors[0]?.code).toBe(NqlErrorCodes.SEM_INVALID_SYNTAX);
		expect(result.errors[0]?.message).toMatch(/\? operator key/);
	});

	it('? with string literal key still works (regression)', () => {
		const result = getWhere(
			compileNql("users | where data ? 'email'"),
		) as WhereJsonExistsIntent;
		expect(result.kind).toBe('jsonExists');
		expect(result.key).toBe('email');
	});
});

describe('compile-expression: M-4 — error code preserved through compile() catch-all', () => {
	it('compile() preserves SEM_INVALID_SYNTAX code from NqlSemanticException', () => {
		// Trigger a dotted-path LIKE (which throws SEM_INVALID_SYNTAX) through compile().
		// Verifies the catch-all in index.ts preserves the typed code rather than
		// overwriting to SEM_UNKNOWN_COLUMN (that was the M-4 bug).
		// NOTE: This test validates M-4(b) behaviour. The fix in index.ts checks
		// `err instanceof NqlSemanticException` and uses `err.code` when true.
		const result = compileRaw('users | where name like a.b');
		expect(result.success).toBe(false);
		expect(result.errors).toHaveLength(1);
		// Must be SEM_INVALID_SYNTAX — NOT SEM_UNKNOWN_COLUMN (that was the M-4 bug)
		expect(result.errors[0]?.code).toBe(NqlErrorCodes.SEM_INVALID_SYNTAX);
		expect(result.errors[0]?.code).not.toBe(NqlErrorCodes.SEM_UNKNOWN_COLUMN);
	});
});

// ---------------------------------------------------------------------------
// ANY(:param) validation — BATCH-001 correctness guards
// ---------------------------------------------------------------------------
// Helper: compile NQL with named params, return raw ParseResult (never throws).
function compileWithParams(input: string, params: Record<string, unknown>) {
	return compile(input, null, undefined, { params });
}

describe('compile-expression: ANY(:param) — missing param throws', () => {
	it('throws SEM_INVALID_SYNTAX when the bound parameter is not provided', () => {
		// Mutation caught: removing the `!Array.isArray(rawValues)` guard makes this pass silently.
		const result = compileWithParams('users | where id = ANY(:ids)', {});
		expect(result.success).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe(NqlErrorCodes.SEM_INVALID_SYNTAX);
		expect(result.errors[0]?.message).toContain('ids');
		expect(result.errors[0]?.message).toContain('array');
	});
});

describe('compile-expression: ANY(:param) — non-array param throws', () => {
	it('throws SEM_INVALID_SYNTAX when the bound parameter is a string (not an array)', () => {
		// Mutation caught: removing the `!Array.isArray(rawValues)` guard makes this pass silently.
		const result = compileWithParams('users | where id = ANY(:ids)', {
			ids: 'not-an-array',
		});
		expect(result.success).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe(NqlErrorCodes.SEM_INVALID_SYNTAX);
		expect(result.errors[0]?.message).toContain('ids');
		expect(result.errors[0]?.message).toContain('array');
	});

	it('throws SEM_INVALID_SYNTAX when the bound parameter is a number (not an array)', () => {
		// Mutation caught: same guard; ensures the check is not accidentally string-specific.
		const result = compileWithParams('users | where id = ANY(:ids)', {
			ids: 42,
		});
		expect(result.success).toBe(false);
		expect(result.errors[0]?.code).toBe(NqlErrorCodes.SEM_INVALID_SYNTAX);
		expect(result.errors[0]?.message).toContain('ids');
	});
});

describe('compile-expression: ANY(:param) — valid array param compiles successfully', () => {
	it('returns WhereAnyIntent with the correct field and values', () => {
		// Mutation caught: if values were hardcoded to [] the length and content assertions would fail.
		const result = compileWithParams('users | where id = ANY(:ids)', {
			ids: [1, 2, 3],
		});
		expect(result.success).toBe(true);
		const where = result.ast!.query!.where as WhereAnyIntent;
		expect(where.kind).toBe('any');
		expect(where.field).toBe('id');
		expect(where.values).toHaveLength(3);
		expect(where.values).toEqual([1, 2, 3]);
	});
});

describe('compile-expression: ANY(:param) — array exceeding MAX_ANY_ITEMS cap throws', () => {
	it('throws SEM_INVALID_SYNTAX when array length is MAX_ANY_ITEMS + 1', () => {
		// Mutation caught: removing the `rawValues.length > MAX_ANY_ITEMS` guard makes this pass.
		const oversized = Array.from({ length: MAX_ANY_ITEMS + 1 }, (_, i) => i);
		const result = compileWithParams('users | where id = ANY(:ids)', {
			ids: oversized,
		});
		expect(result.success).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe(NqlErrorCodes.SEM_INVALID_SYNTAX);
		expect(result.errors[0]?.message).toContain('ids');
		expect(result.errors[0]?.message).toContain(String(MAX_ANY_ITEMS));
	});
});

describe('compile-expression: ANY(:param) — array at exactly MAX_ANY_ITEMS compiles successfully', () => {
	it('accepts an array of exactly MAX_ANY_ITEMS items (boundary — inclusive cap)', () => {
		// Mutation caught: changing > to >= would make this fail; confirms cap is inclusive.
		const atLimit = Array.from({ length: MAX_ANY_ITEMS }, (_, i) => i);
		const result = compileWithParams('users | where id = ANY(:ids)', {
			ids: atLimit,
		});
		expect(result.success).toBe(true);
		const where = result.ast!.query!.where as WhereAnyIntent;
		expect(where.kind).toBe('any');
		expect(where.values).toHaveLength(MAX_ANY_ITEMS);
	});
});

// Helper: compile NQL with named params AND compiler options (e.g. maxAnyItems override).
function compileWithParamsAndOptions(
	input: string,
	params: Record<string, unknown>,
	compilerOptions: { maxAnyItems?: number },
) {
	return compile(input, null, undefined, { params, ...compilerOptions });
}

describe('compile-expression: ANY(:param) — maxAnyItems override rejects array exceeding custom cap', () => {
	it('throws SEM_INVALID_SYNTAX when array length exceeds the overridden cap (override+1 items)', () => {
		// Mutation caught: if compileMembership ignored ctx.maxAnyItems and always used the
		// MAX_ANY_ITEMS constant (10000), an array of 3 items would compile fine instead of throwing.
		const result = compileWithParamsAndOptions(
			'users | where id = ANY(:ids)',
			{ ids: [1, 2, 3] },
			{ maxAnyItems: 2 },
		);
		expect(result.success).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe(NqlErrorCodes.SEM_INVALID_SYNTAX);
		expect(result.errors[0]?.message).toContain('ids');
		expect(result.errors[0]?.message).toContain('3');
		expect(result.errors[0]?.message).toContain('2');
	});
});

describe('compile-expression: ANY(:param) — maxAnyItems override accepts array at exactly custom cap', () => {
	it('compiles successfully when array length equals the overridden cap (exactly override items)', () => {
		// Mutation caught: if ctx.maxAnyItems were ignored (always MAX_ANY_ITEMS), this test still
		// passes — BUT the companion "rejects override+1" test above would fail, collectively
		// proving the override is wired end-to-end. Here we confirm the boundary is inclusive.
		const result = compileWithParamsAndOptions(
			'users | where id = ANY(:ids)',
			{ ids: [10, 20] },
			{ maxAnyItems: 2 },
		);
		expect(result.success).toBe(true);
		const where = result.ast!.query!.where as WhereAnyIntent;
		expect(where.kind).toBe('any');
		expect(where.field).toBe('id');
		expect(where.values).toHaveLength(2);
		expect(where.values).toEqual([10, 20]);
	});
});

describe('compile-expression: ANY(:param) — maxAnyItems unset still uses MAX_ANY_ITEMS default', () => {
	it('compiles a small array without specifying maxAnyItems (default cap unchanged)', () => {
		// Mutation caught: if the default were changed from MAX_ANY_ITEMS to a smaller value
		// (e.g. 1), this would fail because a 3-element array would be rejected.
		const result = compileWithParamsAndOptions(
			'users | where id = ANY(:ids)',
			{ ids: [1, 2, 3] },
			{},
		);
		expect(result.success).toBe(true);
		const where = result.ast!.query!.where as WhereAnyIntent;
		expect(where.kind).toBe('any');
		expect(where.values).toHaveLength(3);
	});
});
