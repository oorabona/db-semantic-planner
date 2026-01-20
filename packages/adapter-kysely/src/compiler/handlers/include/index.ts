/**
 * @module compiler/handlers/include
 * Include strategy handlers registration.
 */

import type { ModelIR, PlanReport } from '@dbsp/core';
import type { Kysely } from 'kysely';
import { registerIncludeHandler } from '../../registry.js';
import type { CompilerState, IncludeHandler } from '../../types.js';
import { createCteIncludeHandler } from './cte.js';
import { createJoinIncludeHandler } from './join.js';
import { createJsonAggIncludeHandler } from './json-agg.js';
import { createLateralIncludeHandler } from './lateral.js';

// ============================================================================
// Helper Types
// ============================================================================

/**
 * Extended context for CTE handler - includes Kysely instance.
 */
export interface CteIncludeContext {
	model: ModelIR;
	plan: PlanReport;
	state: CompilerState;
	schemaName?: string;
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	kysely: Kysely<any>;
}

/**
 * Helper functions required for include handler registration.
 * Note: All include handlers are now fully self-contained - no injection needed.
 */
export type IncludeHandlerHelpers = Record<string, never>;

// ============================================================================
// Handler Registration
// ============================================================================

/**
 * Register all include strategy handlers.
 * Call this once at module initialization.
 * All handlers are now self-contained with their logic fully extracted.
 */
export function registerIncludeHandlers(
	_helpers?: IncludeHandlerHelpers,
): void {
	// All handlers are now fully self-contained - no injection needed
	const joinHandler = createJoinIncludeHandler();
	const lateralHandler = createLateralIncludeHandler();
	const jsonAggHandler = createJsonAggIncludeHandler();
	const cteHandler = createCteIncludeHandler();

	// Register handlers - cast needed for type compatibility
	registerIncludeHandler('join', joinHandler as unknown as IncludeHandler);
	registerIncludeHandler(
		'lateral',
		lateralHandler as unknown as IncludeHandler,
	);
	registerIncludeHandler(
		'json_agg',
		jsonAggHandler as unknown as IncludeHandler,
	);
	registerIncludeHandler('cte', cteHandler as unknown as IncludeHandler);
}

// ============================================================================
// Re-exports
// ============================================================================

export type { ApplyCteIncludesFn } from './cte.js';
export { applyCteIncludes, createCteIncludeHandler } from './cte.js';
export { applyJoinIncludes, createJoinIncludeHandler } from './join.js';
export type { ApplyJsonAggIncludesFn } from './json-agg.js';
export {
	applyJsonAggIncludes,
	createJsonAggIncludeHandler,
} from './json-agg.js';
export type { ApplyLateralIncludesFn } from './lateral.js';
export {
	applyLateralIncludes,
	createLateralIncludeHandler,
} from './lateral.js';
