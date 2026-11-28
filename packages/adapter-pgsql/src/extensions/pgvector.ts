/**
 * pgvector Extension Wrappers
 *
 * Type-safe query builders for pgvector distance operators.
 * All functions return ExpressionRef instances that can be used in:
 * - SELECT: .column(cosineDistance('vector', qv).as('score'))
 * - WHERE:  .where(cosineDistance('vector', qv).gte(0.5))
 * - ORDER BY: .orderBy(rawDistance('vector', qv), 'asc')
 *
 * Each user argument follows the ADR 0011 leaf rule before it is wrapped:
 * - the column is a reference leaf: a string is a column, a `ColumnRef` its
 *   qualified column, an expression is compiled;
 * - the vector is a value leaf inside `CAST(… AS vector)`: a `number[]` is
 *   bound as pgvector's text form `'[a,b,…]'`, another plain value (a
 *   `'[1,0,0]'` string) is bound as given, an expression (`literal('[1,0,0]')`,
 *   a `ColumnRef`, a subquery …) is compiled inside the cast.
 */

import {
	cast,
	type ExpressionRef,
	fn,
	literal,
	op,
	type ReferenceLeaf,
} from '@dbsp/core';
import { referenceLeaf, valueLeaf } from './leaves.js';

/**
 * The vector leaf: a plain array is bound as pgvector's text form `[a,b,…]`
 * (`pg` would send a JavaScript array as a PostgreSQL array literal, which
 * `vector_in` refuses); any other leaf follows the value rule.
 */
function vectorLeaf(vector: unknown, helper: string): ExpressionRef {
	return Array.isArray(vector)
		? valueLeaf(JSON.stringify(vector.map(Number)), helper)
		: valueLeaf(vector, helper);
}

/** `<column> <operator> CAST(<vector> AS vector)`, each leaf coerced under `helper`. */
function distance(
	operator: '<=>' | '<->' | '<#>',
	column: ReferenceLeaf,
	vector: unknown,
	helper: string,
): ExpressionRef {
	return op(
		operator,
		referenceLeaf(column, helper),
		cast(vectorLeaf(vector, helper), 'vector'),
	);
}

/**
 * Cosine similarity: 1 - (col <=> vector)
 *
 * Score in [0, 1], higher = more similar.
 * Use in SELECT to get a similarity score.
 *
 * @example
 * orm.select('embeddings').column(cosineDistance('vector', qv).as('score'))
 */
export function cosineDistance(
	column: ReferenceLeaf,
	vector: unknown,
): ExpressionRef {
	return op('-', literal(1), distance('<=>', column, vector, 'cosineDistance'));
}

/**
 * Raw cosine distance: col <=> vector
 *
 * Lower = closer. Index-friendly — use in ORDER BY for ANN search.
 * Do NOT use in SELECT as a similarity score (lower = closer is counterintuitive).
 *
 * @example
 * orm.select('embeddings').orderBy(rawDistance('vector', qv), 'asc')
 */
export function rawDistance(
	column: ReferenceLeaf,
	vector: unknown,
): ExpressionRef {
	return distance('<=>', column, vector, 'rawDistance');
}

/**
 * L2 (Euclidean) distance: col <-> vector
 *
 * @example
 * orm.select('embeddings').orderBy(l2Distance('vector', qv), 'asc')
 */
export function l2Distance(
	column: ReferenceLeaf,
	vector: unknown,
): ExpressionRef {
	return distance('<->', column, vector, 'l2Distance');
}

/**
 * Inner product distance: col <#> vector (negative inner product)
 *
 * For maximum inner product search: ORDER BY innerProduct('vector', qv) ASC.
 *
 * @example
 * orm.select('embeddings').orderBy(innerProduct('vector', qv), 'asc')
 */
export function innerProduct(
	column: ReferenceLeaf,
	vector: unknown,
): ExpressionRef {
	return distance('<#>', column, vector, 'innerProduct');
}

/**
 * Get the number of dimensions of a vector column: vector_dims(col)
 *
 * Returns an integer — the dimension count of the stored vector.
 * Useful for sanity-checking that embeddings match the expected model dimension.
 *
 * @param column - A column name, a `ColumnRef` or an expression (reference leaf)
 *
 * @example
 * orm.from(embeddings).columns([vectorDims('vector').as('dim')]).first()
 * // → SELECT vector_dims("t0"."vector") AS "dim" FROM "embeddings" AS "t0"
 */
export function vectorDims(column: ReferenceLeaf): ExpressionRef {
	return fn('vector_dims', referenceLeaf(column, 'vectorDims'));
}
