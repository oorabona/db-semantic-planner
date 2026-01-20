/**
 * @module compiler/handlers/expression/raw
 * Handler for raw SQL expressions (escape hatch).
 */

import type { RawExpressionIntent } from '@dbsp/core';
import { sql } from 'kysely';
import type { ExpressionHandler } from '../../types.js';

/**
 * Compiles a raw SQL expression.
 * This is the escape hatch for arbitrary SQL that cannot be expressed via the planner.
 *
 * @warning Use sparingly - bypasses type safety and SQL injection protection.
 * Only use for trusted, static SQL fragments.
 */
export const rawHandler: ExpressionHandler<RawExpressionIntent> = (
	_ctx,
	query,
	intent,
	_alias,
) => {
	return query.select(sql`${sql.raw(intent.sql)}`.as(intent.as));
};
