/**
 * Handler Registry for adapter-pgsql
 *
 * Central registry for EXPRESSION and INCLUDE handlers.
 * Each family's built-in handlers are registered lazily on that family's first use and looked up by operator/type.
 */

import { escapeDiagnosticText } from '../validate.js';
import { allExpressionHandlers } from './expression/index.js';
import { allIncludeHandlers } from './include/index.js';
import type {
	ExpressionHandler,
	IncludeHandler,
	IncludeHandlerStrategy,
} from './types.js';
import { INCLUDE_STRATEGIES } from './types.js';

// Re-export types
export * from './types.js';

// ============================================================================
// Handler Registries
// ============================================================================

const expressionHandlers = new Map<string, ExpressionHandler>();
const includeHandlers = new Map<string, IncludeHandler>();

function describeDiagnosticValue(value: unknown): string {
	return typeof value === 'string'
		? escapeDiagnosticText(value)
		: String(value);
}

function requireHandlerObject(
	handler: unknown,
	family: 'EXPRESSION' | 'INCLUDE',
): Record<string, unknown> {
	if (
		typeof handler !== 'object' ||
		handler === null ||
		Array.isArray(handler)
	) {
		throw new Error(
			`Invalid ${family} handler: expected an object, received ${handler === null ? 'null' : typeof handler}`,
		);
	}
	return handler as Record<string, unknown>;
}

function validateHandlerKeys(
	handler: unknown,
	family: 'EXPRESSION',
	keyProperty: 'types',
): readonly string[] {
	const candidate = requireHandlerObject(handler, family);
	const keys = candidate[keyProperty];
	if (!Array.isArray(keys)) {
		throw new Error(
			`Invalid ${family} handler ${keyProperty}: expected an array, received ${typeof keys}`,
		);
	}
	if (typeof candidate.compile !== 'function') {
		throw new Error(
			`Invalid ${family} handler compile: expected a function, received ${typeof candidate.compile}`,
		);
	}
	const copiedKeys = [...keys];
	if (copiedKeys.length === 0) {
		throw new Error(
			`Invalid ${family} handler ${keyProperty}: cannot be empty`,
		);
	}
	const seen = new Set<string>();
	for (const key of copiedKeys) {
		if (typeof key !== 'string') {
			throw new Error(
				`Invalid ${family} handler key: expected a string, received ${typeof key}`,
			);
		}
		if (key.length === 0) {
			throw new Error(
				`Invalid ${family} handler key: cannot be empty (received ${describeDiagnosticValue(key)})`,
			);
		}
		if (key.trim().length === 0) {
			throw new Error(
				`Invalid ${family} handler key: cannot be blank (received ${describeDiagnosticValue(key)})`,
			);
		}
		if (seen.has(key)) {
			throw new Error(
				`Invalid ${family} handler key: duplicate ${describeDiagnosticValue(key)} in one registration`,
			);
		}
		seen.add(key);
	}
	return copiedKeys;
}

function validateIncludeHandler(handler: unknown): string {
	const candidate = requireHandlerObject(handler, 'INCLUDE');
	const strategy = candidate.strategy;
	if (typeof strategy !== 'string') {
		throw new Error(
			`Invalid INCLUDE handler strategy: expected a string, received ${typeof strategy}`,
		);
	}
	if (strategy.length === 0) {
		throw new Error(
			`Invalid INCLUDE handler strategy: cannot be empty (received ${describeDiagnosticValue(strategy)})`,
		);
	}
	if (strategy.trim().length === 0) {
		throw new Error(
			`Invalid INCLUDE handler strategy: cannot be blank (received ${describeDiagnosticValue(strategy)})`,
		);
	}
	if (!INCLUDE_STRATEGIES.some((accepted) => accepted === strategy)) {
		throw new Error(
			`Invalid INCLUDE handler strategy: ${describeDiagnosticValue(strategy)} is not one of ${INCLUDE_STRATEGIES.map(describeDiagnosticValue).join(', ')}`,
		);
	}
	if (typeof candidate.compile !== 'function') {
		throw new Error(
			`Invalid INCLUDE handler compile: expected a function, received ${typeof candidate.compile}`,
		);
	}
	return strategy;
}

function addHandlerKeys<Handler>(
	registry: Map<string, Handler>,
	keys: readonly string[],
	handler: Handler,
	family: 'EXPRESSION' | 'INCLUDE',
	keyName: 'operator' | 'type' | 'strategy',
): void {
	for (const key of keys) {
		if (registry.has(key)) {
			throw new Error(
				`${family} handler already registered for ${keyName}: ${describeDiagnosticValue(key)}`,
			);
		}
	}
	for (const key of keys) registry.set(key, handler);
}

function installExpressionHandler(handler: ExpressionHandler): void {
	addHandlerKeys(
		expressionHandlers,
		validateHandlerKeys(handler, 'EXPRESSION', 'types'),
		handler,
		'EXPRESSION',
		'type',
	);
}

function installIncludeHandler(handler: IncludeHandler): void {
	addHandlerKeys(
		includeHandlers,
		[validateIncludeHandler(handler)],
		handler,
		'INCLUDE',
		'strategy',
	);
}

/** Register an EXPRESSION handler for one or more types. */
export function registerExpressionHandler(handler: ExpressionHandler): void {
	const types = validateHandlerKeys(handler, 'EXPRESSION', 'types');
	ensureExpressionHandlersRegistered();
	addHandlerKeys(expressionHandlers, types, handler, 'EXPRESSION', 'type');
}

// ============================================================================
// Lookup Functions
// ============================================================================

/**
 * Get EXPRESSION handler for a type.
 * @throws Error if no handler registered
 */
export function getExpressionHandler(type: string): ExpressionHandler {
	const handler = expressionHandlers.get(type);
	if (!handler) {
		throw new Error(
			`No EXPRESSION handler registered for type: ${describeDiagnosticValue(type)}`,
		);
	}
	return handler;
}

/**
 * Get an EXPRESSION handler only if it explicitly opted into NQL-origin use.
 *
 * This keeps NQL function names away from builder-only escape hatches such as
 * raw/rawSql/rawExpression by construction.
 */
export function getNqlSafeExpressionHandler(
	type: string,
): ExpressionHandler | undefined {
	const handler = expressionHandlers.get(type);
	return handler?.nqlSafe === true ? handler : undefined;
}

/**
 * Get INCLUDE handler for a strategy.
 * @throws Error if no handler registered
 */
export function getIncludeHandler(
	strategy: IncludeHandlerStrategy,
): IncludeHandler {
	const handler = includeHandlers.get(strategy);
	if (!handler) {
		throw new Error(
			`No INCLUDE handler registered for strategy: ${describeDiagnosticValue(strategy)}`,
		);
	}
	return handler;
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
export function hasIncludeHandler(strategy: IncludeHandlerStrategy): boolean {
	return includeHandlers.has(strategy);
}

// ============================================================================
// Registration state
// ============================================================================

type HandlerRegistrationState =
	| 'uninitialized'
	| 'initializing'
	| 'initialized';

function refuseReentrantHandlerRegistryUse(
	families: readonly ('EXPRESSION' | 'INCLUDE')[],
): never {
	const diagnosticFamilies = families
		.map((family) => describeDiagnosticValue(family))
		.join(', ');
	throw new Error(
		`Cannot use ${diagnosticFamilies} handler registry reentrantly while ${diagnosticFamilies} handlers are initializing`,
	);
}

let includeHandlersState: HandlerRegistrationState = 'uninitialized';
export function ensureIncludeHandlersRegistered(): void {
	if (includeHandlersState === 'initialized') return;
	if (includeHandlersState === 'initializing')
		refuseReentrantHandlerRegistryUse(['INCLUDE']);
	const snapshot = new Map(includeHandlers);
	includeHandlersState = 'initializing';
	try {
		for (const handler of allIncludeHandlers) installIncludeHandler(handler);
	} catch (error) {
		includeHandlers.clear();
		for (const [key, handler] of snapshot) includeHandlers.set(key, handler);
		includeHandlersState = 'uninitialized';
		throw error;
	}
	includeHandlersState = 'initialized';
}

let expressionHandlersState: HandlerRegistrationState = 'uninitialized';
export function ensureExpressionHandlersRegistered(): void {
	if (expressionHandlersState === 'initialized') return;
	if (expressionHandlersState === 'initializing')
		refuseReentrantHandlerRegistryUse(['EXPRESSION']);
	const snapshot = new Map(expressionHandlers);
	expressionHandlersState = 'initializing';
	try {
		for (const handler of allExpressionHandlers)
			installExpressionHandler(handler);
	} catch (error) {
		expressionHandlers.clear();
		for (const [key, handler] of snapshot) expressionHandlers.set(key, handler);
		expressionHandlersState = 'uninitialized';
		throw error;
	}
	expressionHandlersState = 'initialized';
}

// ============================================================================
// Registry Stats (for debugging/testing)
// ============================================================================

/**
 * Get counts of registered handlers.
 */
export function getRegistryStats(): {
	expression: number;
	include: number;
} {
	return {
		expression: expressionHandlers.size,
		include: includeHandlers.size,
	};
}

/**
 * Get all registered operator names (for debugging).
 */
export function getRegisteredOperators(): {
	expression: string[];
	include: string[];
} {
	return {
		expression: Array.from(expressionHandlers.keys()),
		include: Array.from(includeHandlers.keys()),
	};
}

/**
 * Reset all handler registries. Each family's next registrar or compilation path restores that family's built-ins independently.
 */
export function clearHandlers(): void {
	const initializingFamilies = [
		...(expressionHandlersState === 'initializing'
			? ['EXPRESSION' as const]
			: []),
		...(includeHandlersState === 'initializing' ? ['INCLUDE' as const] : []),
	];
	if (initializingFamilies.length > 0)
		refuseReentrantHandlerRegistryUse(initializingFamilies);

	expressionHandlers.clear();
	includeHandlers.clear();
	includeHandlersState = 'uninitialized';
	expressionHandlersState = 'uninitialized';
}

// ============================================================================
// Re-export Specific Handlers
// ============================================================================

// EXPRESSION handlers
export * from './expression/index.js';
// INCLUDE handlers
export * from './include/index.js';
