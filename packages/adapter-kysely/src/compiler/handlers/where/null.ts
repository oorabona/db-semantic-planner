/**
 * @module compiler/handlers/where/null
 * Handler for IS NULL / IS NOT NULL WHERE clauses.
 */

import type { WhereNullIntent } from '@dbsp/core';
import { resolveFieldAlias } from '../../helpers.js';
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
	// P1: Resolve correct alias for fields that may be in joined tables
	const rootTable =
		ctx.plan.intent.type === 'select' ? ctx.plan.intent.from : '';
	const resolvedAlias = rootTable
		? resolveFieldAlias(intent.field, alias, rootTable, ctx.model, ctx.state)
		: alias;
	const column = `${resolvedAlias}.${intent.field}`;
	if (intent.operator === 'isNull') {
		return eb(column, 'is', null);
	}
	return eb(column, 'is not', null);
};
