/**
 * @module adapter
 * Adapter interface type definitions.
 *
 * Runtime functions (assertCapability, supportsExecution, etc.) and
 * error classes (AdapterRequiredError, UnsupportedCapabilityError)
 * remain in @dbsp/core.
 */

import type { DialectCapabilities } from './dialects.js';
import type {
	BatchUpdateIntent,
	CteQueryIntent,
	DeleteIntent,
	ExpressionIntent,
	InsertFromIntent,
	InsertIntent,
	MutationIntent,
	QueryIntent,
	SelectIntent,
	SetOperationIntent,
	UpdateIntent,
	UpsertFromIntent,
	UpsertIntent,
	WhereIntent,
} from './intent-ast.js';
import type {
	CheckConstraintIR,
	ColumnIR,
	ColumnJsReadType,
	ColumnType,
	EnumIR,
	ForeignKeyIR,
	HierarchyIR,
	IndexIR,
	ModelIR,
	NqlBindingRelationType,
	PartitionIR,
	SequenceIR,
	TableIR,
} from './model-ir.js';
import type { OutputDescriptor } from './output-provenance.js';
import type { PlanReport, RecursivePlanReport } from './planner.js';

// ============================================================================
// Logger
// ============================================================================

/**
 * Minimal logger interface for adapter debug/error logging.
 * Adapters accept an optional logger for observability without
 * coupling to any specific logging framework.
 */
export interface AdapterLogger {
	debug?(message: string, ...args: unknown[]): void;
	warn?(message: string, ...args: unknown[]): void;
	error?(message: string, ...args: unknown[]): void;
}

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
	readonly supportsTransactions: boolean;
	readonly supportsRecursiveCTE: boolean;
	readonly supportsWindowFunctions: boolean;
	readonly supportsArrayType: boolean;
}

// ============================================================================
// Compiled Query
// ============================================================================

export interface CompiledColumnMetadata {
	readonly table: string;
	readonly column: string;
	readonly js: ColumnJsReadType;
}

/**
 * A compiled query ready for execution.
 *
 * @typeParam T - The expected result type (phantom type for inference)
 */
export interface CompiledQuery<T = unknown> {
	readonly sql: string;
	readonly parameters: readonly unknown[];
	readonly columnMetadata?: ReadonlyMap<string, CompiledColumnMetadata>;
	/** Phantom type for result inference - not used at runtime */
	readonly __resultType?: T;
}

// ============================================================================
// Options
// ============================================================================

/**
 * Base compile options shared across all adapters.
 * Adapters can extend this with adapter-specific options.
 */
export interface CompileOptionsBase {
	/** Schema name for schema-scoped/multi-tenant queries */
	readonly schemaName?: string;

	/**
	 * Dialect capabilities for adapter-layer SQL surface gates.
	 * When absent, adapters preserve historical behavior and assume supported.
	 */
	readonly dialectCapabilities?: DialectCapabilities;

	/** Query name for logging */
	readonly queryName?: string;

	/** Correlation ID for distributed tracing */
	readonly correlationId?: string;

	/**
	 * Row count threshold for switching INSERT compilation from VALUES to unnest strategy.
	 * Rows <= threshold use VALUES ($1,$2),... Rows > threshold use SELECT unnest($1::type[]),...
	 * Set to 0 to force unnest for all batch sizes.
	 * @default 50
	 */
	readonly batchThreshold?: number;

	/**
	 * Maximum allowed batch size for INSERT operations.
	 * If set and the number of rows exceeds this limit, an InvalidOperationError is thrown.
	 * Useful to prevent accidental unbounded inserts.
	 * @default undefined (no limit)
	 */
	readonly maxBatchSize?: number;
}

/**
 * Adapter-facing NQL compile bundle.
 */
export interface NqlBindingVirtualRelationHop {
	readonly target: string;
	readonly fkColumn: readonly string[];
	readonly joinColumn: readonly string[];
}

export interface NqlBindingVirtualRelationRecursive {
	readonly direction: 'up' | 'down';
	readonly maxDepth: number;
	readonly selfRefColumn: string;
	readonly targetKeyColumn: string;
}

export interface NqlBindingVirtualRelation {
	readonly relation: string;
	readonly sourceTable: string;
	readonly targetTable: string;
	readonly sourceColumn: readonly string[];
	readonly targetColumn: readonly string[];
	readonly hops: readonly NqlBindingVirtualRelationHop[];
	readonly through?: string;
	readonly throughSourceColumn?: string;
	readonly throughTargetColumn?: string;
	readonly cardinality?: 'one' | 'many';
	readonly relationType?: NqlBindingRelationType;
	readonly recursive?: NqlBindingVirtualRelationRecursive;
}

export interface NqlBindingColumnLineage {
	readonly kind: 'directProjection';
	readonly sourceTable: string;
	readonly sourceColumn: string;
	readonly outputColumn: string;
}

export interface NqlBindingRelationFilterMetadata {
	readonly sourceTable?: string;
	readonly unsafeReason?: string;
	readonly directProjectionLineage?: readonly NqlBindingColumnLineage[];
	readonly relations: readonly NqlBindingVirtualRelation[];
	readonly scalarRelations?: readonly NqlBindingVirtualRelation[];
}

/**
 * Neutral per-column type info for a binding's output schema.
 * ARCH-001: dialect-neutral — the adapter maps `type`/`fn` to a PG type name.
 */
export type NqlBindingColumnTypeInfo =
	| {
			readonly kind: 'column';
			readonly type: ColumnType;
			readonly originalDbType?: string;
			readonly originalDbTypeSchema?: string;
			readonly originalDbTypeSchemaScope?: 'target' | 'absolute';
	  }
	| { readonly kind: 'aggregate'; readonly fn: 'count' };

/** Reason a binding output column's type could not be statically resolved. */
export type NqlBindingColumnUntypeableReason =
	| 'computed-expression'
	| 'unsupported-aggregate'
	| 'unresolvable-source'
	| 'duplicate-output-name'
	| 'aliased-returning'
	| 'relation-column';

export interface NqlBindingOutputSchema {
	readonly columns: readonly string[];
	/**
	 * Neutral output descriptors declared by the compiler for runtime/materialized
	 * binding rows. Only scalar model-column descriptors are eligible for scalar
	 * read conversion; unresolved/non-scalar descriptors are intentionally
	 * metadata-free.
	 */
	readonly declaredOutputs?: readonly OutputDescriptor[];
	readonly relationFilters?: NqlBindingRelationFilterMetadata;
	/**
	 * Present when EVERY projected column's type is statically resolvable
	 * (completeness invariant — complete or absent, never partial). Keyed by
	 * output column name (post-alias). Deep-frozen at build.
	 */
	readonly columnTypes?: Readonly<Record<string, NqlBindingColumnTypeInfo>>;
	/**
	 * Present ONLY when `columnTypes` is absent: names the first untypeable
	 * output column and why. Computed once at schema build — consumers
	 * (the snapshot gate) must never re-derive it.
	 */
	readonly columnTypesUnavailable?: {
		readonly column: string;
		readonly reason: NqlBindingColumnUntypeableReason;
	};
}

export interface NqlRuntimeBinding {
	readonly columns: readonly string[];
	readonly rows: readonly Readonly<Record<string, unknown>>[];
	readonly declaredOutputs?: readonly OutputDescriptor[];
	/** Per-column type info carried from the binding's output schema (absent → fall back to model-walk anchor resolution). */
	readonly columnTypes?: Readonly<Record<string, NqlBindingColumnTypeInfo>>;
}

export type NqlProgramSequenceStep =
	| {
			readonly kind: 'query';
			readonly query: QueryIntent;
			readonly bindName?: string;
			readonly final: boolean;
			readonly snapshot?: true;
	  }
	| {
			readonly kind: 'mutation';
			readonly mutation: MutationIntent;
			readonly bindName?: string;
			readonly final: boolean;
	  };

export interface CompiledNqlQuery {
	readonly query?: QueryIntent;
	/** Optional prebuilt plan for the final query leaf. Used when NQL binding-final queries need synthetic planner decisions. */
	readonly plan?: PlanReport;
	/** CTE query (WITH clause): wraps outer QueryIntent in CteQueryIntent */
	readonly cteQuery?: CteQueryIntent;
	readonly mutation?: MutationIntent;
	readonly returning?: readonly string[];
	/** Named bindings from `| bind X` clauses (CTE source queries) */
	readonly bindings?: ReadonlyMap<string, QueryIntent>;
	/** Output column schemas for named NQL bindings. Required for direct bundle validation. */
	readonly bindingOutputSchemas?: ReadonlyMap<string, NqlBindingOutputSchema>;
	/** Named mutation bindings from `mutation | select cols | bind X` clauses. */
	readonly mutationBindings?: ReadonlyMap<string, MutationIntent>;
	/** Runtime row bindings materialized as typed CTEs by the adapter. */
	readonly runtimeBindings?: ReadonlyMap<string, NqlRuntimeBinding>;
	/** Source-ordered NQL statements for multi-statement program execution. */
	readonly nqlProgramSequence?: readonly NqlProgramSequenceStep[];
	/** Set operation (UNION/INTERSECT/EXCEPT) wrapping two queries */
	readonly setOperation?: SetOperationIntent;
}

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
 * Describes the casing convention used for column names in the database.
 * This is the intuitive "what does your DB look like?" type:
 *
 * - `'snake_case'`: DB columns use snake_case → adapter transforms to camelCase for JS
 * - `'camelCase'`: DB columns use camelCase → no transformation needed
 * - `'preserve'`: No transformation applied
 */
export type DbCasing = 'snake_case' | 'camelCase' | 'preserve';

/**
 * Options for query compilation.
 * Extends CompileOptionsBase with core-specific options.
 */
export interface CompileOptions extends CompileOptionsBase {
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
 * Metadata for a subquery include query.
 * Used when planner decides include-strategy: 'subquery' for hasMany/manyToMany relations.
 */
export interface SubqueryIncludeInfo {
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
	readonly nestedIncludes?: readonly SubqueryIncludeInfo[];

	// --- M:N (manyToMany) support ---
	/** Junction table for M:N relations (e.g., 'postTags') */
	readonly through?: string;
	/** FK in junction table pointing to source (e.g., 'postId') */
	readonly throughSourceKey?: string;
	/** FK in junction table pointing to target (e.g., 'tagId') */
	readonly throughTargetKey?: string;

	// --- Relation metadata ---
	/** Relation type for to-one unwrapping (belongsTo/hasOne → single object) */
	readonly relationType?: string;

	// --- Subquery optimization (NQL-ALIGN Block 5) ---
	/** Source/parent table name for subquery optimization */
	readonly sourceTable?: string;
	/** Parent query's WHERE conditions for subquery optimization */
	readonly parentWhere?: WhereIntent;
}

/**
 * Result of compiling a query with subquery includes.
 */
export interface CompileResultWithIncludes<T = unknown> {
	/** The main query (includes any JOIN includes) */
	readonly main: CompiledQuery<T>;
	/** Metadata for subquery include queries (empty if all includes use JOIN) */
	readonly subqueryIncludes: readonly SubqueryIncludeInfo[];
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
export interface DumpSequenceStep {
	readonly sql: string;
	readonly params: readonly unknown[];
	readonly bindName?: string;
	readonly kind?: 'query' | 'mutation';
}

export interface Dump {
	readonly plan?: PlanReport | undefined;
	readonly sql: string;
	readonly params: readonly unknown[];
	readonly meta?: DumpMeta;
	readonly sequence?: readonly DumpSequenceStep[];
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
	 * Whether this adapter instance is scoped inside a transaction.
	 * Compile-only adapters and adapters without an active transaction report false.
	 */
	readonly inTransaction: boolean;

	/**
	 * Dialect capabilities for planner strategy selection.
	 * Determines which SQL features the adapter's database supports
	 * (LATERAL JOIN, json_agg, window functions, etc.).
	 */
	readonly dialectCapabilities: DialectCapabilities;

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
		plan: PlanReport | CompiledNqlQuery,
		options?: CompileOptions,
	): CompiledQuery<T>;

	/** Compile a plan with includes, returning subquery include metadata (DX-033). */
	compileWithIncludes<T = unknown>(
		plan: PlanReport,
		options?: CompileOptions,
	): CompileResultWithIncludes<T>;

	/** Compile a subquery include query for given parent IDs (DX-033). */
	compileSubqueryInclude(
		info: SubqueryIncludeInfo,
		parentIds: readonly unknown[],
		options?: CompileOptions,
	): CompiledQuery;

	/** Compile an insert intent to executable SQL. */
	compileInsert(intent: InsertIntent, options?: CompileOptions): CompiledQuery;

	/** Compile an insert-from intent to executable SQL (NQL-ALIGN). */
	compileInsertFrom(
		intent: InsertFromIntent,
		options?: CompileOptions,
	): CompiledQuery;

	/** Compile an update intent to executable SQL. */
	compileUpdate(intent: UpdateIntent, options?: CompileOptions): CompiledQuery;

	/** Compile a batch update intent to executable SQL (BATCH-001). */
	compileBatchUpdate(
		intent: BatchUpdateIntent,
		options?: CompileOptions,
	): CompiledQuery;

	/** Compile a delete intent to executable SQL. */
	compileDelete(intent: DeleteIntent, options?: CompileOptions): CompiledQuery;

	/** Compile an upsert intent to executable SQL (DX-026). */
	compileUpsert(intent: UpsertIntent, options?: CompileOptions): CompiledQuery;

	/** Compile an upsert-from intent to executable SQL (NQL-BIND). */
	compileUpsertFrom(
		intent: UpsertFromIntent,
		options?: CompileOptions,
	): CompiledQuery;

	/** Compile a recursive CTE plan to executable SQL. */
	compileRecursive(
		report: RecursivePlanReport,
		model: ModelIR,
		options?: CompileOptions,
	): CompiledQuery;

	/** Compile a CTE query backed by unnest() arrays (BATCH-001). */
	compileCteQuery(
		intent: CteQueryIntent,
		options?: CompileOptions,
	): CompiledQuery;

	/** Compile a set operation (UNION / INTERSECT / EXCEPT) to SQL. */
	compileSetOperation(
		intent: SetOperationIntent,
		model: ModelIR,
		options?: CompileOptions,
	): CompiledQuery;

	/** Compile a FROM-less SELECT expression to SQL (e.g. SELECT nextval('seq')). */
	compileSelectExpression(expr: ExpressionIntent): CompiledQuery;

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
 * Options for database introspection.
 */
export interface IntrospectionOptions {
	/** Schema name to introspect (default: 'public' for PostgreSQL) */
	readonly schema?: string;
	/** Tables to include (default: all). Applied before exclude. */
	readonly include?: readonly string[];
	/** Tables to exclude (glob patterns: * matches any chars) */
	readonly exclude?: readonly string[];
}

/**
 * Result of database introspection.
 * Extends ModelIR with introspection-specific metadata.
 */
export interface IntrospectionResult extends ModelIR {
	/** Timestamp when introspection was performed */
	readonly introspectedAt: Date;
	/** Warnings from introspection (e.g., unsupported types) */
	readonly warnings?: readonly string[];
	/** Hierarchy patterns detected during introspection (adjacency-list / edge-table) */
	readonly hierarchies?: readonly HierarchyIR[];
}

/**
 * A database-neutral schema change reported by a live schema comparison.
 */
export interface SchemaChange {
	readonly kind: string;
	readonly table: string;
	readonly column?: string;
	readonly destructive: boolean;
	readonly details: string;
	readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * Aggregate counts for a schema diff.
 */
export interface DiffSummary {
	readonly tables: { readonly added: number; readonly dropped: number };
	readonly columns: {
		readonly added: number;
		readonly dropped: number;
		readonly altered: number;
	};
	readonly indexes: { readonly added: number; readonly dropped: number };
	readonly constraints: {
		readonly added: number;
		readonly dropped: number;
		readonly altered: number;
	};
}

/**
 * Database-neutral schema diff returned by live schema comparison.
 */
export interface SchemaDiff {
	readonly changes: readonly SchemaChange[];
	readonly hasDestructive: boolean;
	readonly summary: DiffSummary;
}

/**
 * Introspecting adapter - can introspect database schema.
 */
export interface IntrospectingAdapter extends BaseAdapter {
	/** Database column casing convention */
	readonly dbCasing?: DbCasing;
	/** Introspect the database schema and return a ModelIR. */
	introspect(options?: IntrospectionOptions): Promise<IntrospectionResult>;
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

// ============================================================================
// Table DDL Operation Types (DDL-TABLE-001)
// Defined here so adapter.ts can reference them without importing from @dbsp/core.
// ============================================================================

/**
 * PostgreSQL index access method.
 */
export type IndexMethod =
	| 'btree'
	| 'hash'
	| 'gist'
	| 'gin'
	| 'brin'
	| 'hnsw'
	| 'ivfflat'
	| 'bm25';

/** A column reference in an index: either a column name or an expression. */
export type IndexColumnDef =
	| string
	| {
			expression: string;
			opclass?: string;
	  };

/** Options for CREATE INDEX. */
export type CreateIndexOptions = {
	readonly name: string;
	readonly columns: readonly IndexColumnDef[];
	readonly method?: IndexMethod;
	readonly opclass?: Readonly<Record<string, string>>;
	readonly include?: readonly string[];
	readonly with?: Readonly<Record<string, unknown>>;
	readonly where?: string;
	readonly unique?: boolean;
	/** PG15+ — valid only on UNIQUE indexes; declaring it on a non-unique index is a fail-loud error. */
	readonly nullsNotDistinct?: boolean;
	readonly ifNotExists?: boolean;
	readonly concurrently?: boolean;
};

/** Options for DROP INDEX. */
export type DropIndexOptions = {
	readonly ifExists?: boolean;
	readonly cascade?: boolean;
	readonly concurrently?: boolean;
	readonly schema?: string;
};

/** Options for VACUUM. */
export type VacuumOptions = {
	readonly full?: boolean;
	readonly analyze?: boolean;
};

/** Options for TRUNCATE. */
export type TruncateOptions = {
	readonly cascade?: boolean;
	readonly restartIdentity?: boolean;
};

/** Options for ALTER COLUMN. */
export type AlterColumnOptions = {
	readonly type?: string;
	readonly using?: string;
	readonly setNotNull?: boolean;
	readonly setDefault?: unknown;
	readonly dropDefault?: boolean;
};

/** Index metadata returned by listIndexes(). */
export type IndexInfo = {
	readonly name: string;
	readonly definition: string;
	readonly unique: boolean;
	readonly method: string;
};

// ============================================================================
// Table DDL Generator Adapter (DDL-TABLE-001)
// ============================================================================

/**
 * Mixin for adapters that can generate table-scoped DDL SQL strings.
 * When present on an adapter, buildTableDDL in core delegates SQL generation
 * to these methods instead of generating SQL inline.
 */
export interface TableDDLGeneratorAdapter {
	/**
	 * Generate SQL for TRUNCATE TABLE.
	 */
	generateTruncate?(
		table: string,
		schema?: string,
		options?: TruncateOptions,
	): string;

	/**
	 * Generate SQL for VACUUM.
	 */
	generateVacuum?(
		table: string,
		schema?: string,
		options?: VacuumOptions,
	): string;

	/**
	 * Generate SQL for ALTER TABLE ... ALTER COLUMN.
	 */
	generateAlterColumn?(
		table: string,
		column: string,
		options: AlterColumnOptions,
		schema?: string,
	): string;

	/**
	 * Generate SQL for CREATE INDEX.
	 */
	generateCreateIndex(
		table: string,
		options: CreateIndexOptions,
		schema?: string,
	): string;

	/**
	 * Generate SQL for DROP INDEX.
	 */
	generateDropIndex?(name: string, options?: DropIndexOptions): string;

	/**
	 * List all indexes on a table, with optional name pattern filter.
	 */
	listIndexes?(
		table: string,
		schema?: string,
		options?: { namePattern?: string },
	): Promise<IndexInfo[]>;

	/**
	 * Check whether an index with the given name exists on a table.
	 */
	indexExists?(name: string, table: string, schema?: string): Promise<boolean>;

	/**
	 * Return the total storage size of a table in bytes.
	 * Requires a live pool connection — compile-only adapters must throw.
	 */
	storageSize?(table: string, schema?: string): Promise<number>;
}

/**
 * DDL-generating adapter - can generate DDL (CREATE TABLE statements) from a schema.
 */
export interface DDLGeneratingAdapter extends BaseAdapter {
	/**
	 * Generate DDL statements from a schema.
	 *
	 * @param schema - The ModelIR schema to generate DDL from
	 * @param options - Optional adapter-specific options (e.g., includeDropStatements)
	 * @returns Array of DDL statements (CREATE TABLE, CREATE INDEX, etc.)
	 */
	generateDDL(schema: ModelIR, options?: Record<string, unknown>): string[];
}

// ============================================================================
// Convenience Composed Types (DX-104)
// ============================================================================

/**
 * Compile-only adapter - can compile SQL and generate DDL, but cannot execute
 * queries or stream results. Useful for tooling, CLI, and testing without a
 * live database connection.
 *
 * Includes DDLGeneratingAdapter because DDL generation is purely compile-time
 * (no DB connection required — same rationale as SQL compilation).
 *
 * Explicitly excludes execution interfaces so that type-checking catches
 * misuse (e.g. calling execute() on a compile-only instance) at compile time.
 */
export type CompileOnlyAdapter = CompilingAdapter &
	DDLGeneratingAdapter &
	TableDDLGeneratorAdapter & {
		/** Naming convention used by this adapter. */
		readonly dbCasing: DbCasing;

		/**
		 * Create a schema-scoped compile-only adapter.
		 * Purely a schema-name prefix — no DB interaction required.
		 */
		withSchema(schemaName: string): CompileOnlyAdapter;

		readonly execute?: never;
		readonly executeOne?: never;
		readonly executeOneOrThrow?: never;
		readonly stream?: never;
		readonly introspect?: never;
		readonly transaction?: never;
		readonly executeRaw?: never;
		readonly executeDDL?: never;
	};

// ============================================================================
// Full Adapter Interface
// ============================================================================

/**
 * Database adapter interface - full adapter with all capabilities.
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
		DDLGeneratingAdapter,
		TableDDLGeneratorAdapter {
	/**
	 * Naming convention used by this adapter.
	 *
	 * @since ARCH-006
	 */
	readonly dbCasing: DbCasing;

	/**
	 * Execute a DDL statement directly (e.g. TRUNCATE, VACUUM, ALTER TABLE, CREATE INDEX).
	 * Optional — compile-only adapters do not implement this.
	 *
	 * @since DDL-TABLE-001
	 */
	executeDDL?(sql: string): Promise<void>;
}

// ============================================================================
// DDL Feature Negotiation (CAPS-001/002)
// ============================================================================

/** Behavior when schema uses features the adapter doesn't support */
export type UnsupportedFeatureBehavior = 'error' | 'warning' | 'ignore';

/** Aligned with DialectCapabilities supportsDDL* flags (1:1 mapping) */
export type DDLFeature =
	| 'enum'
	| 'sequence'
	| 'extension'
	| 'partition'
	| 'checkConstraint'
	| 'onUpdateFK'
	| 'deferredFK'
	| 'identity'
	| 'collation'
	| 'comment'
	| 'indexMethod'
	| 'indexOpclass'
	| 'indexInclude'
	| 'partialIndex'
	| 'expressionIndex'
	| 'indexNullsNotDistinct'
	| 'rowLevelSecurity';

/** Version range for a DDL feature — resolved at createDialectCapabilities() time */
export interface DDLFeatureVersionRange {
	/** Minimum database version required (inclusive). E.g., '8.0.16' */
	readonly min?: string;
	/** Maximum database version supported (inclusive, optional). For deprecation. */
	readonly max?: string;
}

/** Per-feature behavior overrides (global default + optional per-feature) */
export interface FeatureBehaviorConfig {
	/** Global default behavior (default: 'warning') */
	readonly default: UnsupportedFeatureBehavior;
	/** Per-feature overrides */
	readonly overrides?: Partial<Record<DDLFeature, UnsupportedFeatureBehavior>>;
}

/** Warning emitted when behavior = 'warning' */
export interface FeatureWarning {
	readonly feature: string;
	readonly adapter: string;
	readonly element: string;
	readonly message: string;
}

// ============================================================================
// Feature Translation Interface (CAPS-005 — design only)
// ============================================================================

/** Type-safe element map: DDLFeature → IR type (INV-12) */
export interface DDLFeatureElementMap {
	enum: EnumIR;
	sequence: SequenceIR;
	extension: string;
	partition: PartitionIR;
	checkConstraint: CheckConstraintIR;
	onUpdateFK: ForeignKeyIR;
	deferredFK: ForeignKeyIR;
	identity: ColumnIR;
	collation: ColumnIR;
	comment: { target: 'table' | 'column'; name: string; comment: string };
	indexMethod: IndexIR;
	indexOpclass: IndexIR;
	indexInclude: IndexIR;
	partialIndex: IndexIR;
	expressionIndex: IndexIR;
	indexNullsNotDistinct: IndexIR;
	/** Table with rlsEnabled and/or policies (ENABLE ROW LEVEL SECURITY + CREATE POLICY) */
	rowLevelSecurity: TableIR;
}

/**
 * Interface for translating IR features to dialect-specific SQL.
 * Adapters register translators to handle features their way.
 *
 * @example PG enum translator
 * ```typescript
 * const pgEnumTranslator: FeatureTranslator<'enum'> = {
 *   feature: 'enum',
 *   translate(element, context) {
 *     return [`CREATE TYPE "${element.name}" AS ENUM (${element.values.map(v => `'${v}'`).join(', ')})`];
 *   },
 * };
 * ```
 */
export interface FeatureTranslator<F extends DDLFeature = DDLFeature> {
	/** Which IR feature this translator handles */
	readonly feature: F;
	/** Generate SQL for this feature. Return null to skip (use default behavior). */
	translate(
		element: DDLFeatureElementMap[F],
		context: TranslationContext,
	): string[] | null;
}

export interface TranslationContext {
	readonly schemaName?: string;
	readonly tableName?: string;
	readonly dialectCapabilities: DialectCapabilities;
}
