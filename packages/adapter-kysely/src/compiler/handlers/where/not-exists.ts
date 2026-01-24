/**
 * @module compiler/handlers/where/not-exists
 * Handler for NOT EXISTS WHERE clauses.
 */

import type { WhereNotExistsIntent } from '@dbsp/core';
import type { WhereHandler } from '../../types.js';
import { createExistsBaseHandler } from './exists-base.js';

/**
 * Factory for NOT EXISTS handler.
 * Delegates to shared base handler with negated=true, mode='none'
 */
export function createNotExistsHandler(
	compileExists: (
		// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
		eb: any,
		where: WhereNotExistsIntent,
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
): WhereHandler<WhereNotExistsIntent> {
	return createExistsBaseHandler<WhereNotExistsIntent>(
		true, // negated
		'none', // NOT EXISTS = no matches
		compileExists,
		compileJoinedRelationConditions,
	);
}
