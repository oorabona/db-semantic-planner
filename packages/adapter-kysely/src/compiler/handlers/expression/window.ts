/**
 * @module compiler/handlers/expression/window
 * Handler for window function expressions.
 */

import type { WindowIntent } from '@dbsp/core';
import { isAggregateWindowFunction } from '@dbsp/core';
import type { RawBuilder } from 'kysely';
import { sql } from 'kysely';
import { CompilationError } from '../../../errors.js';
import type { ExpressionHandler } from '../../types.js';

/**
 * Compiles a window function expression.
 * Produces SQL like: ROW_NUMBER() OVER (PARTITION BY x ORDER BY y) AS alias
 *
 * Uses sql.ref() for column references to leverage Kysely's CamelCasePlugin
 * for automatic name transformation.
 */
export const windowHandler: ExpressionHandler<WindowIntent> = (
	_ctx,
	query,
	intent,
	tableAlias,
) => {
	const { function: fn, field, alias, over } = intent;

	// Build partition by columns using sql.ref() for proper name transformation
	const partitionByRefs = over.partitionBy?.length
		? over.partitionBy.map((col) => sql.ref(`${tableAlias}.${col}`))
		: [];

	// Build order by expressions using sql.ref() for column + direction
	const orderByExprs = over.orderBy?.length
		? over.orderBy.map((o) => {
				const dir = o.direction?.toUpperCase() ?? 'ASC';
				return sql`${sql.ref(`${tableAlias}.${o.field}`)} ${sql.raw(dir)}`;
			})
		: [];

	// Build OVER clause components
	let overClause: RawBuilder<unknown> | null;
	if (partitionByRefs.length > 0 && orderByExprs.length > 0) {
		overClause = sql`PARTITION BY ${sql.join(partitionByRefs, sql`, `)} ORDER BY ${sql.join(orderByExprs, sql`, `)}`;
	} else if (partitionByRefs.length > 0) {
		overClause = sql`PARTITION BY ${sql.join(partitionByRefs, sql`, `)}`;
	} else if (orderByExprs.length > 0) {
		overClause = sql`ORDER BY ${sql.join(orderByExprs, sql`, `)}`;
	} else {
		overClause = null;
	}

	// Build the window function expression
	let windowExpr: RawBuilder<unknown>;
	if (isAggregateWindowFunction(fn)) {
		// Aggregate window functions: SUM(field), AVG(field), etc.
		if (!field) {
			throw new CompilationError(
				`Window function '${fn}' requires a field parameter`,
			);
		}
		const fieldRef = sql.ref(`${tableAlias}.${field}`);
		if (overClause) {
			windowExpr = sql`${sql.raw(fn.toUpperCase())}(${fieldRef}) OVER (${overClause})`;
		} else {
			windowExpr = sql`${sql.raw(fn.toUpperCase())}(${fieldRef}) OVER ()`;
		}
	} else {
		// Ranking functions: ROW_NUMBER(), RANK(), DENSE_RANK()
		if (overClause) {
			windowExpr = sql`${sql.raw(fn.toUpperCase())}() OVER (${overClause})`;
		} else {
			windowExpr = sql`${sql.raw(fn.toUpperCase())}() OVER ()`;
		}
	}

	return query.select(windowExpr.as(alias));
};
