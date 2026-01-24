/**
 * @module compiler/handlers/expression
 * Expression handlers registration.
 */

import { registerExpressionHandler } from '../../registry.js';
import type { ExpressionHandler } from '../../types.js';
import { aggregateHandler } from './aggregate.js';
import { coalesceHandler } from './coalesce.js';
import { columnHandler } from './column.js';
import { columnAliasHandler } from './columnAlias.js';
import { rawHandler } from './raw.js';
import { relationColumnHandler } from './relationColumn.js';
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
		'aggregate',
		aggregateHandler as unknown as ExpressionHandler,
	);
	registerExpressionHandler(
		'coalesce',
		coalesceHandler as unknown as ExpressionHandler,
	);
	registerExpressionHandler(
		'column',
		columnHandler as unknown as ExpressionHandler,
	);
	registerExpressionHandler('raw', rawHandler as unknown as ExpressionHandler);
	registerExpressionHandler(
		'columnAlias',
		columnAliasHandler as unknown as ExpressionHandler,
	);
	registerExpressionHandler(
		'window',
		windowHandler as unknown as ExpressionHandler,
	);
	registerExpressionHandler(
		'relationColumn',
		relationColumnHandler as unknown as ExpressionHandler,
	);
}

// ============================================================================
// Re-exports
// ============================================================================

export { aggregateHandler } from './aggregate.js';
export { coalesceHandler } from './coalesce.js';
export { columnHandler } from './column.js';
export { columnAliasHandler } from './columnAlias.js';
export { rawHandler } from './raw.js';
export { relationColumnHandler } from './relationColumn.js';
export { windowHandler } from './window.js';
