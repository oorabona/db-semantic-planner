/**
 * @module compiler/handlers/where/range
 * Handler for range WHERE clauses (overlaps, contains, containedBy).
 */

import type { WhereRangeIntent } from '@dbsp/core';
import { compileRangeExpression } from '../../../compiler.js';
import type { WhereHandler } from '../../types.js';

/**
 * Compiles a range WHERE clause.
 * Supports overlaps, contains, and containedBy operators.
 * Requires PostgreSQL dialect (validates via capabilities).
 */
export const rangeHandler: WhereHandler<WhereRangeIntent> = (
	ctx,
	_eb,
	intent,
	alias,
) => {
	return compileRangeExpression(
		`${alias}.${intent.field}`,
		intent.operator,
		intent.value,
		ctx.state.coreCapabilities,
		ctx.state.dialect,
	);
};
