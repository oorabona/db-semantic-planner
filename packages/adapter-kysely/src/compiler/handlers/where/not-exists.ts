/**
 * @module compiler/handlers/where/not-exists
 * Handler for NOT EXISTS WHERE clauses.
 */

import type { WhereNotExistsIntent } from '@dbsp/core';
import type { WhereHandler } from '../../types.js';

/**
 * Factory for NOT EXISTS handler.
 * Requires helper functions from compiler.ts to be injected.
 */
export function createNotExistsHandler(
	compileExists: (
		eb: any,
		where: WhereNotExistsIntent,
		alias: string,
		model: any,
		plan: any,
		state: any,
		negated: boolean,
		schemaName?: string,
	) => any,
	compileJoinedRelationConditions: (
		eb: any,
		options: { relation: string; where?: any; mode: 'some' | 'every' | 'none' },
		alias: string,
		model: any,
		plan: any,
		state: any,
		schemaName?: string,
	) => any,
): WhereHandler<WhereNotExistsIntent> {
	return (ctx, eb, intent, alias) => {
		// Check if relation was already JOINed via filter-strategy: 'join'
		if (ctx.state.joinedFilterRelations.has(intent.relation)) {
			return compileJoinedRelationConditions(
				eb,
				{
					relation: intent.relation,
					...(intent.where !== undefined && { where: intent.where }),
					mode: 'none',
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
			true, // negated
			ctx.schemaName,
		);
	};
}
