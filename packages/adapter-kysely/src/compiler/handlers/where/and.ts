/**
 * @module compiler/handlers/where/and
 * Handler for AND WHERE clauses (logical conjunction).
 */

import type { WhereAndIntent, WhereIntent } from '@dbsp/core';
import type { WhereHandler } from '../../types.js';

/**
 * Compiles an AND WHERE clause.
 * Returns true literal for empty arrays (no conditions to fail).
 * Recursively compiles nested conditions via ctx.compileWhere.
 */
export const andHandler: WhereHandler<WhereAndIntent> = (
	ctx,
	eb,
	intent,
	alias,
) => {
	// Empty AND is always true (no conditions to fail)
	if (intent.conditions.length === 0) {
		return eb.lit(true);
	}

	if (!ctx.compileWhere) {
		throw new Error('andHandler requires ctx.compileWhere dispatcher');
	}

	const dispatcher = ctx.compileWhere;
	return eb.and(
		intent.conditions.map((c: WhereIntent) => dispatcher(ctx, eb, c, alias)),
	);
};
