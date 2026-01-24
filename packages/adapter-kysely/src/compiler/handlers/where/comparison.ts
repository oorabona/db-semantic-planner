/**
 * @module compiler/handlers/where/comparison
 * Handler for comparison WHERE clauses (eq, neq, gt, gte, lt, lte).
 */

import type { WhereComparisonIntent } from '@dbsp/core';
import { CompilationError } from '../../../errors.js';
import { resolveFieldAlias } from '../../helpers.js';
import type { WhereHandler } from '../../types.js';

/**
 * Compiles a comparison WHERE clause.
 * Supports operators: eq, neq, gt, gte, lt, lte
 */
export const comparisonHandler: WhereHandler<WhereComparisonIntent> = (
	ctx,
	eb,
	intent,
	alias,
) => {
	// P1: Resolve correct alias for fields that may be in joined tables
	const rootTable =
		ctx.plan.intent.type === 'select' ? ctx.plan.intent.from : '';
	const resolvedAlias = rootTable
		? resolveFieldAlias(intent.field, alias, rootTable, ctx.model, ctx.state)
		: alias;
	const column = `${resolvedAlias}.${intent.field}`;

	switch (intent.operator) {
		case 'eq':
			return eb(column, '=', intent.value);
		case 'neq':
			return eb(column, '!=', intent.value);
		case 'gt':
			return eb(column, '>', intent.value);
		case 'gte':
			return eb(column, '>=', intent.value);
		case 'lt':
			return eb(column, '<', intent.value);
		case 'lte':
			return eb(column, '<=', intent.value);
		default:
			throw new CompilationError(
				`Unknown comparison operator: ${(intent as WhereComparisonIntent).operator}`,
			);
	}
};
