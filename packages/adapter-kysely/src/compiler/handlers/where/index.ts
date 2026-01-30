/**
 * @module compiler/handlers/where
 * WHERE clause handlers registration.
 */

import { registerWhereHandler } from '../../registry.js';
import type { WhereHandler } from '../../types.js';
import { andHandler } from './and.js';
import { createComparisonHandler } from './comparison.js';
import { createExistsHandler } from './exists.js';
import { inHandler } from './in.js';
import { likeHandler } from './like.js';
import { notHandler } from './not.js';
import { createNotExistsHandler } from './not-exists.js';
import { nullHandler } from './null.js';
import { orHandler } from './or.js';
import { createRangeHandler } from './range.js';
import { createRelationFilterHandler } from './relation-filter.js';
import { createSubqueryHandler } from './subquery.js';

// ============================================================================
// Handler Registration
// ============================================================================

/**
 * Register simple WHERE handlers.
 * Call this once at module initialization.
 */
export function registerWhereHandlers(): void {
	// Cast needed: specific handlers have narrower types than the generic registry
	registerWhereHandler('like', likeHandler as unknown as WhereHandler);
	registerWhereHandler('in', inHandler as unknown as WhereHandler);
	registerWhereHandler('null', nullHandler as unknown as WhereHandler);
	registerWhereHandler('and', andHandler as unknown as WhereHandler);
	registerWhereHandler('or', orHandler as unknown as WhereHandler);
	registerWhereHandler('not', notHandler as unknown as WhereHandler);
}

/**
 * Helper functions for complex WHERE handlers.
 * Uses `any` for Kysely generics that cannot be typed precisely at this layer.
 */
type ComplexWhereHelpers = {
	compileExists: (
		eb: any,
		where: any,
		alias: string,
		model: any,
		plan: any,
		state: any,
		negated: boolean,
		schemaName?: string,
	) => any;
	compileJoinedRelationConditions: (
		eb: any,
		options: { relation: string; where?: any; mode: 'some' | 'every' | 'none' },
		alias: string,
		model: any,
		plan: any,
		state: any,
		schemaName?: string,
	) => any;
	compileRelationFilter: (
		eb: any,
		where: any,
		alias: string,
		model: any,
		plan: any,
		state: any,
		schemaName?: string,
	) => any;
	compileSubquery: (
		eb: any,
		where: any,
		alias: string,
		model: any,
		plan: any,
		state: any,
		schemaName?: string,
	) => any;
};

/**
 * Register complex WHERE handlers that require helper functions.
 * Must be called after registerWhereHandlers() with the helper functions from compiler.ts.
 */
export function registerComplexWhereHandlers(
	helpers: ComplexWhereHelpers,
): void {
	// Comparison and range handlers need compileExists for relation-path fields
	const comparisonHandler = createComparisonHandler(helpers.compileExists);
	const rangeHandler = createRangeHandler(helpers.compileExists);

	registerWhereHandler(
		'comparison',
		comparisonHandler as unknown as WhereHandler,
	);
	registerWhereHandler('range', rangeHandler as unknown as WhereHandler);

	const existsHandler = createExistsHandler(
		helpers.compileExists,
		helpers.compileJoinedRelationConditions,
	);
	const notExistsHandler = createNotExistsHandler(
		helpers.compileExists,
		helpers.compileJoinedRelationConditions,
	);
	const relationFilterHandler = createRelationFilterHandler(
		helpers.compileRelationFilter,
	);
	const subqueryHandler = createSubqueryHandler(helpers.compileSubquery);

	registerWhereHandler('exists', existsHandler as unknown as WhereHandler);
	registerWhereHandler(
		'notExists',
		notExistsHandler as unknown as WhereHandler,
	);
	registerWhereHandler(
		'relationFilter',
		relationFilterHandler as unknown as WhereHandler,
	);
	registerWhereHandler('subquery', subqueryHandler as unknown as WhereHandler);
}

// ============================================================================
// Re-exports
// ============================================================================

// Simple handlers
export { andHandler } from './and.js';
export { createComparisonHandler } from './comparison.js';
// Complex handler factories
export { createExistsHandler } from './exists.js';
export { inHandler } from './in.js';
export { likeHandler } from './like.js';
export { notHandler } from './not.js';
export { createNotExistsHandler } from './not-exists.js';
export { nullHandler } from './null.js';
export { orHandler } from './or.js';
export { createRangeHandler } from './range.js';
export { createRelationFilterHandler } from './relation-filter.js';
export { createSubqueryHandler } from './subquery.js';
