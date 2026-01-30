/**
 * @module compiler/handlers/where/range
 * Handler for range WHERE clauses (overlaps, contains, containedBy).
 */

import type { WhereRangeIntent } from '@dbsp/core';
import { compileRangeExpression } from '../../../compiler.js';
import {
	isPseudoColumnField,
	parseRelationPathField,
	resolveFieldAlias,
	resolvePseudoColumnReference,
} from '../../helpers.js';
import type { WhereHandler } from '../../types.js';

/**
 * Creates a range WHERE handler with access to compileExists for relation-path fields.
 * Relation-path fields (e.g., "roomBookings.bookingPeriod") are compiled as EXISTS subqueries.
 */
export function createRangeHandler(
	compileExists: (
		// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
		eb: any,
		// biome-ignore lint/suspicious/noExplicitAny: WhereIntent generic
		where: any,
		alias: string,
		// biome-ignore lint/suspicious/noExplicitAny: ModelIR generic
		model: any,
		// biome-ignore lint/suspicious/noExplicitAny: PlanReport generic
		plan: any,
		// biome-ignore lint/suspicious/noExplicitAny: CompilerState generic
		state: any,
		negated: boolean,
		schemaName?: string,
		// biome-ignore lint/suspicious/noExplicitAny: Kysely expression result
	) => any,
): WhereHandler<WhereRangeIntent> {
	return (ctx, eb, intent, alias) => {
		// Get root table for resolution
		const rootTable =
			ctx.plan.intent.type === 'select' ? ctx.plan.intent.from : '';

		// Check if field is a relation path (e.g., "roomBookings.bookingPeriod")
		// Must be checked before pseudo-column since both have dots
		if (rootTable) {
			const relPath = parseRelationPathField(
				intent.field,
				rootTable,
				ctx.model,
			);
			if (relPath) {
				// Compile as EXISTS subquery:
				// EXISTS (SELECT 1 FROM <target> WHERE <fk>=<pk> AND <column> <op> <value>)
				return compileExists(
					eb,
					{
						relation: relPath.relation,
						where: {
							kind: intent.kind,
							field: relPath.column,
							operator: intent.operator,
							value: intent.value,
						} as WhereRangeIntent,
					},
					alias,
					ctx.model,
					ctx.plan,
					ctx.state,
					false,
					ctx.schemaName,
				);
			}
		}

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
				? resolveFieldAlias(
						intent.field,
						alias,
						rootTable,
						ctx.model,
						ctx.state,
					)
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
}
