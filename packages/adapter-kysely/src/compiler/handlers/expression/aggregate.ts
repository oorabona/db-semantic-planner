/**
 * @module compiler/handlers/expression/aggregate
 * Handler for aggregate expressions (COUNT, SUM, AVG, MIN, MAX).
 */

import type { AggregateExpressionIntent } from '@dbsp/core';
import { CompilationError } from '../../../errors.js';
import type { ExpressionHandler } from '../../types.js';

/**
 * Compiles an aggregate expression.
 *
 * @example { kind: 'aggregate', function: 'count', as: 'total' } → COUNT(*) AS total
 * @example { kind: 'aggregate', function: 'sum', field: 'price', as: 'total_price' } → SUM(price) AS total_price
 * @example { kind: 'aggregate', function: 'count', field: 'id', distinct: true, as: 'unique_count' } → COUNT(DISTINCT id) AS unique_count
 */
export const aggregateHandler: ExpressionHandler<AggregateExpressionIntent> = (
	_ctx,
	query,
	intent,
	alias,
) => {
	const fn = intent.function;
	const field = intent.field;
	const outputAlias = intent.as ?? `${fn}_result`;

	// Validate aggregate function
	const validFunctions = ['count', 'sum', 'avg', 'min', 'max'];
	if (!validFunctions.includes(fn)) {
		throw new CompilationError(`Unknown aggregate function: ${fn}`);
	}

	return query.select((eb) => {
		// Handle COUNT(*) special case
		if (fn === 'count' && (field === undefined || field === '*')) {
			// COUNT(*) - count all rows
			// biome-ignore lint/suspicious/noExplicitAny: Kysely fn.count requires specific typing
			return (eb.fn as any).countAll().as(outputAlias);
		}

		// For field-based aggregates, build the expression
		if (field === undefined) {
			throw new CompilationError(
				`Aggregate function '${fn}' requires a field (only COUNT can use *)`,
			);
		}

		// Build column reference with table alias
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic column references
		const columnRef = eb.ref(`${alias}.${field}` as any);

		// Handle DISTINCT modifier
		if (intent.distinct) {
			// Use fn with DISTINCT modifier
			// Kysely supports DISTINCT via: eb.fn(fnName, [eb.fn('distinct', [columnRef])])
			// But a cleaner approach is available for COUNT DISTINCT
			if (fn === 'count') {
				// biome-ignore lint/suspicious/noExplicitAny: Kysely countAll with distinct
				return (eb.fn as any).count(columnRef).distinct().as(outputAlias);
			}
			// For other aggregates with DISTINCT (less common but valid SQL)
			// biome-ignore lint/suspicious/noExplicitAny: Dynamic aggregate function
			return (eb.fn as any)(fn, [columnRef]).distinct().as(outputAlias);
		}

		// Standard aggregate without DISTINCT
		return eb.fn(fn, [columnRef]).as(outputAlias);
	});
};
