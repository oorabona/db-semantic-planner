/**
 * EXPRESSION Handlers Registration
 *
 * Exports all expression handlers and provides registration functions.
 */

import { registerExpressionHandler } from '../index.js';
import {
	avgHandler,
	countDistinctHandler,
	countHandler,
	genericAggregateHandler,
	maxHandler,
	minHandler,
	sumHandler,
} from './aggregate.js';
import { caseHandler, simpleCaseHandler } from './case.js';
import {
	coalesceHandler,
	greatestHandler,
	leastHandler,
	nullIfHandler,
} from './coalesce.js';
// Handler imports
import { columnAliasHandler, columnHandler, starHandler } from './column.js';
import {
	chainedPseudoHandler,
	pseudoColumnHandler,
	singleHopPseudoHandler,
} from './pseudo.js';
import { literalHandler, rawHandler, sqlFunctionHandler } from './raw.js';
import {
	prefixedRelationColumnHandler,
	relationAliasHandler,
	relationColumnHandler,
	relationColumnsHandler,
	relationStarHandler,
} from './relation.js';
import {
	denseRankHandler,
	firstValueHandler,
	genericWindowHandler,
	lagHandler,
	lastValueHandler,
	leadHandler,
	ntileHandler,
	rankHandler,
	rowNumberHandler,
} from './window.js';

export {
	avgHandler,
	countDistinctHandler,
	countHandler,
	genericAggregateHandler,
	maxHandler,
	minHandler,
	sumHandler,
} from './aggregate.js';
export { caseHandler, simpleCaseHandler } from './case.js';
export {
	coalesceHandler,
	greatestHandler,
	leastHandler,
	nullIfHandler,
} from './coalesce.js';
// Re-exports
export { columnAliasHandler, columnHandler, starHandler } from './column.js';
export {
	chainedPseudoHandler,
	pseudoColumnHandler,
	singleHopPseudoHandler,
} from './pseudo.js';
export { literalHandler, rawHandler, sqlFunctionHandler } from './raw.js';
export {
	prefixedRelationColumnHandler,
	relationAliasHandler,
	relationColumnHandler,
	relationColumnsHandler,
	relationStarHandler,
} from './relation.js';
export {
	denseRankHandler,
	firstValueHandler,
	genericWindowHandler,
	lagHandler,
	lastValueHandler,
	leadHandler,
	ntileHandler,
	rankHandler,
	rowNumberHandler,
} from './window.js';

/**
 * Column expression handlers
 */
export const columnExpressionHandlers = [
	columnHandler,
	columnAliasHandler,
	starHandler,
];

/**
 * Aggregate expression handlers
 */
export const aggregateExpressionHandlers = [
	countHandler,
	countDistinctHandler,
	sumHandler,
	avgHandler,
	minHandler,
	maxHandler,
	genericAggregateHandler,
];

/**
 * Conditional expression handlers (CASE, COALESCE, etc.)
 */
export const conditionalExpressionHandlers = [
	caseHandler,
	simpleCaseHandler,
	coalesceHandler,
	nullIfHandler,
	greatestHandler,
	leastHandler,
];

/**
 * Window function expression handlers
 */
export const windowExpressionHandlers = [
	rowNumberHandler,
	rankHandler,
	denseRankHandler,
	ntileHandler,
	lagHandler,
	leadHandler,
	firstValueHandler,
	lastValueHandler,
	genericWindowHandler,
];

/**
 * Raw/escape hatch expression handlers
 */
export const rawExpressionHandlers = [
	rawHandler,
	sqlFunctionHandler,
	literalHandler,
];

/**
 * Pseudo-column expression handlers (hierarchy traversal)
 */
export const pseudoExpressionHandlers = [
	pseudoColumnHandler,
	singleHopPseudoHandler,
	chainedPseudoHandler,
];

/**
 * Relation column expansion handlers
 */
export const relationExpressionHandlers = [
	relationStarHandler,
	relationColumnHandler,
	relationColumnsHandler,
	relationAliasHandler,
	prefixedRelationColumnHandler,
];

/**
 * All expression handlers
 */
export const allExpressionHandlers = [
	...columnExpressionHandlers,
	...aggregateExpressionHandlers,
	...conditionalExpressionHandlers,
	...windowExpressionHandlers,
	...rawExpressionHandlers,
	...pseudoExpressionHandlers,
	...relationExpressionHandlers,
];

/**
 * Register all expression handlers.
 * Should be called once at module initialization.
 */
export function registerAllExpressionHandlers(): void {
	for (const handler of allExpressionHandlers) {
		registerExpressionHandler(handler);
	}
}
