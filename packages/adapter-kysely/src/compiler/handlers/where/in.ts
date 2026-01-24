/**
 * @module compiler/handlers/where/in
 * Handler for IN WHERE clauses.
 */

import type { WhereInIntent } from '@dbsp/core';
import {
	isPseudoColumnField,
	resolveFieldAlias,
	resolvePseudoColumnReference,
} from '../../helpers.js';
import type { WhereHandler } from '../../types.js';

/**
 * Compiles an IN WHERE clause.
 * Returns false literal for empty arrays (no values can match).
 */
export const inHandler: WhereHandler<WhereInIntent> = (
	ctx,
	eb,
	intent,
	alias,
) => {
	// Empty IN is always false (no values can match)
	if (intent.values.length === 0) {
		return eb.lit(false);
	}

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

	return eb(column, 'in', intent.values);
};
