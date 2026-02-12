import { describe, expect, it } from 'vitest';
import { compile, parse } from '../index.js';

/**
 * Coverage tests for visit-expression.ts branches.
 * Exercises boolean logic, comparison operators, IN/BETWEEN/IS NULL,
 * arithmetic, CASE, JSON access, EXISTS, relation filters via parse() / compile().
 */

function parseNql(input: string) {
	const result = parse(input);
	if (!result.success)
		throw new Error(`Parse error: ${result.errors[0]?.message}`);
	return result.ast!;
}

function compileNql(input: string) {
	const result = compile(input, null);
	if (!result.success)
		throw new Error(`Compile error: ${result.errors[0]?.message}`);
	return result.ast!;
}

// ============================================================
// BOOLEAN EXPRESSIONS — OR / AND / NOT chaining
// ============================================================

describe('visit-expression: boolean logic', () => {
	it('parses OR chaining (multiple)', () => {
		const ast = parseNql('users | where a = 1 or b = 2 or c = 3');
		const stmt = ast.statements[0]!;
		expect(stmt.type).toBe('query');
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.type).toBe('where');
		// Nested binary 'or': (a=1 or b=2) or c=3
		const cond = where.condition;
		expect(cond.type).toBe('binary');
		if (cond.type !== 'binary') return;
		expect(cond.operator).toBe('or');
		expect(cond.left.type).toBe('binary');
		if (cond.left.type === 'binary') {
			expect(cond.left.operator).toBe('or');
		}
	});

	it('parses AND chaining (multiple)', () => {
		const ast = parseNql('users | where a = 1 and b = 2 and c = 3');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('binary');
		if (cond.type !== 'binary') return;
		expect(cond.operator).toBe('and');
		expect(cond.left.type).toBe('binary');
		if (cond.left.type === 'binary') {
			expect(cond.left.operator).toBe('and');
		}
	});

	it('parses NOT expression', () => {
		const ast = parseNql('users | where not active = true');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('unary');
		if (cond.type !== 'unary') return;
		expect(cond.operator).toBe('not');
	});

	it('parses parenthesized boolean (OR + AND precedence)', () => {
		const ast = parseNql('users | where (a = 1 or b = 2) and c = 3');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		// Top level: AND
		expect(cond.type).toBe('binary');
		if (cond.type !== 'binary') return;
		expect(cond.operator).toBe('and');
		// Left child: OR (parenthesized)
		expect(cond.left.type).toBe('binary');
		if (cond.left.type === 'binary') {
			expect(cond.left.operator).toBe('or');
		}
	});
});

// ============================================================
// EXISTS CHECK
// ============================================================

describe('visit-expression: EXISTS', () => {
	it('parses EXISTS with subquery', () => {
		const ast = parseNql('users | where exists (orders | where user_id = 1)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('exists');
		if (cond.type !== 'exists') return;
		expect(cond.negated).toBe(false);
		expect(cond.subquery.type).toBe('subquery');
	});

	it('parses NOT EXISTS as unary not wrapping exists', () => {
		// Grammar: notExpr consumes NOT, then primaryCond routes to existsCheck
		// Result: unary(not, exists(subquery, negated=false))
		const ast = parseNql(
			'users | where not exists (orders | where user_id = 1)',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('unary');
		if (cond.type !== 'unary') return;
		expect(cond.operator).toBe('not');
		expect(cond.operand.type).toBe('exists');
		if (cond.operand.type === 'exists') {
			expect(cond.operand.negated).toBe(false);
			expect(cond.operand.subquery.type).toBe('subquery');
		}
	});
});

// ============================================================
// BETWEEN EXPRESSION
// ============================================================

describe('visit-expression: BETWEEN', () => {
	it('parses BETWEEN expression', () => {
		const ast = parseNql('users | where age between 18 and 65');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('between');
		if (cond.type !== 'between') return;
		expect(cond.expression.type).toBe('path');
		expect(cond.low.type).toBe('number');
		expect(cond.high.type).toBe('number');
		if (cond.low.type === 'number') expect(cond.low.value).toBe(18);
		if (cond.high.type === 'number') expect(cond.high.value).toBe(65);
	});
});

// ============================================================
// IN / NOT IN EXPRESSIONS
// ============================================================

describe('visit-expression: IN / NOT IN', () => {
	it('parses IN expression with value list', () => {
		const ast = parseNql('users | where id in (1, 2, 3)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('in');
		if (cond.type !== 'in') return;
		expect(cond.negated).toBe(false);
		expect(Array.isArray(cond.values)).toBe(true);
		if (Array.isArray(cond.values)) {
			expect(cond.values).toHaveLength(3);
		}
	});

	it('parses NOT IN expression', () => {
		const ast = parseNql('users | where id not in (1, 2, 3)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('in');
		if (cond.type !== 'in') return;
		expect(cond.negated).toBe(true);
	});

	it('parses IN with subquery', () => {
		const ast = parseNql('users | where id in (orders | select user_id)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('in');
		if (cond.type !== 'in') return;
		expect(cond.negated).toBe(false);
		// values is a subquery, not array
		expect(Array.isArray(cond.values)).toBe(false);
	});

	it('parses IN with date range string literal', () => {
		const ast = parseNql("users | where created_at in 'last 7 days'");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('in');
		if (cond.type !== 'in') return;
		// Date range: values is a dateRange literal
		expect(!Array.isArray(cond.values)).toBe(true);
	});
});

// ============================================================
// IS NULL / IS NOT NULL
// ============================================================

describe('visit-expression: IS NULL / IS NOT NULL', () => {
	it('parses IS NULL', () => {
		const ast = parseNql('users | where email is null');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('isNull');
		if (cond.type !== 'isNull') return;
		expect(cond.negated).toBe(false);
	});

	it('parses IS NOT NULL', () => {
		const ast = parseNql('users | where name is not null');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('isNull');
		if (cond.type !== 'isNull') return;
		expect(cond.negated).toBe(true);
	});
});

// ============================================================
// COMPARISON OPERATORS
// ============================================================

describe('visit-expression: comparison operators', () => {
	it.each([
		['=', '='],
		['!=', '!='],
		['<', '<'],
		['>', '>'],
		['<=', '<='],
		['>=', '>='],
		['like', 'like'],
	])('parses %s operator', (nqlOp, expectedOp) => {
		const query =
			nqlOp === 'like'
				? "users | where name like '%test%'"
				: `users | where id ${nqlOp} 42`;
		const ast = parseNql(query);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('comparison');
		if (where.condition.type === 'comparison') {
			expect(where.condition.operator).toBe(expectedOp);
		}
	});

	it('parses NOT LIKE as not(comparison with like)', () => {
		const ast = parseNql("users | where not name like '%test%'");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('unary');
		if (cond.type !== 'unary') return;
		expect(cond.operator).toBe('not');
		expect(cond.operand.type).toBe('comparison');
		if (cond.operand.type === 'comparison') {
			expect(cond.operand.operator).toBe('like');
		}
	});
});

// ============================================================
// ARITHMETIC EXPRESSIONS
// ============================================================

describe('visit-expression: arithmetic', () => {
	it('parses multiplication in WHERE', () => {
		const ast = parseNql('orders | where price * quantity > 100');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('comparison');
		if (cond.type !== 'comparison') return;
		expect(cond.operator).toBe('>');
		expect(cond.left.type).toBe('binary');
		if (cond.left.type === 'binary') {
			expect(cond.left.operator).toBe('*');
		}
	});

	it('parses addition and subtraction', () => {
		const ast = parseNql('orders | where price + tax - discount > 0');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('comparison');
		if (cond.type !== 'comparison') return;
		// Left: (price + tax) - discount
		const left = cond.left;
		expect(left.type).toBe('binary');
		if (left.type === 'binary') {
			expect(left.operator).toBe('-');
			expect(left.left.type).toBe('binary');
			if (left.left.type === 'binary') {
				expect(left.left.operator).toBe('+');
			}
		}
	});

	it('parses division and modulo', () => {
		const ast = parseNql('orders | where total / count > 50');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'comparison') return;
		const left = where.condition.left;
		expect(left.type).toBe('binary');
		if (left.type === 'binary') {
			expect(left.operator).toBe('/');
		}
	});

	it('parses modulo operator', () => {
		const ast = parseNql('orders | where id % 2 = 0');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'comparison') return;
		expect(where.condition.left.type).toBe('binary');
		if (where.condition.left.type === 'binary') {
			expect(where.condition.left.operator).toBe('%');
		}
	});

	it('parses unary minus', () => {
		const ast = parseNql('accounts | where -balance < 0');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'comparison') return;
		const left = where.condition.left;
		expect(left.type).toBe('unary');
		if (left.type === 'unary') {
			expect(left.operator).toBe('-');
		}
	});
});

// ============================================================
// CASE EXPRESSIONS
// ============================================================

describe('visit-expression: CASE', () => {
	it('parses searched CASE with ELSE in WHERE', () => {
		const ast = parseNql(
			'users | where case when active = true then 1 else 0 end = 1',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('comparison');
		if (where.condition.type !== 'comparison') return;
		const caseExpr = where.condition.left;
		expect(caseExpr.type).toBe('case');
		if (caseExpr.type !== 'case') return;
		expect(caseExpr.whenClauses).toHaveLength(1);
		expect(caseExpr.elseClause).toBeDefined();
	});

	it('parses searched CASE without ELSE', () => {
		const ast = parseNql(
			'users | where case when active = true then 1 end = 1',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'comparison') return;
		const caseExpr = where.condition.left;
		if (caseExpr.type !== 'case') return;
		expect(caseExpr.elseClause).toBeUndefined();
	});

	it('parses searched CASE with multiple WHEN clauses', () => {
		const ast = parseNql(
			'users | select case when status = 1 then 10 when status = 2 then 20 else 0 end as score',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		const expr = item.expression;
		expect(expr.type).toBe('case');
		if (expr.type !== 'case') return;
		expect(expr.whenClauses).toHaveLength(2);
		expect(expr.subject).toBeUndefined();
	});

	it('parses simple CASE (CASE expr WHEN val THEN result)', () => {
		const ast = parseNql(
			"users | select case status when 1 then 'active' when 2 then 'inactive' else 'unknown' end as label",
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		const expr = item.expression;
		expect(expr.type).toBe('case');
		if (expr.type !== 'case') return;
		expect(expr.subject).toBeDefined();
		expect(expr.whenClauses).toHaveLength(2);
		expect(expr.elseClause).toBeDefined();
	});
});

// ============================================================
// JSON ACCESS
// ============================================================

describe('visit-expression: JSON access', () => {
	it('parses ->> (text extraction)', () => {
		const ast = parseNql("users | where data->>'name' = 'John'");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'comparison') return;
		const jsonAccess = where.condition.left;
		expect(jsonAccess.type).toBe('jsonAccess');
		if (jsonAccess.type !== 'jsonAccess') return;
		expect(jsonAccess.mode).toBe('text');
		expect(jsonAccess.path).toEqual(['name']);
	});

	it('parses -> (json extraction)', () => {
		const ast = parseNql("users | where data->'address' is not null");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		// The condition is isNull of a jsonAccess expression
		if (where.condition.type !== 'isNull') return;
		const jsonAccess = where.condition.expression;
		expect(jsonAccess.type).toBe('jsonAccess');
		if (jsonAccess.type !== 'jsonAccess') return;
		expect(jsonAccess.mode).toBe('json');
		expect(jsonAccess.path).toEqual(['address']);
	});

	it('parses chained JSON access with mixed operators', () => {
		const result = parse("users | where data->'address'->>'city' = 'NYC'");
		expect(result.success).toBe(true);
		const stmt = result.ast!.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'comparison') return;
		const jsonAccess = where.condition.left;
		expect(jsonAccess.type).toBe('jsonAccess');
		if (jsonAccess.type !== 'jsonAccess') return;
		// Last operator determines mode: ->> = text
		expect(jsonAccess.mode).toBe('text');
		expect(jsonAccess.path).toEqual(['address', 'city']);
	});

	it('emits warning for intermediate ->> usage', () => {
		const result = parse("users | where data->>'address'->'city' = 'NYC'");
		expect(result.success).toBe(true);
		// Should have WARN-JSON-001 warning
		expect(result.warnings.length).toBeGreaterThanOrEqual(1);
		expect(result.warnings[0]?.code).toBe('WARN-JSON-001');
	});
});

// ============================================================
// JSON COMPARISON OPERATORS
// ============================================================

describe('visit-expression: JSON comparison operators', () => {
	it('parses @> (contains) operator', () => {
		const ast = parseNql('users | where data @> \'{"admin": true}\'');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('jsonComparison');
		if (where.condition.type !== 'jsonComparison') return;
		expect(where.condition.operator).toBe('@>');
	});

	it('parses <@ (contained by) operator', () => {
		const ast = parseNql(
			'users | where data <@ \'{"admin": true, "active": true}\'',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('jsonComparison');
		if (where.condition.type !== 'jsonComparison') return;
		expect(where.condition.operator).toBe('<@');
	});

	it('parses ? (key exists) operator', () => {
		const ast = parseNql("users | where data ? 'email'");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('jsonComparison');
		if (where.condition.type !== 'jsonComparison') return;
		expect(where.condition.operator).toBe('?');
	});
});

// ============================================================
// SCALAR SUBQUERY
// ============================================================

describe('visit-expression: scalar subquery', () => {
	it('parses subquery in comparison', () => {
		const ast = parseNql('users | where id = (orders | select max(user_id))');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'comparison') return;
		expect(where.condition.right.type).toBe('subquery');
	});
});

// ============================================================
// RELATION FILTER EXPRESSIONS (SPEC-002)
// ============================================================

describe('visit-expression: relation filters', () => {
	it('parses some(relation).column = value', () => {
		const ast = parseNql('users | where some(posts).featured = true');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('relationFilter');
		if (cond.type !== 'relationFilter') return;
		expect(cond.mode).toBe('some');
		expect(cond.relation).toEqual(['posts']);
	});

	it('parses none(relation).column = value', () => {
		const ast = parseNql('users | where none(posts).published = true');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('relationFilter');
		if (cond.type !== 'relationFilter') return;
		expect(cond.mode).toBe('none');
	});

	it('parses every(relation).column = value', () => {
		const ast = parseNql("users | where every(posts).status = 'approved'");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('relationFilter');
		if (cond.type !== 'relationFilter') return;
		expect(cond.mode).toBe('every');
	});

	it('parses quantified filter with alias form', () => {
		const ast = parseNql(
			'users | where some(posts as p, p.featured = true and p.published = true)',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('relationFilter');
		if (cond.type !== 'relationFilter') return;
		expect(cond.mode).toBe('some');
		expect(cond.alias).toBe('p');
		// Condition is a binary AND
		expect(cond.condition.type).toBe('binary');
	});

	it('parses quantified filter with direct condition (no alias)', () => {
		const ast = parseNql('users | where some(posts, featured = true)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('relationFilter');
		if (cond.type !== 'relationFilter') return;
		expect(cond.mode).toBe('some');
		expect(cond.alias).toBeUndefined();
	});

	it('parses ALL relation filter (all posts.featured = true)', () => {
		const ast = parseNql('users | where all posts.featured = true');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('relationFilter');
		if (cond.type !== 'relationFilter') return;
		expect(cond.mode).toBe('every');
		expect(cond.relation).toEqual(['posts']);
	});

	it('parses ALL with multi-hop relation path', () => {
		const ast = parseNql('users | where all author.posts.published = true');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		const cond = where.condition;
		expect(cond.type).toBe('relationFilter');
		if (cond.type !== 'relationFilter') return;
		expect(cond.mode).toBe('every');
		expect(cond.relation).toEqual(['author', 'posts']);
	});
});

// ============================================================
// PATH EXPRESSION
// ============================================================

describe('visit-expression: path expressions', () => {
	it('parses simple column reference', () => {
		const ast = parseNql('users | where name = true');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'comparison') return;
		expect(where.condition.left.type).toBe('path');
		if (where.condition.left.type === 'path') {
			expect(where.condition.left.segments).toEqual(['name']);
		}
	});

	it('parses dotted path (relation.column)', () => {
		const ast = parseNql('users | select orders.total');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('path');
		if (item.expression.type === 'path') {
			expect(item.expression.segments).toEqual(['orders', 'total']);
		}
	});
});

// ============================================================
// RANGE OPERATORS
// ============================================================

describe('visit-expression: range operators', () => {
	it('parses overlaps with range literal', () => {
		const ast = parseNql(
			'events | where daterange overlaps [2024-01-01,2024-12-31)',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('rangeOp');
		if (where.condition.type !== 'rangeOp') return;
		expect(where.condition.operator).toBe('overlaps');
		expect(where.condition.range).toBeDefined();
	});

	it('parses contains with scalar value', () => {
		const ast = parseNql('events | where scorerange contains 25');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('rangeOp');
		if (where.condition.type !== 'rangeOp') return;
		expect(where.condition.operator).toBe('contains');
		expect(where.condition.scalar).toBeDefined();
	});

	it('parses containedBy with range literal', () => {
		const ast = parseNql(
			'events | where daterange containedBy [2024-01-01,2024-12-31]',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('rangeOp');
		if (where.condition.type !== 'rangeOp') return;
		expect(where.condition.operator).toBe('containedBy');
	});
});
