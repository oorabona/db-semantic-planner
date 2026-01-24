/**
 * @module compiler/handlers/where/exists
 * Handler for EXISTS WHERE clauses.
 */

import type { WhereExistsIntent } from '@dbsp/core';
import type { WhereHandler } from '../../types.js';
import { createExistsBaseHandler } from './exists-base.js';

/**
 * Factory for EXISTS handler.
 * Delegates to shared base handler with negated=false, mode='some'
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
	return createExistsBaseHandler<WhereExistsIntent>(
		false, // not negated
		'some', // EXISTS = any match
		compileExists,
		compileJoinedRelationConditions,
	);
}
