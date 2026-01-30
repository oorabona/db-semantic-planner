/**
 * @module compiler/handlers/where/comparison
 * Handler for comparison WHERE clauses (eq, neq, gt, gte, lt, lte).
 */

import type { WhereComparisonIntent } from '@dbsp/core';
import { CompilationError } from '../../../errors.js';
import {
	isPseudoColumnField,
	parseRelationPathField,
	resolveFieldAlias,
	resolvePseudoColumnReference,
} from '../../helpers.js';
import type { WhereHandler } from '../../types.js';

/**
 * Creates a comparison WHERE handler with access to compileExists for relation-path fields.
 * Relation-path fields (e.g., "roomBookings.bookingPeriod") are compiled as EXISTS subqueries.
 */
export function createComparisonHandler(
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
): WhereHandler<WhereComparisonIntent> {
	return (ctx, eb, intent, alias) => {
		// Get root table for resolution
		const rootTable =
			ctx.plan.intent.type === 'select' ? ctx.plan.intent.from : '';

		// Check if field is a relation path (e.g., "roomBookings.status")
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
						} as WhereComparisonIntent,
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

		// Check if field is a pseudo-column path (e.g., "parent.id")
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

		switch (intent.operator) {
			case 'eq':
				return eb(column, '=', intent.value);
			case 'neq':
				return eb(column, '!=', intent.value);
			case 'gt':
				return eb(column, '>', intent.value);
			case 'gte':
				return eb(column, '>=', intent.value);
			case 'lt':
				return eb(column, '<', intent.value);
			case 'lte':
				return eb(column, '<=', intent.value);
			default:
				throw new CompilationError(
					`Unknown comparison operator: ${(intent as WhereComparisonIntent).operator}`,
				);
		}
	};
}
