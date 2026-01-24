/**
 * @module compiler/handlers/where/like
 * Handler for LIKE/ILIKE WHERE clauses.
 */

import type { WhereLikeIntent } from '@dbsp/core';
import { resolveFieldAlias } from '../../helpers.js';
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
	// P1: Resolve correct alias for fields that may be in joined tables
	const rootTable =
		ctx.plan.intent.type === 'select' ? ctx.plan.intent.from : '';
	const resolvedAlias = rootTable
		? resolveFieldAlias(intent.field, alias, rootTable, ctx.model, ctx.state)
		: alias;
	const column = `${resolvedAlias}.${intent.field}`;
	return intent.caseInsensitive
		? eb(column, 'ilike', intent.pattern)
		: eb(column, 'like', intent.pattern);
};
