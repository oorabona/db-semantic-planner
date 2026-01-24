/**
 * Public adapter types for observability and query results
 * @module @dbsp/types/public/adapter
 */

/**
 * Metadata attached to a dump for observability
 * @public
 */
export interface DumpMeta {
	readonly schema?: string;
	readonly queryName?: string;
	readonly correlationId?: string;
	readonly compiledAt?: Date;
}

/**
 * A compiled query result with plan, SQL, and parameters
 * Used for observability and debugging
 * @public
 */
export interface CompiledQuery {
	readonly sql: string;
	readonly params: readonly unknown[];
}

/**
 * Base compile options shared across all adapters.
 * Adapters can extend this with adapter-specific options.
 * @public
 */
export interface CompileOptionsBase {
	/** Schema name for schema-scoped/multi-tenant queries */
	readonly schemaName?: string;

	/** Query name for logging */
	readonly queryName?: string;

	/** Correlation ID for distributed tracing */
	readonly correlationId?: string;
}
