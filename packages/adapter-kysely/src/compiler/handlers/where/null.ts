/**
 * @module compiler/handlers/where/null
 * Handler for IS NULL / IS NOT NULL WHERE clauses.
 */

import type { WhereNullIntent } from '@dbsp/core';
import type { WhereHandler } from '../../types.js';

/**
 * Compiles a NULL check WHERE clause.
 * Supports isNull and isNotNull operators.
 */
export const nullHandler: WhereHandler<WhereNullIntent> = (
	_ctx,
	eb,
	intent,
	alias,
) => {
	const column = `${alias}.${intent.field}`;
	if (intent.operator === 'isNull') {
		return eb(column, 'is', null);
	}
	return eb(column, 'is not', null);
};
