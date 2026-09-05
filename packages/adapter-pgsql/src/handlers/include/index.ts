/**
 * INCLUDE Strategy Handlers Registration
 *
 * Exports all include strategy handlers as an immutable collection.
 */

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
export const allIncludeHandlers = Object.freeze([
	joinIncludeHandler,
	lateralIncludeHandler,
	jsonAggIncludeHandler,
	cteIncludeHandler,
]);
