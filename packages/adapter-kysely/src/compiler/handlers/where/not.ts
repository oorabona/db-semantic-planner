/**
 * @module compiler/handlers/where/not
 * Handler for NOT WHERE clauses (logical negation).
 */

import type { WhereNotIntent } from '@dbsp/core';
import type { WhereHandler } from '../../types.js';

/**
 * Compiles a NOT WHERE clause.
 * Recursively compiles the nested condition via ctx.compileWhere.
 */
export const notHandler: WhereHandler<WhereNotIntent> = (
	ctx,
	eb,
	intent,
	alias,
) => {
	if (!ctx.compileWhere) {
		throw new Error('notHandler requires ctx.compileWhere dispatcher');
	}

	return eb.not(ctx.compileWhere(ctx, eb, intent.condition, alias));
};
