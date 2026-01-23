/**
 * Adapter interface for database adapters.
 *
 * This module defines the contract that all database adapters must implement.
 * DX-104: Split into focused interfaces for ISP compliance.
 *
 * @module adapter
 */

import type {
	DeleteIntent,
	InsertIntent,
	SelectIntent,
	UpdateIntent,
	UpsertIntent,
	WhereIntent,
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
 * Alias mode for included relation columns.
 *
 * - `'always'` (default): Alias all columns from included tables (e.g., `"author.id"`, `"author.name"`)
 * - `'onCollision'`: Only alias columns that exist in multiple tables (e.g., `id`, `createdAt`)
 *
 * Note: `'never'` is intentionally excluded as it would cause data loss from duplicate column names.
 */
export type AliasIncludedColumnsMode = 'always' | 'onCollision';

/**
 * Options for query compilation.
 */
export interface CompileOptions {
	/** Schema name for multi-tenant queries */
	readonly schemaName?: string;
	/** Model IR for relation lookups during compilation */
	readonly model?: ModelIR;
	/**
	 * Alias mode for included relation columns.
	 * @default 'always'
	 */
	readonly aliasIncludedColumns?: AliasIncludedColumnsMode;
}

// ============================================================================
// Include Hydration (DX-033)
// ============================================================================

/**
 * Metadata for a separate include query.
 \* Used when planner decides include-strategy: 'separate' for hasMany/manyToMany relations.
 */
export interface SeparateIncludeInfo {
	/** Name of the relation being included */
	readonly relationName: string;
	/** Target table to fetch from */
	readonly targetTable: string;
	/** Foreign key column(s) in target table */
	readonly foreignKey: string | readonly string[];
	/** Source key column(s) in parent table */
	readonly sourceKey: string | readonly string[];
	/** Optional select clause from include intent */
	readonly select?: SelectIntent;
	/** Optional where clause from include intent */
	readonly where?: WhereIntent;
	/** Optional nested includes (for recursive hydration) */
	readonly nestedIncludes?: readonly SeparateIncludeInfo[];

	// --- M:N (manyToMany) support ---
	/** Junction table for M:N relations (e.g., 'postTags') */
	readonly through?: string;
	/** FK in junction table pointing to source (e.g., 'postId') */
	readonly throughSourceKey?: string;
	/** FK in junction table pointing to target (e.g., 'tagId') */
	readonly throughTargetKey?: string;
}

/**
 * Result of compiling a query with separate includes.
 */
export interface CompileResultWithIncludes<T = unknown> {
	/** The main query (includes any JOIN includes) */
	readonly main: CompiledQuery<T>;
	/** Metadata for separate include queries (empty if all includes use JOIN) */
	readonly separateIncludes: readonly SeparateIncludeInfo[];
}

// ============================================================================
// Dump (Observability)
// ============================================================================

/**
 * Metadata for a query dump.
 */
export interface DumpMeta {
	readonly schema?: string;
	readonly queryName?: string;
	readonly correlationId?: string;
	readonly compiledAt?: Date;
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
// Split Adapter Interfaces (DX-104: ISP Compliance)
// ============================================================================

/**
 * Base adapter interface - core capabilities all adapters must have.
 */
export interface BaseAdapter {
	/** Adapter capabilities for feature detection */
	readonly capabilities: AdapterCapabilities;

	/**
	 * Validate an identifier (table name, column name, schema name).
	 * Throws if the identifier contains unsafe characters.
	 */
	validateIdentifier(value: string, type: string): void;
}

/**
 * Compiling adapter - can compile plans to SQL queries.
 */
export interface CompilingAdapter extends BaseAdapter {
	/** Compile a plan to executable SQL. */
	compile<T = unknown>(
		plan: PlanReport,
		options?: CompileOptions,
	): CompiledQuery<T>;

	/** Compile a plan with includes, returning separate include metadata (DX-033). */
	compileWithIncludes<T = unknown>(
		plan: PlanReport,
		options?: CompileOptions,
	): CompileResultWithIncludes<T>;

	/** Compile a separate include query for given parent IDs (DX-033). */
	compileSeparateInclude(
		info: SeparateIncludeInfo,
		parentIds: readonly unknown[],
		options?: CompileOptions,
	): CompiledQuery;

	/** Compile an insert intent to executable SQL. */
	compileInsert(intent: InsertIntent, options?: CompileOptions): CompiledQuery;

	/** Compile an update intent to executable SQL. */
	compileUpdate(intent: UpdateIntent, options?: CompileOptions): CompiledQuery;

	/** Compile a delete intent to executable SQL. */
	compileDelete(intent: DeleteIntent, options?: CompileOptions): CompiledQuery;

	/** Compile an upsert intent to executable SQL (DX-026). */
	compileUpsert(intent: UpsertIntent, options?: CompileOptions): CompiledQuery;

	/** Compile a recursive CTE plan to executable SQL. */
	compileRecursive(
		report: RecursivePlanReport,
		model: ModelIR,
		options?: CompileOptions,
	): CompiledQuery;

	/** Create a dump for observability. */
	createDump(plan: PlanReport, query: CompiledQuery, meta?: DumpMeta): Dump;
}

/**
 * Executing adapter - can execute compiled queries.
 */
export interface ExecutingAdapter extends BaseAdapter {
	/** Execute a query and return all results. */
	execute<T>(query: CompiledQuery<T>): Promise<T[]>;

	/** Execute a query and return the first result or null. */
	executeOne<T>(query: CompiledQuery<T>): Promise<T | null>;

	/** Execute a query and return the first result or throw. */
	executeOneOrThrow<T>(query: CompiledQuery<T>): Promise<T>;
}

/**
 * Streaming adapter - can stream query results.
 */
export interface StreamingAdapter extends BaseAdapter {
	/** Stream query results as an async iterable iterator. */
	stream<T>(
		query: CompiledQuery<T>,
		options?: AdapterStreamOptions,
	): AsyncIterableIterator<T>;
}

/**
 * Introspecting adapter - can introspect database schema.
 */
export interface IntrospectingAdapter extends BaseAdapter {
	/** Introspect the database schema and return a ModelIR. */
	introspect(): Promise<ModelIR>;
}

/**
 * Transactional adapter - supports database transactions.
 */
export interface TransactionalAdapter<DB = unknown> extends BaseAdapter {
	/** Execute a callback within a database transaction. */
	transaction<T>(fn: (adapter: Adapter<DB>) => Promise<T>): Promise<T>;

	/** Create a schema-scoped adapter for multi-tenant queries. */
	withSchema(schemaName: string): Adapter<DB>;
}

/**
 * Raw SQL adapter - can execute raw SQL directly.
 *
 * @warning **SECURITY RISK: POTENTIAL SQL INJECTION**
 * Use parameter placeholders ($1, $2, etc.) for ALL values.
 */
export interface RawSqlAdapter extends BaseAdapter {
	/**
	 * Execute raw SQL directly - the ultimate escape hatch.
	 *
	 * @param sql - Raw SQL string with parameter placeholders
	 * @param parameters - Parameter values (safely bound by driver)
	 */
	executeRaw<T = unknown>(
		sql: string,
		parameters?: readonly unknown[],
	): Promise<T[]>;
}

/**
 * DDL-generating adapter - can generate DDL (CREATE TABLE statements) from a schema.
 *
 * This enables programmatic DDL generation through the underlying adapter's
 * schema builder, ensuring column naming transformations (e.g., camelCase to snake_case)
 * are applied consistently between DDL and queries.
 */
export interface DDLGeneratingAdapter extends BaseAdapter {
	/**
	 * Generate DDL statements from a schema.
	 *
	 * @param schema - The ModelIR schema to generate DDL from
	 * @returns Array of DDL statements (CREATE TABLE, CREATE INDEX, etc.)
	 */
	generateDDL(schema: ModelIR): string[];
}

// ============================================================================
// Convenience Composed Types (DX-104)
// ============================================================================

/**
 * Compile-only adapter - can only compile, not execute.
 * Useful for generating SQL without a database connection.
 */
export type CompileOnlyAdapter = CompilingAdapter;

/**
 * Basic adapter - compile + execute, no streaming/transactions/introspection.
 * Minimum viable adapter for most use cases.
 */
export type BasicAdapter = CompilingAdapter & ExecutingAdapter;

// ============================================================================
// Full Adapter Interface
// ============================================================================

/**
 * Database adapter interface - full adapter with all capabilities.
 *
 * This is the intersection of all split interfaces. Implementations
 * can choose to implement only the interfaces they need.
 *
 * @typeParam DB - Database schema type for type inference
 */
export interface Adapter<DB = unknown>
	extends CompilingAdapter,
		ExecutingAdapter,
		StreamingAdapter,
		IntrospectingAdapter,
		TransactionalAdapter<DB>,
		RawSqlAdapter,
		DDLGeneratingAdapter {}

// ============================================================================
// Feature Detection Helpers (DX-104)
// ============================================================================

/**
 * Check if adapter supports execution.
 */
export function supportsExecution(
	adapter: BaseAdapter,
): adapter is ExecutingAdapter {
	return (
		'execute' in adapter &&
		'executeOne' in adapter &&
		typeof (adapter as ExecutingAdapter).execute === 'function'
	);
}

/**
 * Check if adapter supports streaming.
 */
export function supportsStreaming(
	adapter: BaseAdapter,
): adapter is StreamingAdapter {
	return (
		'stream' in adapter &&
		typeof (adapter as StreamingAdapter).stream === 'function'
	);
}

/**
 * Check if adapter supports introspection.
 */
export function supportsIntrospection(
	adapter: BaseAdapter,
): adapter is IntrospectingAdapter {
	return (
		'introspect' in adapter &&
		typeof (adapter as IntrospectingAdapter).introspect === 'function'
	);
}

/**
 * Check if adapter supports transactions.
 */
export function supportsTransactions<DB>(
	adapter: BaseAdapter,
): adapter is TransactionalAdapter<DB> {
	return (
		'transaction' in adapter &&
		'withSchema' in adapter &&
		typeof (adapter as TransactionalAdapter<DB>).transaction === 'function'
	);
}

/**
 * Check if adapter supports raw SQL execution.
 */
export function supportsRawSql(adapter: BaseAdapter): adapter is RawSqlAdapter {
	return (
		'executeRaw' in adapter &&
		typeof (adapter as RawSqlAdapter).executeRaw === 'function'
	);
}

/**
 * Check if adapter supports DDL generation.
 */
export function supportsDDLGeneration(
	adapter: BaseAdapter,
): adapter is DDLGeneratingAdapter {
	return (
		'generateDDL' in adapter &&
		typeof (adapter as DDLGeneratingAdapter).generateDDL === 'function'
	);
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
