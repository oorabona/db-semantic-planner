/**
 * Adapter interface for database adapters.
 *
 * This module defines the contract that all database adapters must implement.
 * Adapters handle compilation, execution, transactions, and streaming.
 *
 * @module adapter
 */

import type {
	DeleteIntent,
	InsertIntent,
	UpdateIntent,
	UpsertIntent,
} from './intent-ast.js';
import type { ModelIR } from './model-ir.js';
import type { PlanReport, RecursivePlanReport } from './planner.js';

// ============================================================================
// Capabilities
// ============================================================================

/**
 * Adapter capabilities - what the underlying database/ORM supports.
 * Used for feature detection and graceful degradation.
 */
export interface AdapterCapabilities {
	readonly supportsReturning: boolean;
	readonly supportsSchemas: boolean;
	readonly supportsStreaming: boolean;
	readonly supportsRecursiveCTE: boolean;
	readonly supportsWindowFunctions: boolean;
	readonly supportsArrayType: boolean;
}

// ============================================================================
// Compiled Query
// ============================================================================

/**
 * A compiled query ready for execution.
 *
 * @typeParam T - The expected result type (phantom type for inference)
 */
export interface CompiledQuery<T = unknown> {
	readonly sql: string;
	readonly parameters: readonly unknown[];
	/** Phantom type for result inference - not used at runtime */
	readonly __resultType?: T;
}

// ============================================================================
// Options
// ============================================================================

/**
 * Options for streaming query results.
 */
export interface AdapterStreamOptions {
	/** Number of rows to fetch per chunk */
	readonly chunkSize?: number;
}

/**
 * Options for query compilation.
 */
export interface CompileOptions {
	/** Schema name for multi-tenant queries */
	readonly schemaName?: string;
	/** Model IR for relation lookups during compilation */
	readonly model?: ModelIR;
}

// ============================================================================
// Dump (Observability)
// ============================================================================

/**
 * Metadata for a query dump.
 */
export interface DumpMeta {
	readonly tenant?: string;
	readonly queryName?: string;
	readonly correlationId?: string;
}

/**
 * A dump contains the plan, compiled SQL, and parameters for observability.
 */
export interface Dump {
	readonly plan: PlanReport;
	readonly sql: string;
	readonly params: readonly unknown[];
	readonly meta?: DumpMeta;
}

// ============================================================================
// Adapter Interface
// ============================================================================

/**
 * Database adapter interface.
 *
 * Implementations handle the database-specific compilation and execution.
 * Each ORM (Kysely, Drizzle, Prisma) has its own adapter implementation.
 *
 * @typeParam DB - Database schema type for type inference
 *
 * @example
 * ```typescript
 * import { createKyselyAdapter } from '@db-semantic-planner/adapter-kysely';
 *
 * const adapter = createKyselyAdapter(kyselyDb);
 * const orm = createOrm({ model, adapter });
 * ```
 */
export interface Adapter<DB = unknown> {
	/** Adapter capabilities for feature detection */
	readonly capabilities: AdapterCapabilities;

	/**
	 * Compile a plan to executable SQL.
	 *
	 * @param plan - The plan report from the semantic planner
	 * @param options - Compilation options
	 * @returns Compiled query with SQL and parameters
	 */
	compile<T = unknown>(
		plan: PlanReport,
		options?: CompileOptions,
	): CompiledQuery<T>;

	/**
	 * Execute a query and return all results.
	 *
	 * @param query - The compiled query to execute
	 * @returns Promise resolving to array of results
	 */
	execute<T>(query: CompiledQuery<T>): Promise<T[]>;

	/**
	 * Execute a query and return the first result or null.
	 *
	 * @param query - The compiled query to execute
	 * @returns Promise resolving to first result or null
	 */
	executeOne<T>(query: CompiledQuery<T>): Promise<T | null>;

	/**
	 * Execute a query and return the first result or throw.
	 *
	 * @param query - The compiled query to execute
	 * @returns Promise resolving to first result
	 * @throws NotFoundError if no results
	 */
	executeOneOrThrow<T>(query: CompiledQuery<T>): Promise<T>;

	/**
	 * Stream query results as an async iterable iterator.
	 *
	 * @param query - The compiled query to execute
	 * @param options - Stream options (chunk size, etc.)
	 * @returns Async iterable iterator of results
	 */
	stream<T>(
		query: CompiledQuery<T>,
		options?: AdapterStreamOptions,
	): AsyncIterableIterator<T>;

	/**
	 * Execute a callback within a database transaction.
	 * Auto-commits on success, auto-rolls back on exception.
	 *
	 * @param fn - Callback receiving a transaction-scoped adapter
	 * @returns Promise resolving to callback's return value
	 */
	transaction<T>(fn: (adapter: Adapter<DB>) => Promise<T>): Promise<T>;

	/**
	 * Create a schema-scoped adapter for multi-tenant queries.
	 *
	 * @param schemaName - The schema name to scope queries to
	 * @returns A new adapter scoped to the schema
	 */
	withSchema(schemaName: string): Adapter<DB>;

	/**
	 * Create a dump for observability.
	 *
	 * @param plan - The plan report
	 * @param query - The compiled query
	 * @param meta - Optional metadata
	 * @returns Dump object with plan, SQL, and parameters
	 */
	createDump(plan: PlanReport, query: CompiledQuery, meta?: DumpMeta): Dump;

	// =========================================================================
	// Mutation Compilation
	// =========================================================================

	/**
	 * Compile an insert intent to executable SQL.
	 *
	 * @param intent - The insert intent
	 * @param options - Compilation options
	 * @returns Compiled query with SQL and parameters
	 */
	compileInsert(intent: InsertIntent, options?: CompileOptions): CompiledQuery;

	/**
	 * Compile an update intent to executable SQL.
	 *
	 * @param intent - The update intent
	 * @param options - Compilation options
	 * @returns Compiled query with SQL and parameters
	 */
	compileUpdate(intent: UpdateIntent, options?: CompileOptions): CompiledQuery;

	/**
	 * Compile a delete intent to executable SQL.
	 *
	 * @param intent - The delete intent
	 * @param options - Compilation options
	 * @returns Compiled query with SQL and parameters
	 */
	compileDelete(intent: DeleteIntent, options?: CompileOptions): CompiledQuery;

	/**
	 * Compile an upsert intent to executable SQL (DX-026).
	 * Implements INSERT ... ON CONFLICT ... DO UPDATE/NOTHING pattern.
	 *
	 * @param intent - The upsert intent
	 * @param options - Compilation options
	 * @returns Compiled query with SQL and parameters
	 */
	compileUpsert(intent: UpsertIntent, options?: CompileOptions): CompiledQuery;

	// =========================================================================
	// Recursive CTE Compilation
	// =========================================================================

	/**
	 * Compile a recursive CTE plan to executable SQL.
	 *
	 * @param report - The recursive plan report
	 * @param model - The model IR for relation resolution
	 * @param options - Compilation options
	 * @returns Compiled query with SQL and parameters
	 */
	compileRecursive(
		report: RecursivePlanReport,
		model: ModelIR,
		options?: CompileOptions,
	): CompiledQuery;

	// =========================================================================
	// Introspection
	// =========================================================================

	/**
	 * Introspect the database schema and return a ModelIR.
	 * Used for auto-discovery when no explicit model is provided.
	 *
	 * @returns Promise resolving to the introspected model
	 */
	introspect(): Promise<ModelIR>;

	// =========================================================================
	// Validation Utilities
	// =========================================================================

	/**
	 * Validate an identifier (table name, column name, schema name).
	 * Throws if the identifier contains unsafe characters.
	 *
	 * @param value - The identifier value to validate
	 * @param type - The type of identifier (for error messages)
	 * @throws Error if identifier is invalid
	 */
	validateIdentifier(value: string, type: string): void;

	// =========================================================================
	// Raw SQL Execution (DX-027)
	// =========================================================================

	/**
	 * Execute raw SQL directly.
	 * This is the ultimate escape hatch for queries that cannot be
	 * expressed via the intent system.
	 *
	 * ⚠️  WARNING: This bypasses the planner and all type safety.
	 * The SQL string is NOT validated - ensure it's safe!
	 * Parameters should use placeholders ($1, $2, etc.) to prevent injection.
	 *
	 * @param sql - Raw SQL string with parameter placeholders
	 * @param parameters - Parameter values for placeholders
	 * @returns Promise resolving to array of results
	 *
	 * @example
	 * ```typescript
	 * // Simple query
	 * const results = await adapter.executeRaw<User>(
	 *   'SELECT * FROM users WHERE age > $1',
	 *   [18]
	 * );
	 *
	 * // Complex query not expressible via intents
	 * const stats = await adapter.executeRaw<Stats>(
	 *   `SELECT date_trunc('month', created_at) as month,
	 *           COUNT(*) as count
	 *    FROM orders
	 *    GROUP BY 1
	 *    ORDER BY 1 DESC`,
	 *   []
	 * );
	 * ```
	 */
	executeRaw<T = unknown>(
		sql: string,
		parameters?: readonly unknown[],
	): Promise<T[]>;
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Error thrown when an operation requires an adapter but none was provided.
 */
export class AdapterRequiredError extends Error {
	constructor(operation: string) {
		super(
			`Operation '${operation}' requires an adapter. ` +
				'Pass an adapter when creating the ORM: createOrm({ model, adapter })',
		);
		this.name = 'AdapterRequiredError';
	}
}

/**
 * Error thrown when an operation requires a capability the adapter doesn't support.
 */
export class UnsupportedCapabilityError extends Error {
	constructor(operation: string, capability: keyof AdapterCapabilities) {
		super(
			`Operation '${operation}' requires capability '${capability}' ` +
				'which is not supported by the current adapter.',
		);
		this.name = 'UnsupportedCapabilityError';
	}
}

/**
 * Assert that an adapter supports a required capability.
 *
 * @param adapter - The adapter to check
 * @param capability - The required capability
 * @param operation - The operation name (for error message)
 * @throws UnsupportedCapabilityError if capability is not supported
 */
export function assertCapability(
	adapter: Adapter,
	capability: keyof AdapterCapabilities,
	operation: string,
): void {
	if (!adapter.capabilities[capability]) {
		throw new UnsupportedCapabilityError(operation, capability);
	}
}
