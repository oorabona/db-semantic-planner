/**
 * @module compiler/handlers/where/range
 * Handler for range WHERE clauses (overlaps, contains, containedBy).
 */

import type { WhereRangeIntent } from '@dbsp/core';
import { compileRangeExpression } from '../../../compiler.js';
import {
	isPseudoColumnField,
	resolveFieldAlias,
	resolvePseudoColumnReference,
} from '../../helpers.js';
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
	// Get root table for resolution
	const rootTable =
		ctx.plan.intent.type === 'select' ? ctx.plan.intent.from : '';

	let column: string;

	// Check if field is a pseudo-column path (e.g., "parent.period")
	if (isPseudoColumnField(intent.field)) {
		const ref = resolvePseudoColumnReference(
			intent.field,
			alias,
			rootTable,
			ctx.model,
			ctx.state,
			ctx.schemaName,
		);
		column = `${ref.alias}.${ref.column}`;
	} else {
		// P1: Resolve correct alias for fields that may be in joined tables
		const resolvedAlias = rootTable
			? resolveFieldAlias(intent.field, alias, rootTable, ctx.model, ctx.state)
			: alias;
		column = `${resolvedAlias}.${intent.field}`;
	}

	return compileRangeExpression(
		column,
		intent.operator,
		intent.value,
		ctx.state.coreCapabilities,
		ctx.state.dialect,
	);
};
