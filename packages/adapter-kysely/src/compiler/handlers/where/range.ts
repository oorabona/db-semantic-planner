/**
 * @module compiler/handlers/where/range
 * Handler for range WHERE clauses (overlaps, contains, containedBy).
 */

import type { WhereRangeIntent } from '@dbsp/core';
import { compileRangeExpression } from '../../../compiler.js';
import { resolveFieldAlias } from '../../helpers.js';
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
	// P1: Resolve correct alias for fields that may be in joined tables
	const rootTable =
		ctx.plan.intent.type === 'select' ? ctx.plan.intent.from : '';
	const resolvedAlias = rootTable
		? resolveFieldAlias(intent.field, alias, rootTable, ctx.model, ctx.state)
		: alias;

	return compileRangeExpression(
		`${resolvedAlias}.${intent.field}`,
		intent.operator,
		intent.value,
		ctx.state.coreCapabilities,
		ctx.state.dialect,
	);
};
