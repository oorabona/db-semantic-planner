/**
 * @module compiler/handlers/where/exists-base
 * Shared base for EXISTS and NOT EXISTS handlers (ARCH-004 - deduplication)
 */

import type { WhereExistsIntent, WhereNotExistsIntent } from '@dbsp/core';
import type { WhereHandler } from '../../types.js';

type ExistsIntent = WhereExistsIntent | WhereNotExistsIntent;

/**
 * Factory for EXISTS/NOT EXISTS handler.
 * Parameterized to avoid code duplication between exists.ts and not-exists.ts
 *
 * @param negated - true for NOT EXISTS, false for EXISTS
 * @param mode - 'some' for EXISTS (any match), 'none' for NOT EXISTS (no matches)
 */
export function createExistsBaseHandler<T extends ExistsIntent>(
	negated: boolean,
	mode: 'some' | 'none',
	compileExists: (
		// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
		eb: any,
		where: T,
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
): WhereHandler<T> {
	return (ctx, eb, intent, alias) => {
		// Check if relation was already JOINed via filter-strategy: 'join'
		if (ctx.state.joinedFilterRelations.has(intent.relation)) {
			return compileJoinedRelationConditions(
				eb,
				{
					relation: intent.relation,
					...(intent.where !== undefined && { where: intent.where }),
					mode,
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
			negated,
			ctx.schemaName,
		);
	};
}
