/**
 * @module compiler
 * Compiler module exports.
 */

export { registerExpressionHandlers } from './handlers/expression/index.js';
export {
	applyCteIncludes,
	applyJoinIncludes,
	applyJsonAggIncludes,
	applyLateralIncludes,
	registerIncludeHandlers,
} from './handlers/include/index.js';

// Handler registration
export {
	registerComplexWhereHandlers,
	registerWhereHandlers,
} from './handlers/where/index.js';
// Helpers
export {
	collectCteIncludes,
	collectJoinIncludes,
	collectJsonAggIncludes,
	collectLateralIncludes,
	findFilterStrategyDecision,
	findIncludeStrategyDecision,
	getNextAlias,
	getTableFromAlias,
	lookupResolvedRelation,
	normalizeForeignKey,
	normalizePrimaryKey,
} from './helpers.js';
// Registry
export {
	getExpressionHandler,
	getIncludeHandler,
	getWhereHandler,
	hasExpressionHandler,
	hasIncludeHandler,
	hasWhereHandler,
	registerExpressionHandler,
	registerIncludeHandler,
	registerWhereHandler,
} from './registry.js';
// Types
export type {
	CompilerContext,
	CompilerState,
	ExpressionHandler,
	IncludeHandler,
	WhereDispatcher,
	WhereHandler,
} from './types.js';
