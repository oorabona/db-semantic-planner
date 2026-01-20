/**
 * @module compiler/handlers/where/in
 * Handler for IN WHERE clauses.
 */

import type { WhereInIntent } from '@dbsp/core';
import type { WhereHandler } from '../../types.js';

/**
 * Compiles an IN WHERE clause.
 * Returns false literal for empty arrays (no values can match).
 */
export const inHandler: WhereHandler<WhereInIntent> = (
	_ctx,
	eb,
	intent,
	alias,
) => {
	// Empty IN is always false (no values can match)
	if (intent.values.length === 0) {
		return eb.lit(false);
	}
	return eb(`${alias}.${intent.field}`, 'in', intent.values);
};
