/**
 * Handler Registry for adapter-pgsql
 *
 * Central registry for WHERE, EXPRESSION, and INCLUDE handlers.
 * Handlers are registered at module initialization and looked up by operator/type.
 */

import type { Node } from '@pgsql/types';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	ExpressionHandler,
	IncludeHandler,
	WhereDispatcher,
	WhereHandler,
} from './types.js';

// Re-export types
export * from './types.js';

// ============================================================================
// Handler Registries
// ============================================================================

const whereHandlers = new Map<string, WhereHandler>();
const expressionHandlers = new Map<string, ExpressionHandler>();
const includeHandlers = new Map<string, IncludeHandler>();

// ============================================================================
// Registration Functions
// ============================================================================

/**
 * Register a WHERE handler for one or more operators.
 */
export function registerWhereHandler(handler: WhereHandler): void {
	for (const op of handler.operators) {
		if (whereHandlers.has(op)) {
			throw new Error(`WHERE handler already registered for operator: ${op}`);
		}
		whereHandlers.set(op, handler);
	}
}

/**
 * Register an EXPRESSION handler for one or more types.
 */
export function registerExpressionHandler(handler: ExpressionHandler): void {
	for (const type of handler.types) {
		if (expressionHandlers.has(type)) {
			throw new Error(
				`EXPRESSION handler already registered for type: ${type}`,
			);
		}
		expressionHandlers.set(type, handler);
	}
}

/**
 * Register an INCLUDE handler for a strategy.
 */
export function registerIncludeHandler(handler: IncludeHandler): void {
	if (includeHandlers.has(handler.strategy)) {
		throw new Error(
			`INCLUDE handler already registered for strategy: ${handler.strategy}`,
		);
	}
	includeHandlers.set(handler.strategy, handler);
}

// ============================================================================
// Lookup Functions
// ============================================================================

/**
 * Get WHERE handler for an operator.
 * @throws Error if no handler registered
 */
export function getWhereHandler(operator: string): WhereHandler {
	const handler = whereHandlers.get(operator);
	if (!handler) {
		throw new Error(`No WHERE handler registered for operator: ${operator}`);
	}
	return handler;
}

/**
 * Get EXPRESSION handler for a type.
 * @throws Error if no handler registered
 */
export function getExpressionHandler(type: string): ExpressionHandler {
	const handler = expressionHandlers.get(type);
	if (!handler) {
		throw new Error(`No EXPRESSION handler registered for type: ${type}`);
	}
	return handler;
}

/**
 * Get INCLUDE handler for a strategy.
 * @throws Error if no handler registered
 */
export function getIncludeHandler(
	strategy: 'join' | 'lateral' | 'json_agg' | 'cte',
): IncludeHandler {
	const handler = includeHandlers.get(strategy);
	if (!handler) {
		throw new Error(`No INCLUDE handler registered for strategy: ${strategy}`);
	}
	return handler;
}

/**
 * Check if a WHERE handler exists for an operator.
 */
export function hasWhereHandler(operator: string): boolean {
	return whereHandlers.has(operator);
}

/**
 * Check if an EXPRESSION handler exists for a type.
 */
export function hasExpressionHandler(type: string): boolean {
	return expressionHandlers.has(type);
}

/**
 * Check if an INCLUDE handler exists for a strategy.
 */
export function hasIncludeHandler(
	strategy: 'join' | 'lateral' | 'json_agg' | 'cte',
): boolean {
	return includeHandlers.has(strategy);
}

// ============================================================================
// Dispatcher (for recursive WHERE compilation)
// ============================================================================

/**
 * Create a WHERE dispatcher that looks up handlers from the registry.
 */
export function createWhereDispatcher(): WhereDispatcher {
	return (
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node => {
		const operator = decision.operator ?? '=';
		const handler = getWhereHandler(operator);
		return handler.compile(decision, ctx, state, createWhereDispatcher());
	};
}

// ============================================================================
// Registry Stats (for debugging/testing)
// ============================================================================

/**
 * Get counts of registered handlers.
 */
export function getRegistryStats(): {
	where: number;
	expression: number;
	include: number;
} {
	return {
		where: whereHandlers.size,
		expression: expressionHandlers.size,
		include: includeHandlers.size,
	};
}

/**
 * Get all registered operator names (for debugging).
 */
export function getRegisteredOperators(): {
	where: string[];
	expression: string[];
	include: string[];
} {
	return {
		where: Array.from(whereHandlers.keys()),
		expression: Array.from(expressionHandlers.keys()),
		include: Array.from(includeHandlers.keys()),
	};
}

/**
 * Clear all handlers (for testing only).
 */
export function clearHandlers(): void {
	whereHandlers.clear();
	expressionHandlers.clear();
	includeHandlers.clear();
}

// ============================================================================
// Re-export Specific Handlers
// ============================================================================

// EXPRESSION handlers
export * from './expression/index.js';
// INCLUDE handlers
export * from './include/index.js';
// WHERE handlers
export * from './where/index.js';

// ============================================================================
// WHERE Handler Exports
// ============================================================================

export {
	andHandler,
	comparisonHandler,
	inHandler,
	likeHandler,
	notHandler,
	nullHandler,
	orHandler,
	registerSimpleWhereHandlers,
	simpleWhereHandlers,
} from './where/index.js';
