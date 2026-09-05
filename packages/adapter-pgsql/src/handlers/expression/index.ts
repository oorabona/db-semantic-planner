/**
 * EXPRESSION Handlers Registration
 *
 * Exports all expression handlers as immutable collections.
 */

import {
	avgHandler,
	countDistinctHandler,
	countHandler,
	genericAggregateHandler,
	maxHandler,
	minHandler,
	sumHandler,
} from './aggregate.js';
import { arithmeticHandler } from './arithmetic.js';
import { caseHandler, simpleCaseHandler } from './case.js';
import {
	coalesceHandler,
	greatestHandler,
	leastHandler,
	nullIfHandler,
} from './coalesce.js';
// Handler imports
import { columnAliasHandler, columnHandler, starHandler } from './column.js';
import { customExpressionHandler } from './custom.js';
import { jsonExtractHandler, jsonPathExtractHandler } from './json.js';
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
export { arithmeticHandler } from './arithmetic.js';
export { caseHandler, simpleCaseHandler } from './case.js';
export {
	coalesceHandler,
	greatestHandler,
	leastHandler,
	nullIfHandler,
} from './coalesce.js';
// Re-exports
export { columnAliasHandler, columnHandler, starHandler } from './column.js';
export { compileExpressionIntent, customExpressionHandler } from './custom.js';
export { jsonExtractHandler, jsonPathExtractHandler } from './json.js';
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
const columnExpressionHandlers = [
	columnHandler,
	columnAliasHandler,
	starHandler,
];

/**
 * Aggregate expression handlers
 */
const aggregateExpressionHandlers = [
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
const conditionalExpressionHandlers = [
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
const windowExpressionHandlers = [
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
const rawExpressionHandlers = [rawHandler, sqlFunctionHandler, literalHandler];

/**
 * JSON expression handlers
 */
const jsonExpressionHandlers = [jsonExtractHandler, jsonPathExtractHandler];

/**
 * Pseudo-column expression handlers (hierarchy traversal)
 */
const pseudoExpressionHandlers = [
	pseudoColumnHandler,
	singleHopPseudoHandler,
	chainedPseudoHandler,
];

/**
 * Relation column expansion handlers
 */
const relationExpressionHandlers = [
	relationStarHandler,
	relationColumnHandler,
	relationColumnsHandler,
	relationAliasHandler,
	prefixedRelationColumnHandler,
];

/**
 * All expression handlers
 */
export const allExpressionHandlers = Object.freeze([
	...columnExpressionHandlers,
	...aggregateExpressionHandlers,
	...conditionalExpressionHandlers,
	...windowExpressionHandlers,
	...rawExpressionHandlers,
	...pseudoExpressionHandlers,
	...relationExpressionHandlers,
	...jsonExpressionHandlers,
	arithmeticHandler,
	customExpressionHandler,
]);
