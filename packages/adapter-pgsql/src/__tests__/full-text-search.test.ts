/**
 * Full-Text Search Integration Tests (FR-5)
 *
 * Tests fullTextSearch() and textScore() helpers from @dbsp/core using the
 * compile-only adapter with the full intent pipeline.
 *
 * Uses compilePlan (SimplifiedPlanReport) for unit tests and compileSelect
 * (PlanReport) for full-pipeline tests that include the 't0' root table alias.
 */

import {
	compilePlan,
	type SimplifiedPlanReport,
} from '@dbsp/adapter-pgsql/internal';
import {
	caseWhen,
	createOrm,
	eq,
	exprRef,
	fullTextSearch,
	InvalidOperationError,
	literal,
	NotYetSupportedError,
	outerRef,
	param,
	ref,
	schema,
	sql,
	subquery,
	textScore,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

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

		expect(sql).toEqual(
			'select * from symbols order by paradedb.score(id) desc',
		);
	});

	it('can be used in ORDER BY (ASC)', () => {
		const expr = textScore();
		const result = compileOrderByExpr(expr, 'ASC');
		const sql = normalizeSQL(result.sql);

		expect(sql).toEqual(
			'select * from symbols order by paradedb.score(id) asc',
		);
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
		const expr = fullTextSearch({
			query: 'hello',
			fields: FIELDS,
			tableAlias: 's',
		});
		const result = compileWhereExpr(expr);
		const sql = normalizeSQL(result.sql);

		expect(sql).toEqual(
			"select * from symbols where s @@@ paradedb.boolean(should => array[paradedb.boost(3, paradedb.parse(field => 'name_searchable', query_string => $1)), paradedb.boost(1, paradedb.parse(field => 'name', query_string => $2)), paradedb.boost(1.5, paradedb.parse(field => 'signature', query_string => $3)), paradedb.boost(1, paradedb.parse(field => 'doc_searchable', query_string => $4)), paradedb.boost(2, paradedb.parse(field => 'llm_description', query_string => $5))])",
		);
	});

	it('uses paradedb.boolean with should => ARRAY[...] in WHERE', () => {
		const expr = fullTextSearch({
			query: 'hello',
			fields: FIELDS,
			tableAlias: 's',
		});
		const result = compileWhereExpr(expr);
		const sql = normalizeSQL(result.sql);

		expect(sql).toEqual(
			"select * from symbols where s @@@ paradedb.boolean(should => array[paradedb.boost(3, paradedb.parse(field => 'name_searchable', query_string => $1)), paradedb.boost(1, paradedb.parse(field => 'name', query_string => $2)), paradedb.boost(1.5, paradedb.parse(field => 'signature', query_string => $3)), paradedb.boost(1, paradedb.parse(field => 'doc_searchable', query_string => $4)), paradedb.boost(2, paradedb.parse(field => 'llm_description', query_string => $5))])",
		);
	});

	it('includes all field names in WHERE SQL', () => {
		const expr = fullTextSearch({
			query: 'hello',
			fields: FIELDS,
			tableAlias: 's',
		});
		const result = compileWhereExpr(expr);
		const sql = normalizeSQL(result.sql);

		expect(sql).toEqual(
			"select * from symbols where s @@@ paradedb.boolean(should => array[paradedb.boost(3, paradedb.parse(field => 'name_searchable', query_string => $1)), paradedb.boost(1, paradedb.parse(field => 'name', query_string => $2)), paradedb.boost(1.5, paradedb.parse(field => 'signature', query_string => $3)), paradedb.boost(1, paradedb.parse(field => 'doc_searchable', query_string => $4)), paradedb.boost(2, paradedb.parse(field => 'llm_description', query_string => $5))])",
		);
	});

	it('wraps each field in paradedb.boost and paradedb.parse', () => {
		const expr = fullTextSearch({
			query: 'hello',
			fields: FIELDS,
			tableAlias: 's',
		});
		const result = compileWhereExpr(expr);
		const sql = normalizeSQL(result.sql);

		expect(sql).toEqual(
			"select * from symbols where s @@@ paradedb.boolean(should => array[paradedb.boost(3, paradedb.parse(field => 'name_searchable', query_string => $1)), paradedb.boost(1, paradedb.parse(field => 'name', query_string => $2)), paradedb.boost(1.5, paradedb.parse(field => 'signature', query_string => $3)), paradedb.boost(1, paradedb.parse(field => 'doc_searchable', query_string => $4)), paradedb.boost(2, paradedb.parse(field => 'llm_description', query_string => $5))])",
		);
	});

	it('uses the tableAlias on the left side of @@@', () => {
		const expr = fullTextSearch({
			query: 'test',
			fields: FIELDS,
			tableAlias: 's',
		});
		const result = compileWhereExpr(expr);
		const sql = normalizeSQL(result.sql);

		expect(sql).toEqual(
			"select * from symbols where s @@@ paradedb.boolean(should => array[paradedb.boost(3, paradedb.parse(field => 'name_searchable', query_string => $1)), paradedb.boost(1, paradedb.parse(field => 'name', query_string => $2)), paradedb.boost(1.5, paradedb.parse(field => 'signature', query_string => $3)), paradedb.boost(1, paradedb.parse(field => 'doc_searchable', query_string => $4)), paradedb.boost(2, paradedb.parse(field => 'llm_description', query_string => $5))])",
		);
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

		expect(sql).toEqual(
			"select * from symbols where s @@@ paradedb.boolean(should => array[paradedb.boost(1, paradedb.parse(field => 'name', query_string => $1))])",
		);
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
		const op = intent as {
			kind: string;
			left: { kind: string; column: string };
		};
		expect(op.kind).toBe('customOp');
		expect(op.left.kind).toBe('ref');
		expect(op.left.column).toBe('symbols');
	});

	it('resolves tableAlias as a whole-row binding, never a same-named column', () => {
		const model = schema({
			documents: {
				id: { type: 'integer', primaryKey: true },
				doc: 'text',
			},
		}).model;
		const orm = createOrm({
			model,
			adapter: createPgCompileOnlyAdapter({
				model,
				dbCasing: 'snake_case',
			}),
		});

		const query = orm
			.select('documents')
			.where(
				fullTextSearch({
					query: 'database',
					tableAlias: 'documents',
					fields: [{ name: 'doc', boost: 1 }],
				}),
			)
			.dump();

		// Before the whole-row path this attempted declaredColumn(documents,
		// documents), which is absent from this physical model and throws.
		expect(normalizeSQL(query.sql)).toContain('documents @@@');
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
					expressionIntent: (scoreExpr as unknown as { intent: unknown })
						.intent,
					alias: 'score',
				},
				{
					type: 'where',
					operator: 'expression',
					expressionIntent: (whereExpr as unknown as { intent: unknown })
						.intent,
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

		expect(sql).toEqual(
			"select *, paradedb.score(id) as score from symbols where s @@@ paradedb.boolean(should => array[paradedb.boost(3, paradedb.parse(field => 'name', query_string => $1)), paradedb.boost(1, paradedb.parse(field => 'doc', query_string => $2))]) order by paradedb.score(id) desc",
		);

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
					expressionIntent: (scoreExpr as unknown as { intent: unknown })
						.intent,
					alias: 'score',
				},
				{
					type: 'where',
					operator: 'expression',
					expressionIntent: (whereExpr as unknown as { intent: unknown })
						.intent,
				},
				{
					type: 'orderBy',
					expressionIntent: (scoreExpr as unknown as { intent: unknown })
						.intent,
					direction: 'DESC',
				},
				{ type: 'limit', limit: 50 },
			],
		};

		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		// Full structure matches the FR-5 spec target SQL
		expect(sql).toEqual(
			"select *, paradedb.score(id) as score from symbols where t0 @@@ paradedb.boolean(should => array[paradedb.boost(3, paradedb.parse(field => 'name_searchable', query_string => $1)), paradedb.boost(1, paradedb.parse(field => 'name', query_string => $2)), paradedb.boost(1.5, paradedb.parse(field => 'signature', query_string => $3)), paradedb.boost(1, paradedb.parse(field => 'doc_searchable', query_string => $4)), paradedb.boost(2, paradedb.parse(field => 'llm_description', query_string => $5))]) order by paradedb.score(id) desc limit 50",
		);

		// 5 fields → 5 parameters, all equal to the query string
		expect(result.parameters).toHaveLength(5);
		for (const p of result.parameters) {
			expect(p).toBe(q);
		}
	});
});

// ============================================================================
// ADR 0011 delivery 6: query, tableAlias and keyField leaves
// ============================================================================

describe('fullTextSearch and textScore leaves (ADR 0011 delivery 6)', () => {
	const d6Db = schema({
		users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			status: 'text',
			score: 'integer',
			user_id: ref('users', { as: 'author' }),
		},
	});
	const orm = createOrm({
		schema: d6Db,
		adapter: createPgCompileOnlyAdapter({ model: d6Db.model }),
		suppressDxWarnings: true,
	});
	const posts = orm.tables.posts;
	const one = [{ name: 'title', boost: 2 }];
	const two = [
		{ name: 'title', boost: 2 },
		{ name: 'status', boost: 1.5 },
	];
	const search = (query: unknown, fields = one) =>
		orm
			.select('posts')
			.columns(['id'])
			.where(fullTextSearch({ query, fields, tableAlias: 'posts' }))
			.dump();
	const parse = (field: string, q: string) =>
		`paradedb.parse(field => '${field}', query_string => ${q})`;
	const sqlOne = (q: string) =>
		`SELECT posts.id FROM posts WHERE posts @@@ paradedb.boolean(should => ARRAY[paradedb.boost(2, ${parse('title', q)})])`;

	it('AC1 fts expression query: compiled as every field query_string, never bound', () => {
		const ref1 = search(exprRef('status'));
		expect([ref1.sql, ref1.params]).toEqual([sqlOne('posts.status'), []]);
		const lit = search(literal('x'));
		expect([lit.sql, lit.params]).toEqual([sqlOne("'x'"), []]);
		const sub = search(subquery('users').max('name'));
		expect([sub.sql, sub.params]).toEqual([
			sqlOne('(SELECT max(users.name) FROM users)'),
			[],
		]);
		const both = search(exprRef('status'), two);
		expect([both.sql, both.params]).toEqual([
			`SELECT posts.id FROM posts WHERE posts @@@ paradedb.boolean(should => ARRAY[paradedb.boost(2, ${parse('title', 'posts.status')}), paradedb.boost(1.5, ${parse('status', 'posts.status')})])`,
			[],
		]);
	});

	it('AC2 fts param and plain query: bound once per field, null and undefined as given', () => {
		const p = search(param('x'));
		expect([p.sql, p.params]).toEqual([sqlOne('$1'), ['x']]);
		const plain = search('x', two);
		expect([plain.sql, plain.params]).toEqual([
			`SELECT posts.id FROM posts WHERE posts @@@ paradedb.boolean(should => ARRAY[paradedb.boost(2, ${parse('title', '$1')}), paradedb.boost(1.5, ${parse('status', '$2')})])`,
			['x', 'x'],
		]);
		expect(search(null).params).toEqual([null]);
		const undef = search(undefined);
		expect(undef.params).toHaveLength(1);
		expect(undef.params[0]).toBeUndefined();
	});

	it('AC3 textScore ColumnRef: the qualified key column; strings unchanged', () => {
		const withRef = orm
			.select('posts')
			.columns(['id', textScore(posts.id).as('s')])
			.dump();
		expect([withRef.sql, withRef.params]).toEqual([
			'SELECT posts.id, paradedb.score(posts.id) AS s FROM posts',
			[],
		]);
		for (const score of [textScore(), textScore('id')]) {
			expect(
				orm
					.select('posts')
					.columns(['id', score.as('s')])
					.dump().sql,
			).toBe('SELECT posts.id, paradedb.score(id) AS s FROM posts');
		}
	});

	it('RF1 fts tableAlias non-string: refused by kind when the helper is called', () => {
		const message = (kind: string) =>
			`Invalid fullTextSearch: tableAlias must be the name of a table or alias in the FROM clause; got ${kind}`;
		for (const [alias, kind] of [
			[posts.title, 'a ColumnRef'],
			[exprRef('posts'), 'an expression'],
			[2, 'a number'],
			[null, 'null'],
			[undefined, 'undefined'],
		] as const) {
			const run = () =>
				fullTextSearch({ query: 'x', fields: one, tableAlias: alias as never });
			expect(run).toThrow(InvalidOperationError);
			expect(run).toThrow(message(kind));
		}
	});

	it('RF2 fts query refusals: sql(), unfinished caseWhen, builders, relation refs and outerRef()', () => {
		const run = (query: unknown) => () =>
			fullTextSearch({ query, fields: one, tableAlias: 'posts' });
		expect(run(sql('1'))).toThrow(
			'Invalid fullTextSearch: sql() is only accepted in set(), values(), doUpdate() and batchSet().set(); use literal(), param() or an expression here',
		);
		expect(run(caseWhen(eq('score', 1), literal('a')))).toThrow(
			'Invalid fullTextSearch: caseWhen() is unfinished; complete it with .else(value) before using it as a value',
		);
		const notYet = (query: unknown, construct: string, issue: number) => {
			let caught: unknown;
			try {
				run(query)();
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(NotYetSupportedError);
			const e = caught as NotYetSupportedError;
			expect([e.construct, e.position, e.issue]).toEqual([
				construct,
				'expression argument',
				issue,
			]);
		};
		notYet(orm.select('posts'), 'a query builder', 1053);
		notYet(posts.author.name, 'a relation-reached ColumnRef', 1052);
		notYet(outerRef('id'), 'outerRef()', 1029);
	});

	it('RF10 textScore refusals: plain values and relation ColumnRefs', () => {
		const refusal = (kind: string) =>
			`Invalid textScore: ${kind} is not an expression argument; use literal(null), param(value) or an expression`;
		expect(() => textScore(null as never)).toThrow(refusal('null'));
		expect(() => textScore({} as never)).toThrow(refusal('a plain object'));
		let caught: unknown;
		try {
			textScore(posts.author.id);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(NotYetSupportedError);
		const e = caught as NotYetSupportedError;
		expect([e.construct, e.position, e.issue]).toEqual([
			'a relation-reached ColumnRef',
			'expression argument',
			1052,
		]);
	});
});
