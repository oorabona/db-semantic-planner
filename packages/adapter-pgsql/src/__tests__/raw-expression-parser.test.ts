/**
 * Tests for the pure-TypeScript raw SQL expression parser.
 *
 * Strategy: compare deparsed SQL output of our parser against
 * the deparsed output of pgsql-parser's parseSync. This verifies
 * that deparseSync can consume our AST nodes and produces identical SQL,
 * without requiring exact structural equality (which would fail on
 * `location` fields and minor format differences).
 */

import type { Node } from '@pgsql/types';
import { deparseSync } from 'pgsql-deparser';
import { parseSync } from 'pgsql-parser';
import { describe, expect, it } from 'vitest';

import { parseExpression } from '../raw-expression-parser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the expression node from a parseSync result.
 * Wraps the fragment in SELECT to get a valid statement.
 */
function parseViaLibpg(sql: string): Node {
	const parsed = parseSync(`SELECT ${sql}`);
	if (!parsed.stmts) {
		throw new Error('PostgreSQL parser returned no statements');
	}
	const val = (
		parsed.stmts[0]!.stmt as {
			SelectStmt: {
				targetList: Array<{ ResTarget: { val: Node } }>;
			};
		}
	).SelectStmt.targetList[0]!.ResTarget.val;
	return val;
}

/**
 * Deparse a node back to SQL by embedding it in a minimal SELECT statement.
 */
function deparseNode(node: Node): string {
	const stmt: Node = {
		SelectStmt: {
			targetList: [
				{
					ResTarget: {
						val: node,
					},
				},
			],
			limitOption: 'LIMIT_OPTION_DEFAULT',
			op: 'SETOP_NONE',
		},
	};
	return deparseSync({ stmts: [{ stmt }] });
}

/**
 * For each expression, verify our parser deparsed SQL matches parseSync's.
 */
function expectMatchesLibpg(expr: string) {
	const ourNode = parseExpression(expr);
	const libNode = parseViaLibpg(expr);
	const ourSql = deparseNode(ourNode);
	const libSql = deparseNode(libNode);
	expect(ourSql).toBe(libSql);
}

// ---------------------------------------------------------------------------
// Function calls
// ---------------------------------------------------------------------------

describe('parseExpression — function calls', () => {
	it('parses now()', () => {
		expectMatchesLibpg('now()');
	});

	it('parses gen_random_uuid()', () => {
		expectMatchesLibpg('gen_random_uuid()');
	});

	it('parses COALESCE(a, b)', () => {
		expectMatchesLibpg('COALESCE(a, b)');
	});

	it('parses count(x)', () => {
		expectMatchesLibpg('count(x)');
	});
});

// ---------------------------------------------------------------------------
// Column references
// ---------------------------------------------------------------------------

describe('parseExpression — column references', () => {
	it('parses plain identifier: count', () => {
		expectMatchesLibpg('count');
	});

	it('parses qualified identifier: excluded.count', () => {
		expectMatchesLibpg('excluded.count');
	});

	it('parses qualified identifier: excluded.name', () => {
		expectMatchesLibpg('excluded.name');
	});
});

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

describe('parseExpression — float literals', () => {
	it('parses float literal: 3.14', () => {
		expectMatchesLibpg('3.14');
	});

	it('parses float literal: 1.5 + 2.7', () => {
		expectMatchesLibpg('1.5 + 2.7');
	});

	it('parses float literal: 0.5', () => {
		expectMatchesLibpg('0.5');
	});

	it('produces Float AST node with fval string for 3.14', () => {
		const node = parseExpression('3.14') as unknown as {
			A_Const: { fval: { fval: string } };
		};
		expect(node.A_Const.fval.fval).toBe('3.14');
	});

	it('produces Float operands for 1.5 + 2.7', () => {
		const node = parseExpression('1.5 + 2.7') as unknown as {
			A_Expr: {
				lexpr: { A_Const: { fval: { fval: string } } };
				rexpr: { A_Const: { fval: { fval: string } } };
			};
		};
		expect(node.A_Expr.lexpr.A_Const.fval.fval).toBe('1.5');
		expect(node.A_Expr.rexpr.A_Const.fval.fval).toBe('2.7');
	});

	it('treats 3. (no fractional digits) as integer + DOT token', () => {
		// "3." should NOT be a float — no digits after the dot
		// It tokenises as INT(3) DOT, which will fail to parse (trailing DOT)
		expect(() => parseExpression('3.')).toThrow();
	});
});

describe('parseExpression — arithmetic', () => {
	it('parses integer literal: 1', () => {
		expectMatchesLibpg('1');
	});

	it('parses excluded.count + 1', () => {
		expectMatchesLibpg('excluded.count + 1');
	});

	it('parses count + 1', () => {
		expectMatchesLibpg('count + 1');
	});

	it('respects precedence: a + b * c', () => {
		expectMatchesLibpg('a + b * c');
	});

	it('parses subtraction: x - 1', () => {
		expectMatchesLibpg('x - 1');
	});

	it('parses division: total / 100', () => {
		expectMatchesLibpg('total / 100');
	});
});

// ---------------------------------------------------------------------------
// String literals
// ---------------------------------------------------------------------------

describe('parseExpression — string literals', () => {
	it("parses 'text'", () => {
		expectMatchesLibpg("'text'");
	});

	it("parses empty string ''", () => {
		expectMatchesLibpg("''");
	});
});

// ---------------------------------------------------------------------------
// TypeCast (::)
// ---------------------------------------------------------------------------

describe('parseExpression — type casts', () => {
	it('parses now()::timestamp', () => {
		expectMatchesLibpg('now()::timestamp');
	});
});

// ---------------------------------------------------------------------------
// Parenthesized expressions
// ---------------------------------------------------------------------------

describe('parseExpression — parentheses', () => {
	it('parses (a + b) * c', () => {
		expectMatchesLibpg('(a + b) * c');
	});
});

// ---------------------------------------------------------------------------
// Round-trip: deparse produces valid SQL (smoke test)
// ---------------------------------------------------------------------------

describe('parseExpression — deparse round-trip', () => {
	const cases = [
		'now()',
		'gen_random_uuid()',
		'excluded.count + 1',
		'COALESCE(a, b)',
	];

	for (const expr of cases) {
		it(`produces deparseable node for: ${expr}`, () => {
			const node = parseExpression(expr);
			// If deparseSync throws, the test fails
			expect(() => deparseNode(node)).not.toThrow();
			const sql = deparseNode(node);
			expect(sql.length).toBeGreaterThan(0);
		});
	}
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('parseExpression — error cases', () => {
	it('throws on empty string', () => {
		expect(() => parseExpression('')).toThrow('empty');
	});

	it('throws on whitespace-only string', () => {
		expect(() => parseExpression('   ')).toThrow('empty');
	});

	it('throws on unexpected character', () => {
		expect(() => parseExpression('@invalid')).toThrow();
	});

	it('throws on trailing tokens', () => {
		expect(() => parseExpression('now() extra')).toThrow('trailing');
	});
});
