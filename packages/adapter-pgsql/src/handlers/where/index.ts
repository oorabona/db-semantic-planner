/**
 * WHERE Handlers Registration
 *
 * Exports all WHERE handlers and provides a function to register them all.
 */

import { registerWhereHandler } from '../index.js';
import { anyHandler } from './any.js';
// Handler imports - simple
import { betweenHandler } from './between.js';
import { comparisonHandler } from './comparison.js';
import { customExpressionWhereHandler } from './custom-expression.js';
// Handler imports - complex (exists, subquery, relation)
import { everyHandler, existsHandler, notExistsHandler } from './exists.js';
import { inHandler } from './in.js';
import {
	jsonComparisonHandler,
	jsonContainsHandler,
	jsonExistsHandler,
} from './json.js';
import { likeHandler } from './like.js';
import { andHandler, notHandler, orHandler } from './logical.js';
import { nullHandler } from './null.js';
import { rangeHandler } from './range.js';
import { rawExistsHandler } from './raw-exists.js';
import {
	hasNoRelationHandler,
	hasRelationHandler,
	relationFilterHandler,
} from './relation-filter.js';
import {
	inSubqueryHandler,
	notInSubqueryHandler,
	scalarSubqueryHandler,
} from './subquery.js';

export { anyHandler } from './any.js';
// Re-export individual handlers
export { betweenHandler } from './between.js';
export { comparisonHandler } from './comparison.js';
export { customExpressionWhereHandler } from './custom-expression.js';
export { everyHandler, existsHandler, notExistsHandler } from './exists.js';
export { inHandler } from './in.js';
export {
	jsonComparisonHandler,
	jsonContainsHandler,
	jsonExistsHandler,
} from './json.js';
export { likeHandler } from './like.js';
export { andHandler, notHandler, orHandler } from './logical.js';
export { nullHandler } from './null.js';
export { rangeHandler } from './range.js';
export { rawExistsHandler } from './raw-exists.js';
export {
	hasNoRelationHandler,
	hasRelationHandler,
	relationFilterHandler,
} from './relation-filter.js';
export {
	inSubqueryHandler,
	notInSubqueryHandler,
	scalarSubqueryHandler,
} from './subquery.js';

/**
 * All simple WHERE handlers
 */
export const simpleWhereHandlers = [
	customExpressionWhereHandler,
	comparisonHandler,
	likeHandler,
	nullHandler,
	anyHandler,
	inHandler,
	andHandler,
	orHandler,
	notHandler,
	betweenHandler,
	rangeHandler,
	jsonContainsHandler,
	jsonExistsHandler,
	jsonComparisonHandler,
];

/**
 * Complex WHERE handlers (relation filtering, subqueries)
 */
const complexWhereHandlers = [
	// EXISTS-based
	existsHandler,
	notExistsHandler,
	everyHandler,
	rawExistsHandler,
	// Subquery-based
	scalarSubqueryHandler,
	inSubqueryHandler,
	notInSubqueryHandler,
	// Relation filters
	relationFilterHandler,
	hasRelationHandler,
	hasNoRelationHandler,
];

/**
 * All WHERE handlers
 */
const allWhereHandlers = [...simpleWhereHandlers, ...complexWhereHandlers];

/**
 * Register all simple WHERE handlers.
 * Should be called once at module initialization.
 */
export function registerSimpleWhereHandlers(): void {
	for (const handler of simpleWhereHandlers) {
		registerWhereHandler(handler);
	}
}

/**
 * Register all WHERE handlers (simple + complex).
 * Should be called once at module initialization.
 */
export function registerAllWhereHandlers(): void {
	for (const handler of allWhereHandlers) {
		registerWhereHandler(handler);
	}
}
