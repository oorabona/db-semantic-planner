/**
 * @module compiler/handlers/expression
 * Expression handlers registration.
 */

import { registerExpressionHandler } from '../../registry.js';
import type { ExpressionHandler } from '../../types.js';
import { coalesceHandler } from './coalesce.js';
import { rawHandler } from './raw.js';
import { windowHandler } from './window.js';

// ============================================================================
// Handler Registration
// ============================================================================

/**
 * Register all expression handlers.
 * Call this once at module initialization.
 */
export function registerExpressionHandlers(): void {
	// Cast needed: specific handlers have narrower types than the generic registry
	registerExpressionHandler(
		'coalesce',
		coalesceHandler as unknown as ExpressionHandler,
	);
	registerExpressionHandler('raw', rawHandler as unknown as ExpressionHandler);
	registerExpressionHandler(
		'window',
		windowHandler as unknown as ExpressionHandler,
	);
}

// ============================================================================
// Re-exports
// ============================================================================

export { coalesceHandler } from './coalesce.js';
export { rawHandler } from './raw.js';
export { windowHandler } from './window.js';
