
/**
 * Full-Text Search Integration Tests (FR-5)
 *
 * Tests fullTextSearch() and textScore() helpers from @dbsp/core using the
 * compile-only adapter with the full intent pipeline.
 *
 * Uses compilePlan (SimplifiedPlanReport) for unit tests and compileSelect
 * (PlanReport) for full-pipeline tests that include the 't0' root table alias.
 */

import { fullTextSearch, textScore } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ExprRef = ReturnType<typeof textScore>;

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

/** Compile a WHERE expression plan decision with a fullTextSearch expr. */
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
// textScore()
// ---------------------------------------------------------------------------

describe('textScore', () => {
	it('produces paradedb.score(id) in SELECT with default key field', () => {
		const expr = textScore();
		const result = compileSelectExpr(expr, 'score');
		const sql = normalizeSQL(result.sql);

		expect(sql).toEqual('select paradedb.score(id) as score from symbols');
	});

	it('accepts a custom key field', () => {
		const expr = textScore('symbol_id');
		const result = compileSelectExpr(expr, 's');
		const sql = normalizeSQL(result.sql);

		expect(sql).toEqual('select paradedb.score(symbol_id) as s from symbols');
	});

	it('binds no parameters (key field is a column reference)', () => {
		const expr = textScore();
		const result = compileSelectExpr(expr, 'score');
		expect(result.parameters).toHaveLength(0);
	});

	it('can be aliased with .as()', () => {
		const expr = textScore().as('bm25_score');
		const result = compileSelectExpr(expr, 'bm25_score');
		const sql = normalizeSQL(result.sql);

		expect(sql).toEqual('select paradedb.score(id) as bm25_score from symbols');
	});

	it('can be used in ORDER BY (DESC)', () => {
		const expr = textScore();
		const result = compileOrderByExpr(expr, 'DESC');
		const sql = normalizeSQL(result.sql);

		expect(sql).toEqual('select * from symbols order by paradedb.score(id) desc');
	});

	it('can be used in ORDER BY (ASC)', () => {
		const expr = textScore();
		const result = compileOrderByExpr(expr, 'ASC');
		const sql = normalizeSQL(result.sql);

		expect(sql).toEqual('select * from symbols order by paradedb.score(id) asc');
	});
});

// ---------------------------------------------------------------------------
// fullTextSearch()
// ---------------------------------------------------------------------------

describe('fullTextSearch', () => {
	const FIELDS = [
		{ name: 'name_searchable', boost: 3.0 },
		{ name: 'name', boost: 1.0 },
		{ name: 'signature', boost: 1.5 },
		{ name: 'doc_searchable', boost: 1.0 },
		{ name: 'llm_description', boost: 2.0 },
	];

	it('produces the @@@ operator in WHERE', () => {
		const expr = fullTextSearch({ query: 'hello', fields: FIELDS, tableAlias: 's' });
		const result = compileWhereExpr(expr);
		const sql = normalizeSQL(result.sql);

		expect(sql).toEqual("select * from symbols where s @@@ paradedb.boolean(should => array[paradedb.boost(3, paradedb.parse(field => 'name_searchable', query_string => $1)), paradedb.boost(1, paradedb.parse(field => 'name', query_string => $2)), paradedb.boost(1.5, paradedb.parse(field => 'signature', query_string => $3)), paradedb.boost(1, paradedb.parse(field => 'doc_searchable', query_string => $4)), paradedb.boost(2, paradedb.parse(field => 'llm_description', query_string => $5))])");
	});

	it('uses paradedb.boolean with should => ARRAY[...] in WHERE', () => {
		const expr = fullTextSearch({ query: 'hello', fields: FIELDS, tableAlias: 's' });
		const result = compileWhereExpr(expr);
		const sql = normalizeSQL(result.sql);

		expect(sql).toEqual("select * from symbols where s @@@ paradedb.boolean(should => array[paradedb.boost(3, paradedb.parse(field => 'name_searchable', query_string => $1)), paradedb.boost(1, paradedb.parse(field => 'name', query_string => $2)), paradedb.boost(1.5, paradedb.parse(field => 'signature', query_string => $3)), paradedb.boost(1, paradedb.parse(field => 'doc_searchable', query_string => $4)), paradedb.boost(2, paradedb.parse(field => 'llm_description', query_string => $5))])");
	});

	it('includes all field names in WHERE SQL', () => {
		const expr = fullTextSearch({ query: 'hello', fields: FIELDS, tableAlias: 's' });
		const result = compileWhereExpr(expr);
		const sql = normalizeSQL(result.sql);

		expect(sql).toEqual("select * from symbols where s @@@ paradedb.boolean(should => array[paradedb.boost(3, paradedb.parse(field => 'name_searchable', query_string => $1)), paradedb.boost(1, paradedb.parse(field => 'name', query_string => $2)), paradedb.boost(1.5, paradedb.parse(field => 'signature', query_string => $3)), paradedb.boost(1, paradedb.parse(field => 'doc_searchable', query_string => $4)), paradedb.boost(2, paradedb.parse(field => 'llm_description', query_string => $5))])");
	});

	it('wraps each field in paradedb.boost and paradedb.parse', () => {
		const expr = fullTextSearch({ query: 'hello', fields: FIELDS, tableAlias: 's' });
		const result = compileWhereExpr(expr);
		const sql = normalizeSQL(result.sql);

		expect(sql).toEqual("select * from symbols where s @@@ paradedb.boolean(should => array[paradedb.boost(3, paradedb.parse(field => 'name_searchable', query_string => $1)), paradedb.boost(1, paradedb.parse(field => 'name', query_string => $2)), paradedb.boost(1.5, paradedb.parse(field => 'signature', query_string => $3)), paradedb.boost(1, paradedb.parse(field => 'doc_searchable', query_string => $4)), paradedb.boost(2, paradedb.parse(field => 'llm_description', query_string => $5))])");
	});

	it('uses the tableAlias on the left side of @@@', () => {
		const expr = fullTextSearch({ query: 'test', fields: FIELDS, tableAlias: 's' });
		const result = compileWhereExpr(expr);
		const sql = normalizeSQL(result.sql);

		expect(sql).toEqual("select * from symbols where s @@@ paradedb.boolean(should => array[paradedb.boost(3, paradedb.parse(field => 'name_searchable', query_string => $1)), paradedb.boost(1, paradedb.parse(field => 'name', query_string => $2)), paradedb.boost(1.5, paradedb.parse(field => 'signature', query_string => $3)), paradedb.boost(1, paradedb.parse(field => 'doc_searchable', query_string => $4)), paradedb.boost(2, paradedb.parse(field => 'llm_description', query_string => $5))])");
	});

	it('binds one shared parameter for all fields', () => {
		const q = 'typescript';
		const expr = fullTextSearch({ query: q, fields: FIELDS, tableAlias: 's' });
		const result = compileWhereExpr(expr);

		// 5 fields → 5 parameter slots, all with the same value
		expect(result.parameters).toHaveLength(5);
		for (const p of result.parameters) {
			expect(p).toBe(q);
		}
	});

	it('handles a single field', () => {
		const expr = fullTextSearch({
			query: 'test',
			fields: [{ name: 'name', boost: 1.0 }],
			tableAlias: 's',
		});
		const result = compileWhereExpr(expr);
		const sql = normalizeSQL(result.sql);

		expect(sql).toEqual("select * from symbols where s @@@ paradedb.boolean(should => array[paradedb.boost(1, paradedb.parse(field => 'name', query_string => $1))])");
		expect(result.parameters).toHaveLength(1);
		expect(result.parameters[0]).toBe('test');
	});

	it('tableAlias is required — the provided alias is used as LHS of @@@', () => {
		// Bug 3 fix: tableAlias no longer defaults to 't0'.
		// The root table in a standard query has no alias, so the caller must pass
		// the actual table name (or explicit alias) for the @@@ operator.
		const expr = fullTextSearch({
			query: 'hello',
			tableAlias: 'symbols',
			fields: [{ name: 'name', boost: 1.0 }],
		});
		const intent = (expr as unknown as { intent: unknown }).intent;
		const op = intent as { kind: string; left: { kind: string; column: string } };
		expect(op.kind).toBe('customOp');
		expect(op.left.kind).toBe('ref');
		expect(op.left.column).toBe('symbols');
	});
});

// ---------------------------------------------------------------------------
// fullTextSearch + textScore combined
// ---------------------------------------------------------------------------

describe('fullTextSearch + textScore combined', () => {
	it('produces correct SELECT + WHERE + ORDER BY with exact SQL structure', () => {
		const q = 'typescript';
		const whereExpr = fullTextSearch({
			query: q,
			fields: [
				{ name: 'name', boost: 3.0 },
				{ name: 'doc', boost: 1.0 },
			],
			tableAlias: 's',
		});
		const scoreExpr = textScore();

		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'selectCustomExpression',
					expressionIntent: (scoreExpr as unknown as { intent: unknown }).intent,
					alias: 'score',
				},
				{
					type: 'where',
					operator: 'expression',
					expressionIntent: (whereExpr as unknown as { intent: unknown }).intent,
				},
				{
					type: 'orderBy',
					expressionIntent: (scoreExpr as unknown as { intent: unknown }).intent,
					direction: 'DESC',
				},
			],
		};

		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		expect(sql).toEqual("select *, paradedb.score(id) as score from symbols where s @@@ paradedb.boolean(should => array[paradedb.boost(3, paradedb.parse(field => 'name', query_string => $1)), paradedb.boost(1, paradedb.parse(field => 'doc', query_string => $2))]) order by paradedb.score(id) desc");

		// Parameter check: 2 fields → 2 param slots, both with the query value
		expect(result.parameters).toHaveLength(2);
		expect(result.parameters[0]).toBe(q);
		expect(result.parameters[1]).toBe(q);
	});

	it('produces correct 5-field query matching the spec target SQL structure', () => {
		const q = 'hello';
		const whereExpr = fullTextSearch({
			query: q,
			fields: [
				{ name: 'name_searchable', boost: 3.0 },
				{ name: 'name', boost: 1.0 },
				{ name: 'signature', boost: 1.5 },
				{ name: 'doc_searchable', boost: 1.0 },
				{ name: 'llm_description', boost: 2.0 },
			],
			tableAlias: 't0',
		});
		const scoreExpr = textScore();

		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'selectCustomExpression',
					expressionIntent: (scoreExpr as unknown as { intent: unknown }).intent,
					alias: 'score',
				},
				{
					type: 'where',
					operator: 'expression',
					expressionIntent: (whereExpr as unknown as { intent: unknown }).intent,
				},
				{
					type: 'orderBy',
					expressionIntent: (scoreExpr as unknown as { intent: unknown }).intent,
					direction: 'DESC',
				},
				{ type: 'limit', limit: 50 },
			],
		};

		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		// Full structure matches the FR-5 spec target SQL
		expect(sql).toEqual("select *, paradedb.score(id) as score from symbols where t0 @@@ paradedb.boolean(should => array[paradedb.boost(3, paradedb.parse(field => 'name_searchable', query_string => $1)), paradedb.boost(1, paradedb.parse(field => 'name', query_string => $2)), paradedb.boost(1.5, paradedb.parse(field => 'signature', query_string => $3)), paradedb.boost(1, paradedb.parse(field => 'doc_searchable', query_string => $4)), paradedb.boost(2, paradedb.parse(field => 'llm_description', query_string => $5))]) order by paradedb.score(id) desc limit 50");

		// 5 fields → 5 parameters, all equal to the query string
		expect(result.parameters).toHaveLength(5);
		for (const p of result.parameters) {
			expect(p).toBe(q);
		}
	});
});
