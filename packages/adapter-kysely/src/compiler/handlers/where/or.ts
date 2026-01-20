/**
 * @module compiler/handlers/where/or
 * Handler for OR WHERE clauses (logical disjunction).
 */

import type { WhereIntent, WhereOrIntent } from '@dbsp/core';
import type { WhereHandler } from '../../types.js';

/**
 * Compiles an OR WHERE clause.
 * Returns false literal for empty arrays (no conditions can pass).
 * Recursively compiles nested conditions via ctx.compileWhere.
 */
export const orHandler: WhereHandler<WhereOrIntent> = (
	ctx,
	eb,
	intent,
	alias,
) => {
	// Empty OR is always false (no conditions can pass)
	if (intent.conditions.length === 0) {
		return eb.lit(false);
	}

	if (!ctx.compileWhere) {
		throw new Error('orHandler requires ctx.compileWhere dispatcher');
	}

	const dispatcher = ctx.compileWhere;
	return eb.or(
		intent.conditions.map((c: WhereIntent) => dispatcher(ctx, eb, c, alias)),
	);
};
