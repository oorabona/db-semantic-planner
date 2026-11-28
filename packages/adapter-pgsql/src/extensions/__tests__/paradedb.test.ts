/**
 * ParadeDB Extension Integration Tests
 *
 * Tests the ParadeDB wrappers (score, parse, boost, booleanSearch)
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
import { booleanSearch, boost, parse, score } from '../paradedb.js';

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
	const refused = (helper: string, reason: string) =>
		new InvalidOperationError(helper, reason);
	const notAnArgument = (helper: string, kind: string) =>
		refused(
			helper,
			`${kind} is not an expression argument; use literal(null), param(value) or an expression`,
		);

	it('AC-B2 / plain', () => {
		expect(select(parse('title', 'q'))).toEqual({
			sql: "SELECT paradedb.parse(field => 'title', query_string => $1) AS v FROM posts",
			params: ['q'],
		});
	});
	it('parse: an inlined literal query', () => {
		expect(select(parse('title', literal('hello')))).toEqual({
			sql: "SELECT paradedb.parse(field => 'title', query_string => 'hello') AS v FROM posts",
			params: [],
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
		expect(() => select(parse('title', sql('1')))).toThrowError(
			refused(
				'parse',
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
