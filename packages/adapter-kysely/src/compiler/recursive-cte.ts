/**
 * @module compiler/recursive-cte
 * Shared builder for WITH RECURSIVE scalar subqueries.
 *
 * Used by both:
 * - pseudoColumn handler (expression/pseudoColumn.ts) for pseudo-column syntax
 * - CTE include handler (include/cte.ts) for include-based recursive CTEs
 *
 * Generates a correlated scalar subquery with:
 * - Depth tracking (__depth)
 * - Cycle detection (__visited array + <> ALL check)
 * - Direction-aware traversal (ancestors up / descendants down)
 */

import type { RawBuilder } from 'kysely';
import { sql } from 'kysely';

/**
 * Configuration for building a recursive CTE scalar subquery.
 */
export interface RecursiveCteConfig {
	/** Unique CTE alias (e.g. '__rc_1') */
	cteAlias: string;
	/** SQL expression for the table (with optional schema prefix) */
	tableRef: RawBuilder<unknown>;
	/** Primary key column name */
	pkColumn: string;
	/** Foreign key column name */
	fkColumn: string;
	/** Alias of the outer (root) table */
	rootAlias: string;
	/** true = ancestors (follow FK upward), false = descendants (follow FK downward) */
	isAncestors: boolean;
	/** Maximum recursion depth */
	maxDepth: number;
	/** SQL expression for the SELECT columns in each CTE row */
	selectColumns: RawBuilder<unknown>;
	/** SQL expression for the json_agg(...) aggregate */
	aggregateExpr: RawBuilder<unknown>;
}

/**
 * Builds a correlated WITH RECURSIVE scalar subquery.
 *
 * Template:
 * ```sql
 * (WITH RECURSIVE __rc AS (
 *   SELECT <columns>, 1 AS __depth, ARRAY[__n.pk] AS __visited
 *   FROM <table> AS __n WHERE <anchor>
 *   UNION ALL
 *   SELECT <columns>, __rc.__depth + 1, __rc.__visited || __n.pk
 *   FROM __rc INNER JOIN <table> AS __n ON <join>
 *   WHERE __rc.__depth < maxDepth AND __n.pk <> ALL(__rc.__visited)
 * ) SELECT COALESCE(<aggregate>, '[]'::json) FROM __rc)
 * ```
 */
export function buildRecursiveScalarSubquery(
	config: RecursiveCteConfig,
): RawBuilder<unknown> {
	const {
		cteAlias,
		tableRef,
		pkColumn,
		fkColumn,
		rootAlias,
		isAncestors,
		maxDepth,
		selectColumns,
		aggregateExpr,
	} = config;

	const cteId = sql.id(cteAlias);
	const cteDepth = sql.ref(`${cteAlias}.__depth`);
	const cteVisited = sql.ref(`${cteAlias}.__visited`);
	const nodePk = sql.ref(`__n.${pkColumn}`);
	const nodeFk = sql.ref(`__n.${fkColumn}`);
	const outerFk = sql.ref(`${rootAlias}.${fkColumn}`);
	const outerPk = sql.ref(`${rootAlias}.${pkColumn}`);

	// Direction-specific conditions
	const anchorWhere = isAncestors
		? sql`${nodePk} = ${outerFk}`
		: sql`${nodeFk} = ${outerPk}`;

	const recursiveJoin = isAncestors
		? sql`${nodePk} = ${sql.ref(`${cteAlias}.${fkColumn}`)}`
		: sql`${nodeFk} = ${sql.ref(`${cteAlias}.${pkColumn}`)}`;

	return sql`(WITH RECURSIVE ${cteId} AS (SELECT ${selectColumns}, 1 AS "__depth", ARRAY[${nodePk}] AS "__visited" FROM ${tableRef} AS "__n" WHERE ${anchorWhere} UNION ALL SELECT ${selectColumns}, ${cteDepth} + 1, ${cteVisited} || ${nodePk} FROM ${cteId} INNER JOIN ${tableRef} AS "__n" ON ${recursiveJoin} WHERE ${cteDepth} < ${sql.val(maxDepth)} AND ${nodePk} <> ALL(${cteVisited})) SELECT COALESCE(${aggregateExpr}, '[]'::json) FROM ${cteId})`;
}

/**
 * Builds a SQL table reference with optional schema prefix.
 */
export function buildTableRef(
	tableName: string,
	schemaName?: string,
): RawBuilder<unknown> {
	return schemaName
		? sql`${sql.id(schemaName)}.${sql.id(tableName)}`
		: sql.id(tableName);
}

/**
 * Deduplicate an array of strings preserving order.
 */
export function dedup(arr: string[]): string[] {
	return [...new Set(arr)];
}
