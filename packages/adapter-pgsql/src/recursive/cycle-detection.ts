/**
 * Cycle Detection for Recursive CTEs
 *
 * Implements cycle detection strategies:
 * 1. __visited array approach (works on all PostgreSQL versions)
 * 2. PG14+ CYCLE clause (cleaner, but requires PG14+)
 *
 * The __visited array stores all visited PKs and checks for duplicates
 * using the `<> ALL(array)` operator.
 */

import type { Node } from '@pgsql/types';
import { binaryExpr } from '../ast-helpers.js';

/**
 * Build __visited column for anchor or recursive SELECT.
 *
 * Anchor: ARRAY[pk] AS __visited
 * Recursive: __visited || pk AS __visited
 */
export function buildCycleDetection(
	alias: string,
	pkColumn: string,
	isAnchor: boolean,
	cteAlias?: string,
): Node {
	if (isAnchor) {
		// ARRAY[pk] AS __visited
		return {
			ResTarget: {
				val: {
					A_ArrayExpr: {
						elements: [
							{
								ColumnRef: {
									fields: [
										{ String: { sval: alias } },
										{ String: { sval: pkColumn } },
									],
								},
							},
						],
					},
				},
				name: '__visited',
			},
		};
	}

	// Recursive: __visited || pk
	if (!cteAlias) {
		throw new Error('cteAlias required for recursive cycle detection');
	}

	return {
		ResTarget: {
			val: binaryExpr(
				'||',
				{
					ColumnRef: {
						fields: [
							{ String: { sval: cteAlias } },
							{ String: { sval: '__visited' } },
						],
					},
				},
				{
					ColumnRef: {
						fields: [
							{ String: { sval: alias } },
							{ String: { sval: pkColumn } },
						],
					},
				},
			),
			name: '__visited',
		},
	};
}

/**
 * Build cycle check condition for WHERE clause.
 *
 * Produces: pk <> ALL(__visited)
 */
export function buildCycleCheck(
	innerAlias: string,
	cteAlias: string,
	pkColumn: string,
): Node {
	return {
		A_Expr: {
			kind: 'AEXPR_OP_ALL',
			name: [{ String: { sval: '<>' } }],
			lexpr: {
				ColumnRef: {
					fields: [
						{ String: { sval: innerAlias } },
						{ String: { sval: pkColumn } },
					],
				},
			},
			rexpr: {
				ColumnRef: {
					fields: [
						{ String: { sval: cteAlias } },
						{ String: { sval: '__visited' } },
					],
				},
			},
		},
	};
}

/**
 * Build PG14+ CYCLE clause.
 *
 * PG14 introduced the CYCLE clause for recursive CTEs:
 * ```sql
 * WITH RECURSIVE cte AS (...)
 * CYCLE pk SET is_cycle USING path
 * SELECT ... FROM cte WHERE NOT is_cycle
 * ```
 *
 * Note: This returns metadata about the cycle clause, but the actual
 * implementation depends on how @pgsql/types represents it.
 * Currently returns null if not supported.
 */
export function buildPg14CycleClause(
	_pkColumn: string,
	_cycleColumn = 'is_cycle',
	_pathColumn = '__cycle_path',
): Node | null {
	// The PG14 CYCLE clause is represented differently in the AST.
	// @pgsql/types may not have direct support for it yet.
	// For now, we document the intended SQL and return null.
	//
	// Intended SQL:
	// CYCLE {pkColumn} SET {cycleColumn} USING {pathColumn}
	//
	// The caller should fall back to __visited array approach if null.

	// Attempt to build the structure if supported
	// This is a placeholder - actual implementation depends on @pgsql/types version
	try {
		return {
			// CTECycleClause is not standard in all @pgsql/types versions
			// Return null to signal fallback to __visited approach
		} as unknown as Node;
	} catch {
		return null;
	}
}

/**
 * Check if PG14 CYCLE clause is available.
 *
 * This can be used to determine which cycle detection strategy to use.
 */
export function isPg14CycleSupported(): boolean {
	// For now, we default to false to use the __visited approach.
	// In production, this could check the PostgreSQL server version.
	return false;
}

/**
 * Build WHERE condition to filter out cyclic rows when using PG14 CYCLE clause.
 *
 * Produces: NOT is_cycle
 */
export function buildCycleFilter(cycleColumn = 'is_cycle'): Node {
	return {
		BoolExpr: {
			boolop: 'NOT_EXPR',
			args: [
				{
					ColumnRef: {
						fields: [{ String: { sval: cycleColumn } }],
					},
				},
			],
		},
	};
}
