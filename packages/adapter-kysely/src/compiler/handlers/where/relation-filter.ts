/**
 * @module compiler/handlers/where/relation-filter
 * Handler for relation filter WHERE clauses.
 */

import type { WhereRelationFilterIntent } from '@dbsp/core';
import type { WhereHandler } from '../../types.js';

/**
 * Factory for relation filter handler.
 * Requires helper function from compiler.ts to be injected.
 */
export function createRelationFilterHandler(
	compileRelationFilter: (
		eb: any,
		where: WhereRelationFilterIntent,
		alias: string,
		model: any,
		plan: any,
		state: any,
		schemaName?: string,
	) => any,
): WhereHandler<WhereRelationFilterIntent> {
	return (ctx, eb, intent, alias) => {
		return compileRelationFilter(
			eb,
			intent,
			alias,
			ctx.model,
			ctx.plan,
			ctx.state,
			ctx.schemaName,
		);
	};
}
