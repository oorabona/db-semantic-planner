/**
 * @module compiler/handlers/where/exists
 * Handler for EXISTS WHERE clauses.
 */

import type { WhereExistsIntent } from '@dbsp/core';
import type { WhereHandler } from '../../types.js';

/**
 * Factory for EXISTS handler.
 * Requires helper functions from compiler.ts to be injected.
 */
export function createExistsHandler(
	compileExists: (
		// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
		eb: any,
		where: WhereExistsIntent,
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
	compileJoinedRelationConditions: (
		// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
		eb: any,
		// biome-ignore lint/suspicious/noExplicitAny: WhereIntent options
		options: { relation: string; where?: any; mode: 'some' | 'every' | 'none' },
		alias: string,
		// biome-ignore lint/suspicious/noExplicitAny: ModelIR generic
		model: any,
		// biome-ignore lint/suspicious/noExplicitAny: PlanReport generic
		plan: any,
		// biome-ignore lint/suspicious/noExplicitAny: CompilerState generic
		state: any,
		schemaName?: string,
		// biome-ignore lint/suspicious/noExplicitAny: Kysely expression result
	) => any,
): WhereHandler<WhereExistsIntent> {
	return (ctx, eb, intent, alias) => {
		// Check if relation was already JOINed via filter-strategy: 'join'
		if (ctx.state.joinedFilterRelations.has(intent.relation)) {
			return compileJoinedRelationConditions(
				eb,
				{
					relation: intent.relation,
					...(intent.where !== undefined && { where: intent.where }),
					mode: 'some',
				},
				alias,
				ctx.model,
				ctx.plan,
				ctx.state,
				ctx.schemaName,
			);
		}
		return compileExists(
			eb,
			intent,
			alias,
			ctx.model,
			ctx.plan,
			ctx.state,
			false, // not negated
			ctx.schemaName,
		);
	};
}
