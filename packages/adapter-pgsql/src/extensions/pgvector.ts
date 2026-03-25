/**
 * pgvector Extension Wrappers
 *
 * Type-safe query builders for pgvector distance operators.
 * All functions return ExpressionRef instances that can be used in:
 * - SELECT: .column(cosineDistance('vector', qv).as('score'))
 * - WHERE:  .where(cosineDistance('vector', qv).gte(0.5))
 * - ORDER BY: .orderBy(rawDistance('vector', qv), 'asc')
 */

import {
	cast,
	type ExpressionRef,
	exprRef,
	fn,
	literal,
	op,
	param,
} from '@dbsp/core';

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
	column: string,
	vector: number[],
): ExpressionRef {
	return op(
		'-',
		literal(1),
		op('<=>', exprRef(column), cast(param(vector), 'vector')),
	);
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
export function rawDistance(column: string, vector: number[]): ExpressionRef {
	return op('<=>', exprRef(column), cast(param(vector), 'vector'));
}

/**
 * L2 (Euclidean) distance: col <-> vector
 *
 * @example
 * orm.select('embeddings').orderBy(l2Distance('vector', qv), 'asc')
 */
export function l2Distance(column: string, vector: number[]): ExpressionRef {
	return op('<->', exprRef(column), cast(param(vector), 'vector'));
}

/**
 * Inner product distance: col <#> vector (negative inner product)
 *
 * For maximum inner product search: ORDER BY innerProduct('vector', qv) ASC.
 *
 * @example
 * orm.select('embeddings').orderBy(innerProduct('vector', qv), 'asc')
 */
export function innerProduct(column: string, vector: number[]): ExpressionRef {
	return op('<#>', exprRef(column), cast(param(vector), 'vector'));
}


/**
 * Get the number of dimensions of a vector column: vector_dims(col)
 *
 * Returns an integer — the dimension count of the stored vector.
 * Useful for sanity-checking that embeddings match the expected model dimension.
 *
 * @example
 * orm.from(embeddings).columns([vectorDims('vector').as('dim')]).first()
 * // → SELECT vector_dims("t0"."vector") AS "dim" FROM "embeddings" AS "t0"
 */
export function vectorDims(column: string): ExpressionRef {
	return fn('vector_dims', exprRef(column));
}

