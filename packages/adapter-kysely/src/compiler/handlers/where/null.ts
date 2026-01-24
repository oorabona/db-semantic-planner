/**
 * @module compiler/handlers/where/null
 * Handler for IS NULL / IS NOT NULL WHERE clauses.
 */

import type { WhereNullIntent } from '@dbsp/core';
import {
	isPseudoColumnField,
	resolveFieldAlias,
	resolvePseudoColumnReference,
} from '../../helpers.js';
import type { WhereHandler } from '../../types.js';

/**
 * Compiles a NULL check WHERE clause.
 * Supports isNull and isNotNull operators.
 */
export const nullHandler: WhereHandler<WhereNullIntent> = (
	ctx,
	eb,
	intent,
	alias,
) => {
	// Get root table for resolution
	const rootTable =
		ctx.plan.intent.type === 'select' ? ctx.plan.intent.from : '';

	let column: string;

	// Check if field is a pseudo-column path (e.g., "parent.id")
	if (isPseudoColumnField(intent.field)) {
		const ref = resolvePseudoColumnReference(
			intent.field,
			alias,
			rootTable,
			ctx.model,
			ctx.state,
			ctx.schemaName,
		);
		column = `${ref.alias}.${ref.column}`;
	} else {
		// P1: Resolve correct alias for fields that may be in joined tables
		const resolvedAlias = rootTable
			? resolveFieldAlias(intent.field, alias, rootTable, ctx.model, ctx.state)
			: alias;
		column = `${resolvedAlias}.${intent.field}`;
	}

	if (intent.operator === 'isNull') {
		return eb(column, 'is', null);
	}
	return eb(column, 'is not', null);
};
