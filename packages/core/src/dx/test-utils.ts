/**
 * Shared test utilities for @dbsp/core tests.
 *
 * Provides a configurable MockAdapter that satisfies the Adapter interface
 * without requiring a real database connection. Used by all core tests
 * that need createOrm() with controllable dialect capabilities.
 */

import type { Adapter, AdapterCapabilities, DbCasing } from '../adapter.js';
import {
	type DialectCapabilities,
	POSTGRESQL_CAPABILITIES,
} from '../dialects/index.js';

// ============================================================================
// MockAdapter Options
// ============================================================================

/**
 * Options for creating a mock adapter.
 *
 * @example Default (PostgreSQL capabilities)
 * ```typescript
 * const adapter = createMockAdapter();
 * ```
 *
 * @example Custom capabilities
 * ```typescript
 * const adapter = createMockAdapter({
 *   dialectCapabilities: { ...POSTGRESQL_CAPABILITIES, supportsLateralJoin: false },
 * });
 * ```
 */
export interface MockAdapterOptions {
	/** Dialect capabilities (default: POSTGRESQL_CAPABILITIES) */
	readonly dialectCapabilities?: DialectCapabilities;
	/** DB casing convention (default: 'preserve') */
	readonly dbCasing?: DbCasing;
}

// ============================================================================
// Mock Adapter Factory
// ============================================================================

/**
 * Create a mock adapter for testing.
 *
 * All execution methods throw "Not implemented" — use adapter-pgsql for SQL execution tests.
 * Compile methods also throw — use createPgsqlCompileOnlyAdapter() for SQL generation tests.
 *
 * The mock adapter's primary purpose is to provide `dialectCapabilities` and
 * `capabilities` for planner strategy selection in core tests.
 */
export function createMockAdapter(options?: MockAdapterOptions): Adapter {
	const dialectCaps = options?.dialectCapabilities ?? POSTGRESQL_CAPABILITIES;
	const dbCasing = options?.dbCasing ?? 'preserve';

	const notImplemented = () => {
		throw new Error(
			'Not implemented in mock adapter — use adapter-pgsql for SQL tests',
		);
	};

	return {
		capabilities: {
			supportsReturning: dialectCaps.supportsReturning,
			supportsSchemas: dialectCaps.supportsSchemas,
			supportsStreaming: false,
			supportsTransactions: false,
			supportsRecursiveCTE: dialectCaps.supportsRecursiveCTE,
			supportsWindowFunctions: dialectCaps.supportsWindowFunctions,
			supportsArrayType: dialectCaps.supportsArrayType,
		} satisfies AdapterCapabilities,
		dialectCapabilities: dialectCaps,
		dbCasing,
		inTransaction: false,
		compile: notImplemented,
		compileWithIncludes: notImplemented,
		compileSubqueryInclude: notImplemented,
		compileInsert: notImplemented,
		compileInsertFrom: notImplemented,
		compileUpdate: notImplemented,
		compileBatchUpdate: notImplemented,
		compileDelete: notImplemented,
		compileUpsert: notImplemented,
		compileUpsertFrom: notImplemented,
		compileRecursive: notImplemented,
		compileCteQuery: notImplemented,
		compileSetOperation: notImplemented,
		createDump: notImplemented,
		execute: notImplemented,
		executeOne: notImplemented,
		executeOneOrThrow: notImplemented,
		stream: notImplemented as () => AsyncIterableIterator<never>,
		transaction: notImplemented,
		withSchema: () => createMockAdapter(options),
		introspect: notImplemented,
		executeRaw: notImplemented,
		generateDDL: notImplemented,
		compileSelectExpression: notImplemented,
		validateIdentifier: () => {},
	};
}
