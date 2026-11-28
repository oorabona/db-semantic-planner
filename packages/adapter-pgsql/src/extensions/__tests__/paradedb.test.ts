/**
 * ParadeDB Extension Integration Tests
 *
 * Tests the ParadeDB wrappers (score, parse, boost, booleanSearch, bm25Search)
 * using the compile-only adapter with the full intent pipeline.
 *
 * Every query goes through a model-carrying ORM and `.dump()`.
 */

import {
	param as coreParam,
	createOrm,
	type ExpressionRef,
	exprRef,
	InvalidOperationError,
	literal,
	NotYetSupportedError,
	type ReferenceLeaf,
	ref,
	schema,
	sql,
	subquery,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../../pgsql-adapter.js';
import { bm25Search, booleanSearch, boost, parse, score } from '../paradedb.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const db = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: 'text',
		doc: 'text',
	},
});
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
	suppressDxWarnings: true,
});

type ExprRef = ReturnType<typeof score>;

/** Dump `SELECT <expr> AS <alias> FROM symbols` through the model-carrying ORM. */
function dumpSelectExpr(
	expr: ExprRef,
	alias: string,
): { sql: string; params: readonly unknown[] } {
	const { sql, params } = orm
		.select('symbols')
		.columns([expr.as(alias)])
		.dump();
	return { sql, params };
}

// ---------------------------------------------------------------------------
// score()
// ---------------------------------------------------------------------------

describe('score', () => {
	it('produces paradedb.score("keyField") in SELECT', () => {
		expect(dumpSelectExpr(score('id'), 'bm25_score')).toEqual({
			sql: 'SELECT paradedb.score(id) AS bm25_score FROM symbols',
			params: [],
		});
	});

	it('binds no parameters (key field is a column ref)', () => {
		expect(dumpSelectExpr(score('id'), 'bm25_score')).toEqual({
			sql: 'SELECT paradedb.score(id) AS bm25_score FROM symbols',
			params: [],
		});
	});

	it('works with dotted table.column reference', () => {
		expect(dumpSelectExpr(score('symbols.id'), 'bm25_score')).toEqual({
			sql: 'SELECT paradedb.score(symbols.id) AS bm25_score FROM symbols',
			params: [],
		});
	});

	it('can be used in ORDER BY', () => {
		const { sql, params } = orm
			.select('symbols')
			.orderBy(score('id'), 'desc')
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT symbols.* FROM symbols ORDER BY paradedb.score(id) DESC',
			params: [],
		});
	});
});

// ---------------------------------------------------------------------------
// parse()
// ---------------------------------------------------------------------------

describe('parse', () => {
	it('produces paradedb.parse with field literal and query param', () => {
		expect(dumpSelectExpr(parse('name', 'hello'), 'p')).toEqual({
			sql: "SELECT paradedb.parse(field => 'name', query_string => $1) AS p FROM symbols",
			params: ['hello'],
		});
	});

	it('accepts an ExpressionRef as query argument', () => {
		// When the caller already has a param ExpressionRef
		const queryParam = coreParam('world');
		expect(dumpSelectExpr(parse('doc', queryParam), 'p')).toEqual({
			sql: "SELECT paradedb.parse(field => 'doc', query_string => $1) AS p FROM symbols",
			params: ['world'],
		});
	});

	it('uses named argument syntax: field => ... and query_string => ...', () => {
		expect(dumpSelectExpr(parse('name_searchable', 'hello'), 'p')).toEqual({
			sql: "SELECT paradedb.parse(field => 'name_searchable', query_string => $1) AS p FROM symbols",
			params: ['hello'],
		});
	});
});

// ---------------------------------------------------------------------------
// boost()
// ---------------------------------------------------------------------------

describe('boost', () => {
	it('wraps an expression with a factor', () => {
		expect(dumpSelectExpr(boost(3.0, parse('name', 'test')), 'b')).toEqual({
			sql: "SELECT paradedb.boost(3, paradedb.parse(field => 'name', query_string => $1)) AS b FROM symbols",
			params: ['test'],
		});
	});

	it('handles integer factor', () => {
		expect(dumpSelectExpr(boost(1, parse('doc', 'query')), 'b')).toEqual({
			sql: "SELECT paradedb.boost(1, paradedb.parse(field => 'doc', query_string => $1)) AS b FROM symbols",
			params: ['query'],
		});
	});
});

// ---------------------------------------------------------------------------
// booleanSearch()
// ---------------------------------------------------------------------------

describe('booleanSearch', () => {
	const q = 'typescript';
	const searched = () =>
		dumpSelectExpr(
			booleanSearch([
				boost(3.0, parse('name', q)),
				boost(1.0, parse('doc', q)),
			]),
			'bool',
		);
	const expected = {
		sql: "SELECT paradedb.boolean(should => ARRAY[paradedb.boost(3, paradedb.parse(field => 'name', query_string => $1)), paradedb.boost(1, paradedb.parse(field => 'doc', query_string => $2))]) AS bool FROM symbols",
		params: [q, q],
	};

	it('combines multiple expressions into paradedb.boolean call', () => {
		expect(searched()).toEqual(expected);
	});

	it('binds a parameter per parse call', () => {
		// Each parse() call binds its own parameter slot
		expect(searched()).toEqual(expected);
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
	const fourFields = () =>
		`SELECT symbols.* FROM symbols WHERE symbols @@@ paradedb.boolean(should => ARRAY[paradedb.boost(3, paradedb.parse('name_searchable', $1)), paradedb.boost(1, paradedb.parse('name', $2)), paradedb.boost(1.5, paradedb.parse('signature', $3)), paradedb.boost(1, paradedb.parse('doc_searchable', $4))])`;
	const dumpWhere = (expr: ExprRef) => {
		const { sql, params } = orm
			.select('symbols')
			// bm25Search() returns an ExpressionRef, which where() does not type-accept
			.where(expr as never)
			.dump();
		return { sql, params };
	};

	it('produces the @@@ operator in WHERE', () => {
		expect(dumpWhere(bm25Search('symbols', 'hello', FIELD_BOOSTS))).toEqual({
			sql: fourFields(),
			params: ['hello', 'hello', 'hello', 'hello'],
		});
	});

	it('includes all field boosts in the generated SQL', () => {
		expect(dumpWhere(bm25Search('symbols', 'hello', FIELD_BOOSTS))).toEqual({
			sql: fourFields(),
			params: ['hello', 'hello', 'hello', 'hello'],
		});
	});

	it('references the table alias on the left side of @@@', () => {
		expect(dumpWhere(bm25Search('symbols', 'hello', FIELD_BOOSTS))).toEqual({
			sql: fourFields(),
			params: ['hello', 'hello', 'hello', 'hello'],
		});
	});

	it('binds one parameter per field (same value)', () => {
		const q = 'hello';
		const { params } = dumpWhere(bm25Search('symbols', q, FIELD_BOOSTS));
		// 4 fields → 4 query param slots, all with the same value
		expect(params).toEqual([q, q, q, q]);
	});

	it('handles single-field boost', () => {
		expect(dumpWhere(bm25Search('symbols', 'test', { name: 1.0 }))).toEqual({
			sql: "SELECT symbols.* FROM symbols WHERE symbols @@@ paradedb.boolean(should => ARRAY[paradedb.boost(1, paradedb.parse('name', $1))])",
			params: ['test'],
		});
	});

	it('can be combined with score() for full SELECT + WHERE + ORDER BY pattern', () => {
		const q = 'typescript';
		const { sql, params } = orm
			.select('symbols')
			.columns([score('id').as('bm25_score')])
			.where(bm25Search('symbols', q, { name: 3.0, doc: 1.0 }) as never)
			.orderBy(score('id'), 'desc')
			.dump();
		expect({ sql, params }).toEqual({
			sql: "SELECT paradedb.score(id) AS bm25_score FROM symbols WHERE symbols @@@ paradedb.boolean(should => ARRAY[paradedb.boost(3, paradedb.parse('name', $1)), paradedb.boost(1, paradedb.parse('doc', $2))]) ORDER BY paradedb.score(id) DESC",
			params: [q, q],
		});
	});
});

// ---------------------------------------------------------------------------
// ADR 0011 leaf rule (#1082): the query is a value leaf, the key field and the
// sub-expressions are reference leaves, the table and field are names.
// ---------------------------------------------------------------------------

describe('ParadeDB helper leaves (#1082)', () => {
	const leafDb = schema({
		users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			published: 'boolean',
			score: 'integer',
			user_id: ref('users', { as: 'author' }),
		},
	});
	const leafOrm = createOrm({
		schema: leafDb,
		adapter: createPgCompileOnlyAdapter({ model: leafDb.model }),
		suppressDxWarnings: true,
	});
	const T = leafOrm.tables;
	const select = (expr: ExpressionRef) => {
		const { sql, params } = leafOrm
			.select('posts')
			.columns([expr.as('v')])
			.dump();
		return { sql, params };
	};
	const where = (expr: ExpressionRef) => {
		const { sql, params } = leafOrm
			.select('posts')
			.columns(['id'])
			.where(expr as never)
			.dump();
		return { sql, params };
	};
	const refused = (helper: string, reason: string) =>
		new InvalidOperationError(helper, reason);
	const notAnArgument = (helper: string, kind: string) =>
		refused(
			helper,
			`${kind} is not an expression argument; use literal(null), param(value) or an expression`,
		);

	it('AC-B1 / plain', () => {
		expect(where(bm25Search('posts', 'hello', { title: 2, body: 1 }))).toEqual({
			sql: "SELECT posts.id FROM posts WHERE posts @@@ paradedb.boolean(should => ARRAY[paradedb.boost(2, paradedb.parse('title', $1)), paradedb.boost(1, paradedb.parse('body', $2))])",
			params: ['hello', 'hello'],
		});
	});
	it('AC-B1 / param', () => {
		expect(
			where(bm25Search('posts', coreParam('hello'), { title: 2, body: 1 })),
		).toEqual({
			sql: "SELECT posts.id FROM posts WHERE posts @@@ paradedb.boolean(should => ARRAY[paradedb.boost(2, paradedb.parse('title', $1)), paradedb.boost(1, paradedb.parse('body', $2))])",
			params: ['hello', 'hello'],
		});
	});
	it('AC-B1 / expression', () => {
		expect(
			where(bm25Search('posts', literal('hello'), { title: 2, body: 1 })),
		).toEqual({
			sql: "SELECT posts.id FROM posts WHERE posts @@@ paradedb.boolean(should => ARRAY[paradedb.boost(2, paradedb.parse('title', 'hello')), paradedb.boost(1, paradedb.parse('body', 'hello'))])",
			params: [],
		});
	});
	it('AC-B1 / ColumnRef', () => {
		expect(where(bm25Search('posts', T.posts.title, { title: 2 }))).toEqual({
			sql: "SELECT posts.id FROM posts WHERE posts @@@ paradedb.boolean(should => ARRAY[paradedb.boost(2, paradedb.parse('title', posts.title))])",
			params: [],
		});
	});
	it('AC-B1 / null', () => {
		expect(where(bm25Search('posts', null, { title: 2 }))).toEqual({
			sql: "SELECT posts.id FROM posts WHERE posts @@@ paradedb.boolean(should => ARRAY[paradedb.boost(2, paradedb.parse('title', $1))])",
			params: [null],
		});
	});
	it('AC-B2 / plain', () => {
		expect(select(parse('title', 'q'))).toEqual({
			sql: "SELECT paradedb.parse(field => 'title', query_string => $1) AS v FROM posts",
			params: ['q'],
		});
	});
	it('AC-B2 / ColumnRef', () => {
		expect(select(parse('title', T.posts.title))).toEqual({
			sql: "SELECT paradedb.parse(field => 'title', query_string => posts.title) AS v FROM posts",
			params: [],
		});
	});
	it('AC-B2 / subquery', () => {
		expect(select(parse('title', subquery('posts').count()))).toEqual({
			sql: "SELECT paradedb.parse(field => 'title', query_string => (SELECT count(*) FROM posts AS posts_1)) AS v FROM posts",
			params: [],
		});
	});
	it('AC-B4 / string', () => {
		expect(select(score('id'))).toEqual({
			sql: 'SELECT paradedb.score(id) AS v FROM posts',
			params: [],
		});
	});
	it('AC-B4 / number', () => {
		expect(select(score(2))).toEqual({
			sql: 'SELECT paradedb.score(2) AS v FROM posts',
			params: [],
		});
	});
	it('AC-B4 / ColumnRef', () => {
		expect(select(score(T.posts.id))).toEqual({
			sql: 'SELECT paradedb.score(posts.id) AS v FROM posts',
			params: [],
		});
	});
	it('AC-B7 / unchanged', () => {
		expect(select(boost(2, parse('title', 'q')))).toEqual({
			sql: "SELECT paradedb.boost(2, paradedb.parse(field => 'title', query_string => $1)) AS v FROM posts",
			params: ['q'],
		});
		expect(select(booleanSearch([boost(2, parse('title', 'q'))]))).toEqual({
			sql: "SELECT paradedb.boolean(should => ARRAY[paradedb.boost(2, paradedb.parse(field => 'title', query_string => $1))]) AS v FROM posts",
			params: ['q'],
		});
	});
	it('AC-B8 / types: boost and booleanSearch take reference leaves', () => {
		const list: readonly ReferenceLeaf[] = [T.posts.title];
		expect(select(boost(2, T.posts.title))).toEqual({
			sql: 'SELECT paradedb.boost(2, posts.title) AS v FROM posts',
			params: [],
		});
		expect(select(booleanSearch(list))).toEqual({
			sql: 'SELECT paradedb.boolean(should => ARRAY[posts.title]) AS v FROM posts',
			params: [],
		});
	});

	it('RT-B3 / table', () => {
		expect(() =>
			where(bm25Search(T.posts.title as never, 'q', { title: 1 })),
		).toThrowError(
			refused(
				'bm25Search',
				'table must be the name of a table or alias in the FROM clause; got a ColumnRef',
			),
		);
		expect(() => where(bm25Search(2 as never, 'q', { title: 1 }))).toThrowError(
			refused(
				'bm25Search',
				'table must be the name of a table or alias in the FROM clause; got a number',
			),
		);
	});
	it('RT-B3 / field', () => {
		expect(() => select(parse(exprRef('title') as never, 'q'))).toThrowError(
			refused(
				'parse',
				'field must be the name of a column in the BM25 index; got an expression',
			),
		);
		expect(() => select(parse(null as never, 'q'))).toThrowError(
			refused(
				'parse',
				'field must be the name of a column in the BM25 index; got null',
			),
		);
	});
	it('RT-B4 / null', () => {
		expect(() => select(score(null as never))).toThrowError(
			notAnArgument('score', 'null'),
		);
		expect(() => select(score(undefined as never))).toThrowError(
			notAnArgument('score', 'undefined'),
		);
		expect(() => select(score({ a: 1 } as never))).toThrowError(
			notAnArgument('score', 'a plain object'),
		);
	});
	it('RT-B4 / relation', () => {
		expect(() => select(score(T.posts.author.name))).toThrowError(
			new NotYetSupportedError(
				'a relation-reached ColumnRef',
				'expression argument',
				1052,
			),
		);
	});
	it('RT-B1 / sql', () => {
		expect(() =>
			where(bm25Search('posts', sql('1'), { title: 1 })),
		).toThrowError(
			refused(
				'bm25Search',
				'sql() is only accepted in set(), values(), doUpdate() and batchSet().set(); use literal(), param() or an expression here',
			),
		);
	});
	it('RT-B7 / null', () => {
		expect(() => select(boost(2, null as never))).toThrowError(
			notAnArgument('boost', 'null'),
		);
		expect(() => select(booleanSearch([null as never]))).toThrowError(
			notAnArgument('booleanSearch', 'null'),
		);
	});
});
