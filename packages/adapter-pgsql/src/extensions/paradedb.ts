/**
 * ParadeDB Extension Wrappers
 *
 * Type-safe query builders for ParadeDB BM25 full-text search.
 * All functions return ExpressionRef instances that can be used in:
 * - SELECT: .column(score('id').as('score'))
 * - WHERE:  .where(bm25Search('symbols', query, { name: 3.0, doc: 1.0 }))
 * - ORDER BY: .orderBy(score('id'), 'desc')
 *
 * Each user argument follows the ADR 0011 leaf rule before it is wrapped:
 * - a query is a value leaf: a plain value is bound, an expression
 *   (`literal()`, `exprRef()`, a `ColumnRef`, a subquery …) is compiled;
 * - a key field or a sub-expression is a reference leaf: a string is a
 *   column, a `ColumnRef` its qualified column, an expression is compiled;
 * - a table or field name is a name and accepts a string only.
 *
 * @remarks
 * `parse()` uses named arguments via namedArg(), which produces:
 *   paradedb.parse(field => 'field_name', query_string => $1)
 * Named parameter syntax is supported via the NamedArgExpressionIntent (EXT-NAMED-PARAMS).
 */

import {
	array,
	type ExpressionRef,
	exprRef,
	fn,
	literal,
	namedArg,
	op,
	type ReferenceLeaf,
} from '@dbsp/core';
import { nameArgument, referenceLeaf, valueLeaf } from './leaves.js';

/**
 * BM25 relevance score for a row.
 *
 * Use in SELECT and ORDER BY to retrieve and sort by full-text relevance.
 * Requires a BM25 index on the table.
 *
 * @param keyField - The key field of the BM25 index (typically the primary
 *   key): a column name, a `ColumnRef` or an expression (reference leaf)
 * @returns ExpressionRef that compiles to: paradedb.score(keyField)
 *
 * @example
 * orm.select('symbols').column(score('id').as('score')).orderBy(score('id'), 'desc')
 * // → paradedb.score(id) AS "score"
 * score(orm.tables.symbols.id)
 * // → paradedb.score(symbols.id)
 */
export function score(keyField: ReferenceLeaf): ExpressionRef {
	return fn('paradedb.score', referenceLeaf(keyField, 'score'));
}

/**
 * Parse a single-field BM25 query expression.
 *
 * Compiles to: paradedb.parse(field => 'field_name', query_string => <query>)
 *
 * @param field - Name of a column in the BM25 index (a string only)
 * @param query - The query (value leaf): a plain value is bound as `$N`; an
 *   expression is compiled as the `query_string`
 * @returns ExpressionRef for use with boost() or booleanSearch()
 *
 * @example
 * parse('name', 'hello world')
 * // → paradedb.parse(field => 'name', query_string => $1)
 * parse('name', literal('hello'))
 * // → paradedb.parse(field => 'name', query_string => 'hello')
 */
export function parse(field: string, query: unknown): ExpressionRef {
	const name = nameArgument(
		field,
		'parse',
		'field must be the name of a column in the BM25 index',
	);
	return fn(
		'paradedb.parse',
		namedArg('field', literal(name)),
		namedArg('query_string', valueLeaf(query, 'parse')),
	);
}

/**
 * Apply a boost multiplier to a BM25 sub-expression.
 *
 * Compiles to: paradedb.boost(factor, expr)
 *
 * @param factor - Boost multiplier (e.g. 3.0 for 3x weight)
 * @param expr - Sub-expression to boost, typically a parse() call (reference leaf)
 * @returns ExpressionRef for use with booleanSearch()
 *
 * @example
 * boost(3.0, parse('name', 'hello'))
 * // → paradedb.boost(3, paradedb.parse(field => 'name', query_string => $1))
 */
export function boost(factor: number, expr: ReferenceLeaf): ExpressionRef {
	return fn('paradedb.boost', literal(factor), referenceLeaf(expr, 'boost'));
}

/**
 * Combine multiple BM25 sub-expressions with boolean OR logic.
 *
 * Compiles to: paradedb.boolean(should => ARRAY[expr1, expr2, ...])
 *
 * @param exprs - One or more sub-expressions, typically boost() calls (each a reference leaf)
 * @returns ExpressionRef for use on the right side of the @@@ operator
 *
 * @example
 * booleanSearch([boost(3.0, parse('name', q)), boost(1.0, parse('doc', q))])
 * // → paradedb.boolean(should => ARRAY[paradedb.boost(3, ...), paradedb.boost(1, ...)])
 */
export function booleanSearch(exprs: readonly ReferenceLeaf[]): ExpressionRef {
	return fn(
		'paradedb.boolean',
		namedArg(
			'should',
			array(...exprs.map((expr) => referenceLeaf(expr, 'booleanSearch'))),
		),
	);
}

/**
 * Full BM25 multi-field search with per-field boost weights.
 *
 * Produces: table @@@ paradedb.boolean(should => ARRAY[boost1, boost2, ...])
 *
 * Each field in `fieldBoosts` generates a
 * `paradedb.boost(weight, paradedb.parse('<field>', <query>))` sub-expression.
 * A plain query value is bound once per field (`$1`, `$2` … all equal); an
 * expression query is compiled in every field.
 *
 * @param table - Name or alias of the table in the FROM clause, for the left
 *   side of the @@@ operator (a string only)
 * @param query - The query (value leaf)
 * @param fieldBoosts - Map of column name → boost weight
 * @returns ExpressionRef for use in .where()
 *
 * @example
 * bm25Search('s', searchTerm, { name: 3.0, signature: 1.5 })
 * // → s @@@ paradedb.boolean(should => ARRAY[
 * //     paradedb.boost(3, paradedb.parse('name', $1)),
 * //     paradedb.boost(1.5, paradedb.parse('signature', $2))
 * //   ])
 *
 * @remarks
 * Prefer core's `fullTextSearch()`: on pg_search 0.25.3 the
 * `paradedb.parse('<field>', <query>)` call this helper emits is ambiguous and
 * fails at execution (#1119).
 */
export function bm25Search(
	table: string,
	query: unknown,
	fieldBoosts: Record<string, number>,
): ExpressionRef {
	const name = nameArgument(
		table,
		'bm25Search',
		'table must be the name of a table or alias in the FROM clause',
	);
	const queryLeaf = valueLeaf(query, 'bm25Search');
	const boostExprs = Object.entries(fieldBoosts).map(([field, weight]) =>
		boost(weight, fn('paradedb.parse', literal(field), queryLeaf)),
	);
	const booleanExpr = booleanSearch(boostExprs);
	return op('@@@', exprRef(name), booleanExpr);
}
