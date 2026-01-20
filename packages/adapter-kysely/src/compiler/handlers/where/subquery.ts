/**
 * @module compiler/handlers/where/subquery
 * Handler for subquery WHERE clauses.
 */

import type { WhereSubqueryIntent } from '@dbsp/core';
import type { WhereHandler } from '../../types.js';

/**
 * Factory for subquery handler.
 * Requires helper function from compiler.ts to be injected.
 */
export function createSubqueryHandler(
	compileSubquery: (
		eb: any,
		where: WhereSubqueryIntent,
		alias: string,
		model: any,
		plan: any,
		state: any,
		schemaName?: string,
	) => any,
): WhereHandler<WhereSubqueryIntent> {
	return (ctx, eb, intent, alias) => {
		return compileSubquery(
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
