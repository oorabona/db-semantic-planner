/**
 * Full-Text Search Integration Tests (FR-5)
 *
 * Tests fullTextSearch() and textScore() helpers from @dbsp/core using the
 * compile-only adapter with the full intent pipeline.
 *
 * Every compiled query goes through a model-carrying ORM (`createOrm` with
 * `createPgCompileOnlyAdapter({ model })`) and `.dump()`.
 */

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
	star,
	subquery,
	textScore,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const symbolsDb = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		symbol_id: 'integer',
		name: 'text',
		doc: 'text',
	},
});
const symbolsOrm = createOrm({
	schema: symbolsDb,
	adapter: createPgCompileOnlyAdapter({ model: symbolsDb.model }),
	suppressDxWarnings: true,
});

// ---------------------------------------------------------------------------
// textScore()
// ---------------------------------------------------------------------------

describe('textScore', () => {
	it('accepts a custom key field', () => {
		const { sql, params } = symbolsOrm
			.select('symbols')
			.columns([textScore('symbol_id').as('s')])
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT paradedb.score(symbol_id) AS s FROM symbols',
			params: [],
		});
	});

	it('can be used in ORDER BY (DESC)', () => {
		const { sql, params } = symbolsOrm
			.select('symbols')
			.orderBy(textScore(), 'desc')
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT symbols.* FROM symbols ORDER BY paradedb.score(id) DESC',
			params: [],
		});
	});

	it('can be used in ORDER BY (ASC)', () => {
		const { sql, params } = symbolsOrm
			.select('symbols')
			.orderBy(textScore(), 'asc')
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT symbols.* FROM symbols ORDER BY paradedb.score(id) ASC',
			params: [],
		});
	});
});

// ---------------------------------------------------------------------------
// fullTextSearch()
// ---------------------------------------------------------------------------

describe('fullTextSearch', () => {
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
	const fts = (query: string, fields: { name: string; boost: number }[]) =>
		fullTextSearch({ query, fields, tableAlias: 'symbols' });
	const orderedSearch = (
		query: string,
		fields: { name: string; boost: number }[],
	) =>
		symbolsOrm
			.select('symbols')
			.columns([star(), textScore().as('score')])
			.where(fts(query, fields))
			.orderBy(textScore(), 'desc');

	it('produces correct SELECT + WHERE + ORDER BY with exact SQL structure', () => {
		const { sql, params } = orderedSearch('typescript', [
			{ name: 'name', boost: 3.0 },
			{ name: 'doc', boost: 1.0 },
		]).dump();
		expect({ sql, params }).toEqual({
			sql: "SELECT *, paradedb.score(id) AS score FROM symbols WHERE symbols @@@ paradedb.boolean(should => ARRAY[paradedb.boost(3, paradedb.parse(field => 'name', query_string => $1)), paradedb.boost(1, paradedb.parse(field => 'doc', query_string => $2))]) ORDER BY paradedb.score(id) DESC",
			params: ['typescript', 'typescript'],
		});
	});

	it('produces correct 5-field query matching the spec target SQL structure', () => {
		const { sql, params } = orderedSearch('hello', [
			{ name: 'name_searchable', boost: 3.0 },
			{ name: 'name', boost: 1.0 },
			{ name: 'signature', boost: 1.5 },
			{ name: 'doc_searchable', boost: 1.0 },
			{ name: 'llm_description', boost: 2.0 },
		])
			.limit(50)
			.dump();
		expect({ sql, params }).toEqual({
			sql: "SELECT *, paradedb.score(id) AS score FROM symbols WHERE symbols @@@ paradedb.boolean(should => ARRAY[paradedb.boost(3, paradedb.parse(field => 'name_searchable', query_string => $1)), paradedb.boost(1, paradedb.parse(field => 'name', query_string => $2)), paradedb.boost(1.5, paradedb.parse(field => 'signature', query_string => $3)), paradedb.boost(1, paradedb.parse(field => 'doc_searchable', query_string => $4)), paradedb.boost(2, paradedb.parse(field => 'llm_description', query_string => $5))]) ORDER BY paradedb.score(id) DESC LIMIT 50",
			params: ['hello', 'hello', 'hello', 'hello', 'hello'],
		});
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
		expect(
			run(
				orm
					.select('posts')
					.columns(['id'])
					.union(orm.select('posts').columns(['id'])),
			),
		).toThrow(
			`Invalid fullTextSearch: this builder is not a subquery; use orm.select(...), subquery(table) or a SubqueryExpression`,
		);
		notYet(posts.author.name, 'a relation-reached ColumnRef', 1052);
		notYet(outerRef('id'), 'outerRef()', 1029);
	});

	it('RF2b fts query builder: a select builder is a scalar subquery (ADR 0011 delivery 5)', () => {
		const where = (query: unknown) =>
			orm
				.select('posts')
				.columns(['id'])
				.where(fullTextSearch({ query, fields: one, tableAlias: 'posts' }))
				.dump();
		const one_col = where(orm.select('posts').columns(['title']).limit(1));
		expect([one_col.sql, one_col.params]).toEqual([
			"SELECT posts.id FROM posts WHERE posts @@@ paradedb.boolean(should => ARRAY[paradedb.boost(2, paradedb.parse(field => 'title', query_string => (SELECT posts_1.title FROM posts AS posts_1 LIMIT 1)))])",
			[],
		]);
		expect(() => where(orm.select('posts'))).toThrow(
			'scalar subquery body projects 5 columns; a scalar subquery yields one value.',
		);
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
