/**
 * ParadeDB Extension Wrappers
 *
 * Type-safe query builders for ParadeDB BM25 full-text search.
 * All functions return ExpressionRef instances that can be used in:
 * - SELECT: .column(score('id').as('score'))
 * - WHERE:  .where(bm25Search('symbols', query, { name: 3.0, doc: 1.0 }))
 * - ORDER BY: .orderBy(score('id'), 'desc')
 *
 * @remarks
 * ParadeDB functions accept both named and positional arguments.
 * This module uses named args via namedArg() for parse(), which produces:
 *   paradedb.parse(field => 'field_name', query_string => $1)
 * Named parameter syntax is supported via the NamedArgExpressionIntent (EXT-NAMED-PARAMS).
 */

import { ExpressionRef, exprRef, fn, literal, namedArg, op, param } from '@dbsp/core';

/**
 * BM25 relevance score for a row.
 *
 * Use in SELECT and ORDER BY to retrieve and sort by full-text relevance.
 * Requires a BM25 index on the table.
 *
 * @param keyField - The key field of the BM25 index (typically the primary key, e.g. 'id')
 * @returns ExpressionRef that compiles to: paradedb.score("keyField")
 *
 * @example
 * orm.select('symbols').column(score('id').as('score')).orderBy(score('id'), 'desc')
 * // → paradedb.score("id") AS "score"
 */
export function score(keyField: string): ExpressionRef {
	return fn('paradedb.score', exprRef(keyField));
}

/**
 * Parse a single-field BM25 query expression.
 *
 * Compiles to: paradedb.parse(field => 'field_name', query_string => $N)
 *
 * @param field - Column name to search in (must be indexed in the BM25 index)
 * @param query - Query string value (will be bound as a parameter)
 * @returns ExpressionRef for use with boost() or booleanSearch()
 *
 * @example
 * parse('name', 'hello world')
 * // → paradedb.parse(field => 'name', query_string => $1)
 */
export function parse(
	field: string,
	query: ExpressionRef | unknown,
): ExpressionRef {
	// If query is already an ExpressionRef, pass it directly so fn() unwraps .intent.
	// Otherwise, wrap it in param() so it becomes a bound $N parameter.
	const queryExpr: ExpressionRef =
		query instanceof ExpressionRef ? query : param(query);
	return fn(
		'paradedb.parse',
		namedArg('field', literal(field)),
		namedArg('query_string', queryExpr),
	);
}

/**
 * Apply a boost multiplier to a BM25 sub-expression.
 *
 * Compiles to: paradedb.boost(factor, expr)
 *
 * @param factor - Boost multiplier (e.g. 3.0 for 3x weight)
 * @param expr - Expression to boost (typically a parse() call)
 * @returns ExpressionRef for use with booleanSearch()
 *
 * @example
 * boost(3.0, parse('name', 'hello'))
 * // → paradedb.boost(3.0, paradedb.parse('name', $1))
 */
export function boost(factor: number, expr: ExpressionRef): ExpressionRef {
	return fn('paradedb.boost', literal(factor), expr);
}

/**
 * Combine multiple BM25 sub-expressions with boolean OR logic.
 *
 * Compiles to: paradedb.boolean(expr1, expr2, ...)
 *
 * @param exprs - One or more sub-expressions (typically boost() calls)
 * @returns ExpressionRef for use on the right side of the @@@ operator
 *
 * @example
 * booleanSearch([boost(3.0, parse('name', q)), boost(1.0, parse('doc', q))])
 * // → paradedb.boolean(paradedb.boost(3.0, ...), paradedb.boost(1.0, ...))
 */
export function booleanSearch(exprs: ExpressionRef[]): ExpressionRef {
	return fn('paradedb.boolean', ...exprs);
}

/**
 * Full BM25 multi-field search with per-field boost weights.
 *
 * Produces: table @@@ paradedb.boolean(boost1, boost2, ...)
 *
 * Each field in `fieldBoosts` generates a `paradedb.boost(weight, paradedb.parse(field, $N))`
 * sub-expression. The same query string is used for all fields (single parameter binding).
 *
 * @param table - Table alias for the left side of the @@@ operator
 * @param query - Query string (bound as a single $N parameter, shared across all fields)
 * @param fieldBoosts - Map of column name → boost weight
 * @returns ExpressionRef for use in .where()
 *
 * @example
 * bm25Search('s', searchTerm, {
 *   name_searchable: 3.0,
 *   name: 1.0,
 *   signature: 1.5,
 *   doc_searchable: 1.0,
 * })
 * // → s @@@ paradedb.boolean(
 * //     paradedb.boost(3.0, paradedb.parse('name_searchable', $1)),
 * //     paradedb.boost(1.0, paradedb.parse('name', $1)),
 * //     paradedb.boost(1.5, paradedb.parse('signature', $1)),
 * //     paradedb.boost(1.0, paradedb.parse('doc_searchable', $1))
 * //   )
 *
 * @remarks
 * The query parameter is shared: all parse() calls reference the same $N slot.
 * If you need different query strings per field, compose parse()/boost()/booleanSearch() manually.
 *
 * @remarks
 * ParadeDB's boolean() function accepts both positional args and the named
 * `should => ARRAY[...]` syntax. This wrapper uses positional args.
 * Named parameter syntax is deferred to EXT-NAMED-PARAMS.
 */
export function bm25Search(
	table: string,
	query: unknown,
	fieldBoosts: Record<string, number>,
): ExpressionRef {
	const queryParam = param(query);
	const boostExprs = Object.entries(fieldBoosts).map(([field, weight]) =>
		boost(weight, fn('paradedb.parse', literal(field), queryParam)),
	);
	const booleanExpr = booleanSearch(boostExprs);
	return op('@@@', exprRef(table), booleanExpr);
}
