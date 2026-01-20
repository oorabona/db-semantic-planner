/**
 * @module compiler/registry
 * Handler registries for the compiler dispatcher pattern.
 */

import type {
	ExpressionHandler,
	IncludeHandler,
	WhereHandler,
} from './types.js';

// ============================================================================
// WHERE Handlers Registry
// ============================================================================

const whereHandlers = new Map<string, WhereHandler>();

/**
 * Register a WHERE handler for a specific kind.
 * @param kind The WhereIntent.kind this handler processes
 * @param handler The handler function
 */
export function registerWhereHandler<K extends string>(
	kind: K,
	handler: WhereHandler,
): void {
	whereHandlers.set(kind, handler);
}

/**
 * Get a WHERE handler for a specific kind.
 * @param kind The WhereIntent.kind to look up
 * @returns The handler or undefined if not registered
 */
export function getWhereHandler(kind: string): WhereHandler | undefined {
	return whereHandlers.get(kind);
}

/**
 * Check if a WHERE handler is registered for a kind.
 * @param kind The WhereIntent.kind to check
 */
export function hasWhereHandler(kind: string): boolean {
	return whereHandlers.has(kind);
}

// ============================================================================
// Expression Handlers Registry
// ============================================================================

const expressionHandlers = new Map<string, ExpressionHandler>();

/**
 * Register an expression handler for a specific kind.
 * @param kind The ExpressionIntent.kind this handler processes
 * @param handler The handler function
 */
export function registerExpressionHandler<K extends string>(
	kind: K,
	handler: ExpressionHandler,
): void {
	expressionHandlers.set(kind, handler);
}

/**
 * Get an expression handler for a specific kind.
 * @param kind The ExpressionIntent.kind to look up
 * @returns The handler or undefined if not registered
 */
export function getExpressionHandler(
	kind: string,
): ExpressionHandler | undefined {
	return expressionHandlers.get(kind);
}

/**
 * Check if an expression handler is registered for a kind.
 * @param kind The ExpressionIntent.kind to check
 */
export function hasExpressionHandler(kind: string): boolean {
	return expressionHandlers.has(kind);
}

// ============================================================================
// Include Strategy Handlers Registry
// ============================================================================

const includeHandlers = new Map<string, IncludeHandler>();

/**
 * Register an include strategy handler.
 * @param strategy The include strategy this handler processes
 * @param handler The handler function
 */
export function registerIncludeHandler(
	strategy: string,
	handler: IncludeHandler,
): void {
	includeHandlers.set(strategy, handler);
}

/**
 * Get an include strategy handler.
 * @param strategy The strategy to look up
 * @returns The handler or undefined if not registered
 */
export function getIncludeHandler(
	strategy: string,
): IncludeHandler | undefined {
	return includeHandlers.get(strategy);
}

/**
 * Check if an include handler is registered for a strategy.
 * @param strategy The strategy to check
 */
export function hasIncludeHandler(strategy: string): boolean {
	return includeHandlers.has(strategy);
}
