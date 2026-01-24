/**
 * @module compiler/handlers/where/in
 * Handler for IN WHERE clauses.
 */

import type { WhereInIntent } from '@dbsp/core';
import { resolveFieldAlias } from '../../helpers.js';
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
	// P1: Resolve correct alias for fields that may be in joined tables
	const rootTable =
		ctx.plan.intent.type === 'select' ? ctx.plan.intent.from : '';
	const resolvedAlias = rootTable
		? resolveFieldAlias(intent.field, alias, rootTable, ctx.model, ctx.state)
		: alias;
	return eb(`${resolvedAlias}.${intent.field}`, 'in', intent.values);
};
