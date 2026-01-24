/**
 * @module compiler/handlers/where/like
 * Handler for LIKE/ILIKE WHERE clauses.
 */

import type { WhereLikeIntent } from '@dbsp/core';
import {
	isPseudoColumnField,
	resolveFieldAlias,
	resolvePseudoColumnReference,
} from '../../helpers.js';
import type { WhereHandler } from '../../types.js';

/**
 * Compiles a LIKE WHERE clause.
 * Supports case-sensitive (LIKE) and case-insensitive (ILIKE) patterns.
 */
export const likeHandler: WhereHandler<WhereLikeIntent> = (
	ctx,
	eb,
	intent,
	alias,
) => {
	// Get root table for resolution
	const rootTable =
		ctx.plan.intent.type === 'select' ? ctx.plan.intent.from : '';

	let column: string;

	// Check if field is a pseudo-column path (e.g., "parent.name")
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

	return intent.caseInsensitive
		? eb(column, 'ilike', intent.pattern)
		: eb(column, 'like', intent.pattern);
};
