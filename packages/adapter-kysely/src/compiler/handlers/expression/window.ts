/**
 * @module compiler/handlers/expression/window
 * Handler for window function expressions.
 */

import type { WindowIntent } from '@dbsp/core';
import { isAggregateWindowFunction } from '@dbsp/core';
import { sql } from 'kysely';
import { CompilationError } from '../../../errors.js';
import type { ExpressionHandler } from '../../types.js';

/**
 * Compiles a window function expression.
 * Produces SQL like: ROW_NUMBER() OVER (PARTITION BY x ORDER BY y) AS alias
 */
export const windowHandler: ExpressionHandler<WindowIntent> = (
	_ctx,
	query,
	intent,
	tableAlias,
) => {
	const { function: fn, field, alias, over } = intent;

	// Build the OVER clause parts
	const partitionByParts = over.partitionBy?.length
		? over.partitionBy.map((col) => `"${col}"`).join(', ')
		: '';

	const orderByParts = over.orderBy?.length
		? over.orderBy
				.map((o) => {
					const dir = o.direction?.toUpperCase() ?? 'ASC';
					return `"${o.field}" ${dir}`;
				})
				.join(', ')
		: '';

	// Build OVER clause
	const overParts: string[] = [];
	if (partitionByParts) {
		overParts.push(`PARTITION BY ${partitionByParts}`);
	}
	if (orderByParts) {
		overParts.push(`ORDER BY ${orderByParts}`);
	}
	const overClause = overParts.length ? overParts.join(' ') : '';

	// Build the function call
	let functionCall: string;
	if (isAggregateWindowFunction(fn)) {
		// Aggregate window functions: SUM("field"), AVG("field"), etc.
		if (!field) {
			throw new CompilationError(
				`Window function '${fn}' requires a field parameter`,
			);
		}
		functionCall = `${fn.toUpperCase()}("${tableAlias}"."${field}")`;
	} else {
		// Ranking functions: ROW_NUMBER(), RANK(), DENSE_RANK()
		functionCall = `${fn.toUpperCase()}()`;
	}

	// Build the full expression: FUNCTION() OVER (...) AS "alias"
	const fullExpr = overClause
		? `${functionCall} OVER (${overClause})`
		: `${functionCall} OVER ()`;

	// Use sql template tag to add the window function as a select expression
	return query.select(sql<unknown>`${sql.raw(fullExpr)}`.as(alias));
};
