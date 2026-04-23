import type { Adapter } from '../adapter.js';
import type { DialectCapabilities } from '../dialects/index.js';
import type { ModelIR } from '../model-ir.js';
import type { PlanOptions } from '../planner.js';
import type { HookErrorHandler, HookStore } from './hooks.js';
import type { DefaultFilters } from './schema.js';

/**
 * Immutable context bag for QueryBuilderImpl.
 * Replaces the 12-parameter positional constructor with a named-field struct,
 * eliminating silent-reorder footguns on structural types.
 */
export interface QueryBuilderContext {
	readonly model: ModelIR;
	readonly strictMode: boolean;
	readonly adapter?: Adapter | undefined;
	readonly schemaName?: string | undefined;
	readonly dialectCapabilities?: DialectCapabilities | undefined;
	readonly planOptionsOverride?: PlanOptions | undefined;
	readonly defaultFilters?: DefaultFilters | undefined;
	readonly hookStore?: HookStore | undefined;
	readonly onHookError?: HookErrorHandler | undefined;
	readonly inTransaction?: boolean | undefined;
}
