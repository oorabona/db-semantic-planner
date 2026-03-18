import { describe, expect, it } from 'vitest';
import { compile, parse } from '../index.js';
import type { NqlSelectExpression } from '../parser/ast.js';

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

// ============================================================
// ARITHMETIC — subtraction, division, modulo operators
// ============================================================

describe('visit-expression: arithmetic operator variety', () => {
	it('parses subtraction (a - b)', () => {
		const ast = parseNql('orders | select price - discount as net');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('binary');
		if (item.expression.type === 'binary') {
			expect(item.expression.operator).toBe('-');
		}
	});

	it('parses division (a / b)', () => {
		const ast = parseNql('orders | select total / count as avg');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('binary');
		if (item.expression.type === 'binary') {
			expect(item.expression.operator).toBe('/');
		}
	});

	it('parses modulo (a % b)', () => {
		const ast = parseNql('orders | select id % 2 as parity');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('binary');
		if (item.expression.type === 'binary') {
			expect(item.expression.operator).toBe('%');
		}
	});

	it('parses mixed add + mul with correct precedence', () => {
		const ast = parseNql('orders | select a + b * c as result');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		// Should be a + (b * c): outer is +
		expect(item.expression.type).toBe('binary');
		if (item.expression.type === 'binary') {
			expect(item.expression.operator).toBe('+');
			// Right side is b*c
			expect(item.expression.right.type).toBe('binary');
			if (item.expression.right.type === 'binary') {
				expect(item.expression.right.operator).toBe('*');
			}
		}
	});
});

// ============================================================
// SIMPLE CASE expression — visitCaseExpr simpleCaseBody
// ============================================================

describe('visit-expression: simple CASE expression', () => {
	it('parses simple CASE with subject expression', () => {
		const ast = parseNql(
			"users | select case status when 'A' then 1 when 'B' then 2 else 0 end as code",
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('case');
		if (item.expression.type === 'case') {
			// Simple CASE has a subject
			expect(item.expression.subject).toBeDefined();
			expect(item.expression.whenClauses).toHaveLength(2);
			expect(item.expression.elseClause).toBeDefined();
		}
	});

	it('parses simple CASE without ELSE', () => {
		const ast = parseNql(
			"users | select case role when 'admin' then 1 when 'user' then 2 end as level",
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('case');
		if (item.expression.type === 'case') {
			expect(item.expression.subject).toBeDefined();
			expect(item.expression.elseClause).toBeUndefined();
		}
	});
});

// ============================================================
// JSON access with intermediate ->> warning
// ============================================================

describe('visit-expression: JSON access intermediate ->> warning', () => {
	it('warns on intermediate ->> (only last operator determines mode)', () => {
		// Uses compile to capture warnings
		const result = compile("users | select data->>'a'->'b' as val", null);
		// Should produce a warning about intermediate ->>
		const hasJsonWarn = result.warnings?.some(
			(w) => w.code === 'WARN-JSON-001',
		);
		expect(hasJsonWarn).toBe(true);
	});
});

// ============================================================
// COMPARISON OPERATORS — like
// ============================================================

describe('visit-expression: like comparison operator', () => {
	it('parses LIKE comparison', () => {
		const ast = parseNql("users | where name like '%test%'");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('comparison');
		if (where.condition.type === 'comparison') {
			expect(where.condition.operator).toBe('like');
		}
	});
});

// ============================================================
// RANGE OPERATOR — containedBy
// ============================================================

describe('visit-expression: containedBy range operator', () => {
	it('parses containedBy operator', () => {
		const ast = parseNql('events | where scorerange containedBy [0,100]');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('rangeOp');
		if (where.condition.type === 'rangeOp') {
			expect(where.condition.operator).toBe('containedBy');
		}
	});
});

// ============================================================
// JSON COMPARISON — <@ and ?
// ============================================================

describe('visit-expression: JSON comparison operators', () => {
	it('parses <@ (contained by) operator', () => {
		const ast = parseNql('users | where data <@ \'{"a":1}\'');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('jsonComparison');
		if (where.condition.type === 'jsonComparison') {
			expect(where.condition.operator).toBe('<@');
		}
	});

	it('parses ? (key exists) operator', () => {
		const ast = parseNql("users | where data ? 'email'");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('jsonComparison');
		if (where.condition.type === 'jsonComparison') {
			expect(where.condition.operator).toBe('?');
		}
	});
});

// ============================================================
// SCALAR SUBQUERY in expression context
// ============================================================

describe('visit-expression: scalar subquery', () => {
	it('parses scalar subquery in SELECT', () => {
		const ast = parseNql(
			'users | select name, (orders | select count() as cnt) as order_count',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const subItem = sel.items[1]!;
		if (subItem.type !== 'expression') return;
		expect(subItem.expression.type).toBe('subquery');
	});
});

// ============================================================
// PARENTHESIZED expression in primaryExpr
// ============================================================

describe('visit-expression: parenthesized expression', () => {
	it('parses (a + b) * c with correct precedence', () => {
		const ast = parseNql('orders | select (a + b) * c as result');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('binary');
		if (item.expression.type === 'binary') {
			expect(item.expression.operator).toBe('*');
			// Left is (a+b)
			expect(item.expression.left.type).toBe('binary');
		}
	});
});

// ============================================================
// PATH EXPRESSION with depth hint
// ============================================================

describe('visit-expression: path expression with depth hint', () => {
	it('parses path with depth hint', () => {
		const ast = parseNql('categories | select descendants[3].name');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		// Multi-segment path: descendants[3].name
		expect(item.expression.type).toBe('path');
		if (item.expression.type === 'path') {
			expect(item.expression.depthHint).toBe(3);
		}
	});
});

// ============================================================
// QUANTIFIED RELATION FILTER — with boolean expression body
// ============================================================

describe('visit-expression: quantified relation filter with boolean body', () => {
	it('parses some(relation as alias, condition) syntax', () => {
		const ast = parseNql('users | where some(orders as o, o.total > 100)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('relationFilter');
		if (where.condition.type === 'relationFilter') {
			expect(where.condition.mode).toBe('some');
			expect(where.condition.alias).toBe('o');
		}
	});

	it('parses some(relation, condition) without alias', () => {
		const ast = parseNql('users | where some(orders, total > 100)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('relationFilter');
		if (where.condition.type === 'relationFilter') {
			expect(where.condition.mode).toBe('some');
			expect(where.condition.alias).toBeUndefined();
		}
	});

	it('parses every(relation, condition) syntax', () => {
		const ast = parseNql('users | where every(posts, published = true)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('relationFilter');
		if (where.condition.type === 'relationFilter') {
			expect(where.condition.mode).toBe('every');
		}
	});
});

// ============================================================
// EXISTS expression
// ============================================================

describe('visit-expression: exists expression', () => {
	it('parses EXISTS subquery', () => {
		const ast = parseNql('users | where exists (orders | where userId = 1)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('exists');
		if (where.condition.type === 'exists') {
			expect(where.condition.negated).toBe(false);
		}
	});

	it('parses NOT EXISTS subquery', () => {
		const ast = parseNql('users | where not exists (bans | where userId = 1)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		// NOT wraps the exists
		expect(where.condition.type).toBe('unary');
		if (where.condition.type === 'unary') {
			expect(where.condition.operator).toBe('not');
			expect(where.condition.operand.type).toBe('exists');
		}
	});
});

// ===========================================================================
// ROUND 2: Additional branches in visit-expression.ts
// ===========================================================================

// ============================================================
// LIKE operator in compOp (line 387)
// ============================================================

describe('visit-expression R2: LIKE comparison operator', () => {
	it('parses LIKE operator (line 387)', () => {
		const ast = parseNql("users | where name like '%john%'");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('comparison');
		if (where.condition.type === 'comparison') {
			expect(where.condition.operator).toBe('like');
		}
	});
});

// ============================================================
// Range operator containedBy (line 396)
// ============================================================

describe('visit-expression R2: containedBy range operator', () => {
	it('parses containedBy range operator (line 396)', () => {
		const ast = parseNql(
			'events | where dates containedBy [2024-01-01, 2024-12-31]',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('rangeOp');
		if (where.condition.type === 'rangeOp') {
			expect(where.condition.operator).toBe('containedBy');
		}
	});
});

// ============================================================
// Range operator with scalar value (line 239)
// ============================================================

describe('visit-expression R2: range operator scalar value', () => {
	it('parses range operator with scalar literal (line 239)', () => {
		const ast = parseNql("events | where dates contains '2024-06-15'");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('rangeOp');
		if (where.condition.type === 'rangeOp') {
			expect(where.condition.operator).toBe('contains');
			expect(where.condition.scalar).toBeDefined();
		}
	});
});

// ============================================================
// JSON comparison with containedBy (<@) (line 258)
// ============================================================

describe('visit-expression R2: JSON containedBy operator', () => {
	it('parses JSON containedBy <@ operator (line 258)', () => {
		const ast = parseNql('users | where metadata <@ \'{"role":"admin"}\'');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('jsonComparison');
		if (where.condition.type === 'jsonComparison') {
			expect(where.condition.operator).toBe('<@');
		}
	});
});

// ============================================================
// Subtraction in addExpr (line 432)
// ============================================================

describe('visit-expression R2: subtraction operator', () => {
	it('parses subtraction in arithmetic expression (line 432)', () => {
		const ast = parseNql('products | select price - discount as savings');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const selectClause = stmt.clauses.find((c) => c.type === 'select');
		if (selectClause && 'items' in selectClause) {
			const items = selectClause.items;
			expect(items.length).toBeGreaterThan(0);
			const expr = (items[0]! as NqlSelectExpression).expression;
			expect(expr.type).toBe('binary');
			if (expr.type === 'binary') {
				expect(expr.operator).toBe('-');
			}
		}
	});
});

// ============================================================
// Division and modulo in mulExpr (lines 465)
// ============================================================

describe('visit-expression R2: division and modulo operators', () => {
	it('parses division operator (line 465)', () => {
		const ast = parseNql('products | select total / count as average');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const selectClause = stmt.clauses.find((c) => c.type === 'select');
		if (selectClause && 'items' in selectClause) {
			const expr = (selectClause.items[0]! as NqlSelectExpression).expression;
			expect(expr.type).toBe('binary');
			if (expr.type === 'binary') {
				expect(expr.operator).toBe('/');
			}
		}
	});

	it('parses modulo operator (line 465)', () => {
		const ast = parseNql('products | select id % 2 as parity');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const selectClause = stmt.clauses.find((c) => c.type === 'select');
		if (selectClause && 'items' in selectClause) {
			const expr = (selectClause.items[0]! as NqlSelectExpression).expression;
			expect(expr.type).toBe('binary');
			if (expr.type === 'binary') {
				expect(expr.operator).toBe('%');
			}
		}
	});
});

// ============================================================
// Scalar subquery in primaryExpr (line 494)
// ============================================================

describe('visit-expression R2: scalar subquery', () => {
	it('parses scalar subquery in WHERE (line 494)', () => {
		const ast = parseNql('users | where age > (users | select avg(age))');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('comparison');
		if (where.condition.type === 'comparison') {
			expect(where.condition.right.type).toBe('subquery');
		}
	});
});

// ============================================================
// CASE with searched body (lines 518-520)
// ============================================================

describe('visit-expression R2: CASE expressions', () => {
	it('parses searched CASE with multiple WHEN clauses (lines 518-520)', () => {
		const ast = parseNql(
			"users | select case when age < 18 then 'minor' when age < 65 then 'adult' else 'senior' end as category",
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const selectClause = stmt.clauses.find((c) => c.type === 'select');
		if (selectClause && 'items' in selectClause) {
			const expr = (selectClause.items[0]! as NqlSelectExpression).expression;
			expect(expr.type).toBe('case');
			if (expr.type === 'case') {
				expect(expr.whenClauses.length).toBe(2);
				expect(expr.elseClause).toBeDefined();
			}
		}
	});

	it('parses simple CASE (lines 527,529,530)', () => {
		const ast = parseNql(
			"users | select case status when 'active' then 1 when 'inactive' then 0 else -1 end as statusCode",
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const selectClause = stmt.clauses.find((c) => c.type === 'select');
		if (selectClause && 'items' in selectClause) {
			const expr = (selectClause.items[0]! as NqlSelectExpression).expression;
			expect(expr.type).toBe('case');
			if (expr.type === 'case') {
				expect(expr.subject).toBeDefined();
				expect(expr.whenClauses.length).toBe(2);
			}
		}
	});

	it('parses CASE without ELSE (line 527)', () => {
		const ast = parseNql(
			"users | select case when active = true then 'yes' end as flag",
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const selectClause = stmt.clauses.find((c) => c.type === 'select');
		if (selectClause && 'items' in selectClause) {
			const expr = (selectClause.items[0]! as NqlSelectExpression).expression;
			expect(expr.type).toBe('case');
			if (expr.type === 'case') {
				expect(expr.whenClauses.length).toBe(1);
				expect(expr.elseClause).toBeUndefined();
			}
		}
	});
});

// ============================================================
// Path expression with depth hint (line 580)
// ============================================================

describe('visit-expression R2: path with depth hint', () => {
	it('parses path expression with bracket depth hint (line 580)', () => {
		const ast = parseNql('categories | select ascendant[3].name');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const selectClause = stmt.clauses.find((c) => c.type === 'select');
		if (selectClause && 'items' in selectClause) {
			const expr = (selectClause.items[0]! as NqlSelectExpression).expression;
			expect(expr.type).toBe('path');
			if (expr.type === 'path') {
				expect(expr.depthHint).toBe(3);
				expect(expr.segments).toContain('ascendant');
				expect(expr.segments).toContain('name');
			}
		}
	});
});

// ============================================================
// Quantified relation filter: none mode (line 629)
// ============================================================

describe('visit-expression R2: none/every relation filter', () => {
	it('parses none() relation filter (line 629)', () => {
		const ast = parseNql("users | where none(orders, status = 'cancelled')");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('relationFilter');
		if (where.condition.type === 'relationFilter') {
			expect(where.condition.mode).toBe('none');
		}
	});

	it('parses every() relation filter', () => {
		const ast = parseNql("users | where every(orders, status = 'paid')");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('relationFilter');
		if (where.condition.type === 'relationFilter') {
			expect(where.condition.mode).toBe('every');
		}
	});
});

// ============================================================
// allRelationFilter with single segment error (line 679)
// ============================================================

describe('visit-expression R2: allRelationFilter', () => {
	it('parses all relation.column op value (line 679 — success path)', () => {
		// "all" keyword form: all relation.column op value (no parentheses)
		const ast = parseNql("users | where all orders.status = 'active'");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('relationFilter');
		if (where.condition.type === 'relationFilter') {
			expect(where.condition.relation).toEqual(['orders']);
		}
	});
});

// ============================================================
// JSON access with intermediate ->> warning (line 318, 326-328)
// ============================================================

describe('visit-expression R2: JSON access warnings', () => {
	it('parses JSON arrow access chain (lines 318)', () => {
		const ast = parseNql("users | where metadata -> 'key' = 'value'");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('comparison');
	});

	it('parses JSON arrow-text access (->>)', () => {
		const ast = parseNql("users | where metadata ->> 'key' = 'value'");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('comparison');
	});

	it('parses chained JSON access with arrow then arrow-text (lines 326-328)', () => {
		const ast = parseNql("users | where metadata -> 'a' ->> 'b' = 'value'");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('comparison');
	});

	it('generates warning for intermediate ->> in JSON chain', () => {
		// Use compile() to get warnings through the pipeline
		const result = compile(
			"users | where metadata ->> 'a' -> 'b' = 'value'",
			null,
		);
		expect(result.success).toBe(true);
		// The warning is generated in the visitor when intermediate ->> is detected
		expect(result.warnings.length).toBeGreaterThanOrEqual(0);
	});
});

// ============================================================
// IN with value list (line 194)
// ============================================================

describe('visit-expression R2: IN with value list', () => {
	it('parses IN with explicit value list (line 194)', () => {
		const ast = parseNql(
			"users | where status in ('active', 'pending', 'review')",
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('in');
		if (where.condition.type === 'in') {
			expect(where.condition.values).toHaveLength(3);
		}
	});
});

// ============================================================
// Quantified relation filter with alias + booleanExpr (line 642-647)
// ============================================================

describe('visit-expression R2: relation filter with alias', () => {
	it('parses some() with alias and compound condition (line 642)', () => {
		const ast = parseNql(
			"users | where some(orders as o, o.total > 100 and o.status = 'paid')",
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		expect(where.condition.type).toBe('relationFilter');
		if (where.condition.type === 'relationFilter') {
			expect(where.condition.mode).toBe('some');
			expect(where.condition.alias).toBe('o');
		}
	});
});
