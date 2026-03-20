/**
 * ParadeDB Extension Integration Tests
 *
 * Tests the ParadeDB wrappers (score, parse, boost, booleanSearch, bm25Search)
 * using the compile-only adapter with the full intent pipeline.
 *
 * Uses compilePlan directly for precise control over decisions.
 */

import { param as coreParam } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../../ast-helpers.js';
import { compilePlan, type SimplifiedPlanReport } from '../../compiler.js';
import { bm25Search, booleanSearch, boost, parse, score } from '../paradedb.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ExprRef = ReturnType<typeof score>;

/** Compile a selectCustomExpression plan decision. */
function compileSelectExpr(
	expr: ExprRef,
	alias: string,
): { sql: string; parameters: readonly unknown[] } {
	const plan: SimplifiedPlanReport = {
		rootTable: 'symbols',
		decisions: [
			{
				type: 'selectCustomExpression',
				expressionIntent: (expr as unknown as { intent: unknown }).intent,
				alias,
			},
		],
	};
	return compilePlan(plan);
}

/** Compile a WHERE expression plan decision. */
function compileWhereExpr(expr: ExprRef): {
	sql: string;
	parameters: readonly unknown[];
} {
	const plan: SimplifiedPlanReport = {
		rootTable: 'symbols',
		decisions: [
			{ type: 'select', column: '*' },
			{
				type: 'where',
				operator: 'expression',
				expressionIntent: (expr as unknown as { intent: unknown }).intent,
				value: 0,
				subqueryOperator: '=',
			},
		],
	};
	return compilePlan(plan);
}

/** Compile an ORDER BY expression plan decision. */
function compileOrderByExpr(
	expr: ExprRef,
	direction: 'ASC' | 'DESC' = 'DESC',
): { sql: string; parameters: readonly unknown[] } {
	const plan: SimplifiedPlanReport = {
		rootTable: 'symbols',
		decisions: [
			{ type: 'select', column: '*' },
			{
				type: 'orderBy',
				expressionIntent: (expr as unknown as { intent: unknown }).intent,
				direction,
			},
		],
	};
	return compilePlan(plan);
}

// ---------------------------------------------------------------------------
// score()
// ---------------------------------------------------------------------------

describe('score', () => {
	it('produces paradedb.score("keyField") in SELECT', () => {
		const expr = score('id');
		const result = compileSelectExpr(expr, 'bm25_score');
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('paradedb.score');
		expect(sql).toContain('id');
		expect(sql).toContain('bm25_score');
	});

	it('binds no parameters (key field is a column ref)', () => {
		const expr = score('id');
		const result = compileSelectExpr(expr, 'bm25_score');
		expect(result.parameters).toHaveLength(0);
	});

	it('works with dotted table.column reference', () => {
		const expr = score('s.id');
		const result = compileSelectExpr(expr, 'bm25_score');
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('paradedb.score');
		expect(sql).toContain('id');
	});

	it('can be used in ORDER BY', () => {
		const expr = score('id');
		const result = compileOrderByExpr(expr, 'DESC');
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('paradedb.score');
		expect(sql).toContain('order by');
		expect(sql).toContain('desc');
	});
});

// ---------------------------------------------------------------------------
// parse()
// ---------------------------------------------------------------------------

describe('parse', () => {
	it('produces paradedb.parse with field literal and query param', () => {
		const expr = parse('name', 'hello');
		const result = compileSelectExpr(expr, 'p');
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('paradedb.parse');
		expect(sql).toContain("'name'");
		expect(sql).toContain('$1');
		expect(result.parameters).toHaveLength(1);
		expect(result.parameters[0]).toBe('hello');
	});

	it('accepts an ExpressionRef as query argument', () => {
		// When the caller already has a param ExpressionRef
		const queryParam = coreParam('world');
		const expr = parse('doc', queryParam);
		const result = compileSelectExpr(expr, 'p');
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('paradedb.parse');
		expect(sql).toContain("'doc'");
		expect(sql).toContain('$1');
		expect(result.parameters[0]).toBe('world');
	});
});

// ---------------------------------------------------------------------------
// boost()
// ---------------------------------------------------------------------------

describe('boost', () => {
	it('wraps an expression with a factor', () => {
		const expr = boost(3.0, parse('name', 'test'));
		const result = compileSelectExpr(expr, 'b');
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('paradedb.boost');
		expect(sql).toContain('3');
		expect(sql).toContain('paradedb.parse');
		expect(result.parameters).toHaveLength(1);
		expect(result.parameters[0]).toBe('test');
	});

	it('handles integer factor', () => {
		const expr = boost(1, parse('doc', 'query'));
		const result = compileSelectExpr(expr, 'b');
		const sql = normalizeSQL(result.sql);
		expect(sql).toContain('paradedb.boost');
	});
});

// ---------------------------------------------------------------------------
// booleanSearch()
// ---------------------------------------------------------------------------

describe('booleanSearch', () => {
	it('combines multiple expressions into paradedb.boolean call', () => {
		const q = 'typescript';
		const expr = booleanSearch([
			boost(3.0, parse('name', q)),
			boost(1.0, parse('doc', q)),
		]);
		const result = compileSelectExpr(expr, 'bool');
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('paradedb.boolean');
		expect(sql).toContain('paradedb.boost');
		expect(sql).toContain('paradedb.parse');
	});

	it('binds a parameter per parse call', () => {
		const q = 'typescript';
		const expr = booleanSearch([
			boost(3.0, parse('name', q)),
			boost(1.0, parse('doc', q)),
		]);
		const result = compileSelectExpr(expr, 'bool');
		// Each parse() call binds its own parameter slot
		expect(result.parameters).toHaveLength(2);
		expect(result.parameters[0]).toBe(q);
		expect(result.parameters[1]).toBe(q);
	});
});

// ---------------------------------------------------------------------------
// bm25Search()
// ---------------------------------------------------------------------------

describe('bm25Search', () => {
	const FIELD_BOOSTS = {
		name_searchable: 3.0,
		name: 1.0,
		signature: 1.5,
		doc_searchable: 1.0,
	};

	it('produces the @@@ operator in WHERE', () => {
		const expr = bm25Search('s', 'hello', FIELD_BOOSTS);
		const result = compileWhereExpr(expr);
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('@@@');
		expect(sql).toContain('paradedb.boolean');
		expect(sql).toContain('paradedb.boost');
		expect(sql).toContain('paradedb.parse');
	});

	it('includes all field boosts in the generated SQL', () => {
		const expr = bm25Search('s', 'hello', FIELD_BOOSTS);
		const result = compileWhereExpr(expr);
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain("'name_searchable'");
		expect(sql).toContain("'signature'");
		expect(sql).toContain("'doc_searchable'");
	});

	it('references the table alias on the left side of @@@', () => {
		const expr = bm25Search('s', 'hello', FIELD_BOOSTS);
		const result = compileWhereExpr(expr);
		const sql = normalizeSQL(result.sql);

		// Table alias appears unquoted in the @@@  expression
		expect(sql).toContain('s @@@');
	});

	it('binds one parameter per field (same value)', () => {
		const q = 'hello';
		const expr = bm25Search('s', q, FIELD_BOOSTS);
		const result = compileWhereExpr(expr);

		// 4 fields → 4 query param slots + 1 for the WHERE value comparison
		// All query params have the same value; last param is the WHERE value (0)
		expect(result.parameters).toHaveLength(5);
		for (const p of result.parameters.slice(0, 4)) {
			expect(p).toBe(q);
		}
	});

	it('handles single-field boost', () => {
		const expr = bm25Search('symbols', 'test', { name: 1.0 });
		const result = compileWhereExpr(expr);
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('@@@');
		expect(sql).toContain('paradedb.boolean');
		// 1 field query param + 1 WHERE value param
		expect(result.parameters).toHaveLength(2);
		expect(result.parameters[0]).toBe('test');
	});

	it('can be combined with score() for full SELECT + WHERE + ORDER BY pattern', () => {
		const q = 'typescript';
		const whereExpr = bm25Search('s', q, { name: 3.0, doc: 1.0 });
		const scoreExpr = score('id');

		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'selectCustomExpression',
					expressionIntent: (scoreExpr as unknown as { intent: unknown })
						.intent,
					alias: 'bm25_score',
				},
				{
					type: 'where',
					operator: 'expression',
					expressionIntent: (whereExpr as unknown as { intent: unknown })
						.intent,
					value: 0,
					subqueryOperator: '=',
				},
				{
					type: 'orderBy',
					expressionIntent: (scoreExpr as unknown as { intent: unknown })
						.intent,
					direction: 'DESC',
				},
			],
		};
		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('@@@');
		expect(sql).toContain('paradedb.score');
		expect(sql).toContain('paradedb.boolean');
		expect(sql).toContain('order by');
		expect(sql).toContain('desc');
	});
});
