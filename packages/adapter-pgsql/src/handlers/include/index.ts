/**
 * INCLUDE Strategy Handlers Registration
 *
 * Exports all include strategy handlers and provides registration functions.
 */

import { registerIncludeHandler } from '../index.js';
import { cteIncludeHandler } from './cte.js';
// Handler imports
import { joinIncludeHandler } from './join.js';
import { jsonAggIncludeHandler } from './json-agg.js';
import { lateralIncludeHandler } from './lateral.js';

export { cteIncludeHandler } from './cte.js';
// Re-exports
export { joinIncludeHandler } from './join.js';
export { jsonAggIncludeHandler } from './json-agg.js';
export { lateralIncludeHandler } from './lateral.js';

/**
 * All include strategy handlers
 */
const allIncludeHandlers = [
	joinIncludeHandler,
	lateralIncludeHandler,
	jsonAggIncludeHandler,
	cteIncludeHandler,
];

/**
 * Register all include handlers.
 * The compiler calls this through ensureIncludeHandlersRegistered on first use; calling it directly
 * leaves that gate unset, so the compiler registers the same handlers again and throws.
 */
export function registerAllIncludeHandlers(): void {
	for (const handler of allIncludeHandlers) {
		registerIncludeHandler(handler);
	}
}
