/**
 * @dbsp/core — Full-Text Search Helpers (FR-5)
 *
 * High-level cross-DB-friendly helpers that wrap the low-level ParadeDB
 * expression primitives (bm25Search / score from adapter-pgsql) using only
 * core expression building blocks.
 *
 * These helpers are ParadeDB/PostgreSQL-first; other adapters are expected
 * to either support the same SQL or receive a capability error at runtime.
 */

import type { ExpressionRef } from './expressions.js';
import { array, fn, literal, namedArg, op, param, ref } from './expressions.js';

// ============================================================================
// Types
// ============================================================================

/**
 * A single field to include in a full-text search, with an optional boost weight.
 */
export type FullTextSearchField = {
	/** Column name in the BM25 index */
	readonly name: string;
	/** Boost multiplier (higher = more important). Default: 1.0 */
	readonly boost: number;
};

/**
 * Options for fullTextSearch().
 */
export type FullTextSearchOptions = {
	/** The query string (will be bound as a single $N parameter shared across all fields). */
	readonly query: unknown;
	/** Fields to search with per-field boost weights. */
	readonly fields: readonly FullTextSearchField[];
	/**
	 * Table name or alias to qualify the left side of the @@@ operator.
	 * Must match the exact table name (or alias) as it appears in the FROM clause.
	 * In the standard ORM pipeline the root table has no alias, so pass the root table name.
	 *
	 * @example
	 * fullTextSearch({ query, fields, tableAlias: 'symbols' })
	 * // → "symbols" @@@ paradedb.boolean(...)
	 */
	readonly tableAlias: string;
};

// ============================================================================
// fullTextSearch()
// ============================================================================

/**
 * High-level full-text search filter for ParadeDB BM25 index.
 *
 * Produces:
 * ```sql
 * "tableAlias" @@@ paradedb.boolean(
 *   should => ARRAY[
 *     paradedb.boost(weight1, paradedb.parse(field => 'field1', query_string => $N)),
 *     paradedb.boost(weight2, paradedb.parse(field => 'field2', query_string => $N)),
 *     ...
 *   ]
 * )
 * ```
 *
 * The same query value is bound to separate $N parameters, one per field.
 *
 * @param options.query      - Query string (bound as a single parameter)
 * @param options.fields     - Fields to search with per-field boost weights
 * @param options.tableAlias - Table name or alias as it appears in the FROM clause (required).
 *   In the standard ORM pipeline the root table has no alias — pass the root table name directly.
 * @returns ExpressionRef for use in .where()
 *
 * @example
 * ```typescript
 * import { fullTextSearch } from '@dbsp/core';
 *
 * .where(fullTextSearch({
 *   query: searchTerm,
 *   tableAlias: 'symbols',
 *   fields: [
 *     { name: 'name', boost: 3.0 },
 *     { name: 'doc', boost: 1.0 },
 *   ],
 * }))
 * ```
 */
export function fullTextSearch({
	query,
	fields,
	tableAlias,
}: FullTextSearchOptions): ExpressionRef {
	const queryParam = param(query);
	const boostExprs = fields.map(({ name: fieldName, boost: weight }) =>
		fn(
			'paradedb.boost',
			literal(weight),
			fn(
				'paradedb.parse',
				namedArg('field', literal(fieldName)),
				namedArg('query_string', queryParam),
			),
		),
	);
	const booleanExpr = fn(
		'paradedb.boolean',
		namedArg('should', array(...boostExprs)),
	);
	return op('@@@', ref(tableAlias), booleanExpr);
}

// ============================================================================
// textScore()
// ============================================================================

/**
 * BM25 relevance score expression for ParadeDB.
 *
 * Produces: paradedb.score("keyField")
 *
 * Use in .columns() to include the score in results, and in .orderBy() to rank
 * results by relevance. Requires a BM25 index with the given key field on the table.
 *
 * @param keyField - The primary key field of the BM25 index (default: 'id')
 * @returns ExpressionRef for use in .columns() and .orderBy()
 *
 * @example
 * ```typescript
 * import { textScore } from '@dbsp/core';
 *
 * .columns(['*', textScore().as('score')])
 * .orderBy(textScore(), 'desc')
 * // SQL: SELECT *, paradedb.score("id") AS "score" ... ORDER BY paradedb.score("id") DESC
 * ```
 */
export function textScore(keyField = 'id'): ExpressionRef {
	return fn('paradedb.score', ref(keyField));
}
