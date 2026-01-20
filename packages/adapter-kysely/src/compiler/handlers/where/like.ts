/**
 * @module compiler/handlers/where/like
 * Handler for LIKE/ILIKE WHERE clauses.
 */

import type { WhereLikeIntent } from '@dbsp/core';
import type { WhereHandler } from '../../types.js';

/**
 * Compiles a LIKE WHERE clause.
 * Supports case-sensitive (LIKE) and case-insensitive (ILIKE) patterns.
 */
export const likeHandler: WhereHandler<WhereLikeIntent> = (
	_ctx,
	eb,
	intent,
	alias,
) => {
	const column = `${alias}.${intent.field}`;
	return intent.caseInsensitive
		? eb(column, 'ilike', intent.pattern)
		: eb(column, 'like', intent.pattern);
};
