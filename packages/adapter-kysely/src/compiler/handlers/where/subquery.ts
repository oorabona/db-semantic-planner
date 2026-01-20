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
		// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
		eb: any,
		where: WhereSubqueryIntent,
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
