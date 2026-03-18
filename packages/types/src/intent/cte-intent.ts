import type { QueryIntent } from './query-intent.js';

/**
 * CTE backed by unnest() arrays, optionally with WITH ORDINALITY for 0-based indexing.
 *
 * Generates:
 *   SELECT t."col1", t."col2", (t.ordinality - 1) AS "idx"
 *   FROM unnest(CAST($1 AS type[]), CAST($2 AS type[])) WITH ORDINALITY AS t("col1", "col2", ordinality)
 */
export interface UnnestCteIntent {
	readonly kind: 'unnestCte';
	readonly name: string;
	/** Column name → array of values. All arrays must have the same length. */
	readonly columns: Record<string, readonly unknown[]>;
	/** Optional column name for the 0-based ordinality index. */
	readonly indexColumn?: string;
}

/**
 * Full CTE query: one or more CTE definitions + an outer query.
 */
export interface CteQueryIntent {
	readonly kind: 'cteQuery';
	readonly ctes: readonly UnnestCteIntent[];
	readonly query: QueryIntent;
}
