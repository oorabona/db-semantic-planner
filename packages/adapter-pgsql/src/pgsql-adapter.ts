/**
 * PgsqlAdapter - Implements the Adapter interface for PostgreSQL using native pg driver.
 *
 * This adapter wraps a pg Pool instance and provides the unified
 * adapter interface for the db-semantic-planner ORM.
 *
 * @module pgsql-adapter
 */

import { plan as planFn, POSTGRESQL_CAPABILITIES } from '@dbsp/core';
import type {
	Adapter,
	AdapterCapabilities,
	AdapterLogger,
	AdapterStreamOptions,
	BatchUpdateIntent,
	CompiledQuery,
	CompileOptions,
	CompileResultWithIncludes,
	CteQueryIntent,
	DbCasing,
	DeleteIntent,
	DialectCapabilities,
	Dump,
	DumpMeta,
	InsertFromIntent,
	InsertIntent,
	ModelIR,
	PlanReport,
	RecursivePlanReport,
	SetOperationIntent,
	SubqueryIncludeInfo,
	UpdateIntent,
	UpsertFromIntent,
	UpsertIntent,
} from '@dbsp/types';
import type { Pool, PoolClient } from 'pg';
import type { AdapterCompilerDeps } from './adapter-compiler-deps.js';
import { compileSubqueryInclude as compileSubqueryIncludeImpl } from './adapter-compiler-includes.js';
import {
	compileBatchUpdate as compileBatchUpdateImpl,
	compileDelete as compileDeleteImpl,
	compileInsertFrom as compileInsertFromImpl,
	compileInsert as compileInsertImpl,
	compileUpdate as compileUpdateImpl,
	compileUpsertFrom as compileUpsertFromImpl,
	compileUpsert as compileUpsertImpl,
} from './adapter-compiler-mutations.js';
import {
	compileCteQuery as compileCteQueryImpl,
	compileRecursive as compileRecursiveImpl,
} from './adapter-compiler-recursive.js';
import {
	compileSetOperation as compileSetOperationImpl,
	createLeafCompileFn,
} from './set-operation.js';
import {
	compileSelect,
	compileWithIncludes as compileWithIncludesImpl,
} from './adapter-compiler-select.js';
import {
	DEFAULT_PK_COLUMN,
	defaultFkDerivation,
	type FkColumnDerivation,
} from './assert-field.js';
import {
	type GenerateDDLOptions,
	generateDDL as generateDDLStatements,
} from './ddl/index.js';
import {
	type IntrospectedModelIR,
	type IntrospectionOptions,
	introspect as introspectDb,
} from './introspection.js';
import {
	getNamingPluginForDbCasing,
	type NamingPlugin,
} from './naming-plugin.js';
import { generateCursorName } from './streaming/cursor.js';
import { validateIdentifier } from './validate.js';

// ============================================================================
// Options
// ============================================================================

/**
 * Options for PgsqlAdapter.
 */
export interface PgsqlAdapterOptions {
	/** Schema name for multi-tenant queries */
	readonly schemaName?: string;
	/**
	 * DB column casing convention (intuitive semantics).
	 * - `'snake_case'`: DB columns are snake_case → transform to camelCase for JS
	 * - `'camelCase'`: DB columns are camelCase → no transformation
	 * - `'preserve'`: No transformation
	 */
	readonly dbCasing?: DbCasing;
	/** Optional model for WHERE compilation */
	readonly model?: ModelIR;
	/** Optional logger for debug/error messages */
	readonly logger?: AdapterLogger;
	/** Default primary key column name for convention fallbacks (default: 'id') */
	readonly defaultPkColumnName?: string;
	/** Convention for deriving FK column names: (tableName, pkName) => fkColumnName */
	readonly deriveFkColumnName?: FkColumnDerivation;
}

// ============================================================================
// PgsqlAdapter
// ============================================================================

/**
 * Adapter implementation for PostgreSQL using native pg driver.
 *
 * @typeParam DB - Database schema type
 *
 * @example
 * ```typescript
 * import { Pool } from 'pg';
 * import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const adapter = createPgsqlAdapter(pool);
 * const orm = createOrm({ model, adapter });
 * ```
 */
export class PgsqlAdapter<DB = unknown> implements Adapter<DB> {
	private readonly pool: Pool | undefined;
	private readonly client: PoolClient | undefined;
	private readonly schemaName: string | undefined;
	private readonly _dbCasing: DbCasing;
	private readonly naming: NamingPlugin;
	private readonly model: ModelIR | undefined;
	private readonly logger: AdapterLogger | undefined;
	private readonly _capabilities: AdapterCapabilities;
	private readonly defaultPk: string;
	private readonly deriveFk: FkColumnDerivation;

	/**
	 * Create a new PgsqlAdapter.
	 *
	 * @param pool - pg.Pool instance, PoolClient (transactions), or undefined (compile-only mode)
	 * @param options - Optional configuration
	 */
	constructor(
		pool?: Pool | PoolClient | undefined,
		options?: PgsqlAdapterOptions,
	) {
		if (pool != null) {
			// Detect if this is a PoolClient (transaction context)
			if ('release' in pool && typeof pool.release === 'function') {
				this.client = pool as PoolClient;
				// For clients, we need to get the pool reference
				// This is a limitation - we'll use the client directly
				this.pool = pool as unknown as Pool;
			} else {
				this.pool = pool as Pool;
				this.client = undefined;
			}
		} else {
			// Compile-only mode — no pool/client
			this.pool = undefined;
			this.client = undefined;
		}

		this.schemaName = options?.schemaName;
		this._dbCasing = options?.dbCasing ?? 'preserve';
		this.naming = getNamingPluginForDbCasing(this._dbCasing);
		this.model = options?.model;
		this.logger = options?.logger;
		this.defaultPk = options?.defaultPkColumnName ?? DEFAULT_PK_COLUMN;
		this.deriveFk = options?.deriveFkColumnName ?? defaultFkDerivation;

		// PostgreSQL capabilities — streaming requires a connection
		this._capabilities = {
			supportsReturning: true,
			supportsSchemas: true,
			supportsStreaming: pool != null,
			supportsRecursiveCTE: true,
			supportsWindowFunctions: true,
			supportsArrayType: true,
		};
	}

	/**
	 * Shared compilation dependencies — built lazily from adapter fields.
	 * Passed to compiler sub-modules instead of `this`.
	 */
	private get compileDeps(): AdapterCompilerDeps {
		return {
			naming: this.naming,
			schemaName: this.schemaName,
			model: this.model,
			defaultPk: this.defaultPk,
			deriveFk: this.deriveFk,
		};
	}

	/**
	 * Returns the pool/client executor, or throws if in compile-only mode.
	 */
	private requireConnection(): Pool | PoolClient {
		const executor = this.client ?? this.pool;
		if (!executor) {
			throw new Error(
				'PgsqlAdapter is in compile-only mode (no database connection). ' +
					'Use createPgsqlAdapter(pool) for a full adapter with execution capabilities.',
			);
		}
		return executor;
	}

	/** Adapter capabilities for feature detection */
	get capabilities(): AdapterCapabilities {
		return this._capabilities;
	}

	/** PostgreSQL dialect capabilities for planner strategy selection */
	get dialectCapabilities(): DialectCapabilities {
		return POSTGRESQL_CAPABILITIES;
	}

	/**
	 * DB column casing convention used by this adapter.
	 */
	get dbCasing(): DbCasing {
		return this._dbCasing;
	}

	/**
	 * Get the underlying pg Pool instance.
	 */
	getPoolInstance(): Pool {
		return this.requireConnection() as Pool;
	}

	// =========================================================================
	// CompilingAdapter Methods
	// =========================================================================

	/**
	 * Compile a plan to executable SQL.
	 */
	compile<T = unknown>(
		plan: PlanReport,
		options?: CompileOptions,
	): CompiledQuery<T> {
		return compileSelect<T>(plan, options, this.compileDeps);
	}

	/**
	 * Compile a plan with includes, returning subquery include metadata (DX-033).
	 */
	compileWithIncludes<T = unknown>(
		plan: PlanReport,
		options?: CompileOptions,
	): CompileResultWithIncludes<T> {
		return compileWithIncludesImpl<T>(plan, options, this.compileDeps);
	}

	/**
	 * Compile a subquery include query for given parent IDs (DX-033).
	 * Generates: SELECT * FROM targetTable WHERE foreignKey IN ($1, $2, ...)
	 *
	 * @param info - Subquery include metadata
	 * @param parentIds - Parent record IDs to fetch related records for
	 * @param options - Compile options
	 * @returns Compiled query for fetching related records
	 */
	compileSubqueryInclude(
		info: SubqueryIncludeInfo,
		parentIds: readonly unknown[],
		options?: CompileOptions,
	): CompiledQuery {
		return compileSubqueryIncludeImpl(
			info,
			parentIds,
			options,
			this.compileDeps,
		);
	}

	/**
	 * Compile an insert intent to executable SQL.
	 *
	 * Strategy switch (per CompileOptions):
	 * - rows <= batchThreshold (default 50): VALUES ($1,$2),($3,$4),...
	 * - rows > batchThreshold OR batchThreshold === 0: SELECT unnest($1::type[]),...
	 */
	compileInsert(intent: InsertIntent, options?: CompileOptions): CompiledQuery {
		return compileInsertImpl(intent, options, this.compileDeps);
	}

	/**
	 * Compile an insert-from intent to executable SQL (NQL-ALIGN).
	 * INSERT INTO target (cols) SELECT cols FROM source WHERE ... LIMIT ... RETURNING ...
	 */
	compileInsertFrom(
		intent: InsertFromIntent,
		options?: CompileOptions,
	): CompiledQuery {
		return compileInsertFromImpl(intent, options, this.compileDeps);
	}

	/**
	 * Compile an update intent to executable SQL.
	 */
	compileUpdate(intent: UpdateIntent, options?: CompileOptions): CompiledQuery {
		return compileUpdateImpl(intent, options, this.compileDeps);
	}

	/**
	 * Compile a batch update intent to executable SQL using unnest FROM strategy (BATCH-001).
	 *
	 * Generates:
	 *   UPDATE "table" SET "update_col" = t."update_col" [, "scalar_col" = $N]
	 *   FROM unnest(CAST($1 AS type[]), CAST($2 AS type[])) AS t("match_col", "update_col")
	 *   WHERE "table"."match_col" = t."match_col"
	 *   [RETURNING ...]
	 */
	compileBatchUpdate(
		intent: BatchUpdateIntent,
		options?: CompileOptions,
	): CompiledQuery {
		return compileBatchUpdateImpl(intent, options, this.compileDeps);
	}

	/**
	 * Compile a delete intent to executable SQL.
	 */
	compileDelete(intent: DeleteIntent, options?: CompileOptions): CompiledQuery {
		return compileDeleteImpl(intent, options, this.compileDeps);
	}

	/**
	 * Compile an upsert intent to executable SQL (DX-026).
	 */
	compileUpsert(intent: UpsertIntent, options?: CompileOptions): CompiledQuery {
		return compileUpsertImpl(intent, options, this.compileDeps);
	}

	/**
	 * Compile an upsert-from intent to executable SQL (NQL-BIND).
	 * INSERT INTO target SELECT ... FROM source ON CONFLICT (cols) DO UPDATE SET ...
	 */
	compileUpsertFrom(
		intent: UpsertFromIntent,
		options?: CompileOptions,
	): CompiledQuery {
		return compileUpsertFromImpl(intent, options, this.compileDeps);
	}

	/**
	 * Compile a recursive CTE plan to executable SQL.
	 * Supports adjacency-list and edge-table traversal modes.
	 */
	compileRecursive(
		report: RecursivePlanReport,
		model: ModelIR,
		options?: CompileOptions,
	): CompiledQuery {
		return compileRecursiveImpl(report, model, options, this.compileDeps);
	}

	/**
	 * Compile a CTE query backed by unnest() arrays (BATCH-001 Block 5).
	 *
	 * Strategy: compile CTE nodes to SQL fragments, compile outer query
	 * independently (parameters starting at $1), then renumber outer params
	 * to start after CTE params and prepend WITH clause.
	 */
	compileCteQuery(
		intent: CteQueryIntent,
		options?: CompileOptions,
	): CompiledQuery {
		return compileCteQueryImpl(intent, options, this.compileDeps);
	}

	/**
	 * Compile a set operation (UNION / INTERSECT / EXCEPT) to SQL.
	 */
	compileSetOperation(
		intent: SetOperationIntent,
		model: ModelIR,
		_options?: CompileOptions,
	): CompiledQuery {
		const compileFn = createLeafCompileFn(this, model, planFn);
		const result = compileSetOperationImpl(intent, compileFn);
		return {
			sql: result.sql,
			parameters: result.parameters,
		};
	}

	/**
	 * Create a dump for observability.
	 */
	createDump(plan: PlanReport, query: CompiledQuery, meta?: DumpMeta): Dump {
		return {
			plan,
			sql: query.sql,
			params: query.parameters,
			meta: {
				...(this.schemaName !== undefined && { schema: this.schemaName }),
				compiledAt: new Date(),
				...meta,
			},
		};
	}

	// =========================================================================
	// ExecutingAdapter Methods
	// =========================================================================

	/**
	 * Execute a query and return all results.
	 * Results are transformed to use model naming convention (e.g., snake_case → camelCase)
	 */
	async execute<T>(query: CompiledQuery<T>): Promise<T[]> {
		const executor = this.requireConnection();
		const result = await executor.query(query.sql, [...query.parameters]);
		return this.transformResultRows(result.rows) as T[];
	}

	/**
	 * Transform result rows from database naming to model naming convention.
	 * For CamelCaseNamingPlugin: price_cents → priceCents
	 */
	private transformResultRows(
		rows: Record<string, unknown>[],
	): Record<string, unknown>[] {
		return rows.map((row) => {
			const transformed: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(row)) {
				// Use toModel to convert database column name to model column name
				const modelKey = this.naming.toModel(key);
				transformed[modelKey] = value;
			}
			return transformed;
		});
	}

	/**
	 * Execute a query and return the first result or null.
	 */
	async executeOne<T>(query: CompiledQuery<T>): Promise<T | null> {
		const results = await this.execute<T>(query);
		return results[0] ?? null;
	}

	/**
	 * Execute a query and return the first result or throw.
	 */
	async executeOneOrThrow<T>(query: CompiledQuery<T>): Promise<T> {
		const result = await this.executeOne<T>(query);
		if (result === null) {
			throw new Error('No results found');
		}
		return result;
	}

	// =========================================================================
	// StreamingAdapter Methods
	// =========================================================================

	/**
	 * Stream query results as an async iterable iterator.
	 * Uses PostgreSQL cursors for efficient streaming.
	 *
	 * Note: The cursor must be used within a transaction. If not already
	 * in a transaction, this method wraps the streaming in one.
	 *
	 * @param query - Compiled query to stream
	 * @param options - Stream options (chunkSize)
	 * @returns AsyncIterableIterator that yields rows one by one
	 */
	stream<T>(
		query: CompiledQuery<T>,
		options?: AdapterStreamOptions,
	): AsyncIterableIterator<T> {
		const chunkSize = options?.chunkSize ?? 100;
		const adapter = this;

		// Use a wrapper to create the async generator
		async function* streamGenerator(): AsyncIterableIterator<T> {
			// If already in transaction (has client), use it directly
			if (adapter.client) {
				yield* adapter.streamWithClient<T>(adapter.client, query, chunkSize);
				return;
			}

			// Otherwise, acquire a client and create a transaction
			const pool = adapter.requireConnection() as Pool;
			const client = await pool.connect();
			let committed = false;
			try {
				await client.query('BEGIN');
				yield* adapter.streamWithClient<T>(client, query, chunkSize);
				await client.query('COMMIT');
				committed = true;
			} catch (error) {
				await client.query('ROLLBACK');
				throw error;
			} finally {
				// On early break, yield* returns without reaching COMMIT.
				// ROLLBACK the open transaction to avoid leaking it to the pool.
				if (!committed) {
					try {
						await client.query('ROLLBACK');
					} catch (rollbackErr) {
						// Rollback errors during cleanup are non-actionable;
						// the connection returns to the pool regardless.
						adapter.logger?.debug?.(
							'Rollback failed during cleanup',
							rollbackErr,
						);
					}
				}
				client.release();
			}
		}

		return streamGenerator();
	}

	/**
	 * Internal: Stream with an existing client using cursors.
	 */
	private async *streamWithClient<T>(
		client: PoolClient,
		query: CompiledQuery<T>,
		chunkSize: number,
	): AsyncIterableIterator<T> {
		// Generate unique cursor name
		const cursorName = generateCursorName();

		// Declare cursor
		await client.query(
			`DECLARE ${cursorName} NO SCROLL CURSOR FOR ${query.sql}`,
			query.parameters as unknown[],
		);

		try {
			// Fetch in batches
			while (true) {
				const result = await client.query(
					`FETCH FORWARD ${chunkSize} FROM ${cursorName}`,
				);

				if (result.rows.length === 0) {
					break;
				}

				for (const row of result.rows) {
					yield row as T;
				}

				// If we got fewer rows than batch size, we're done
				if (result.rows.length < chunkSize) {
					break;
				}
			}
		} finally {
			// Always close the cursor
			await client.query(`CLOSE ${cursorName}`);
		}
	}

	// =========================================================================
	// IntrospectingAdapter Methods
	// =========================================================================

	/**
	 * Introspect the database schema and return a ModelIR.
	 *
	 * @param options - Optional introspection options (schema, include/exclude filters)
	 * @returns IntrospectedModelIR with tables, relations, and hierarchy metadata
	 *
	 * @example
	 * ```typescript
	 * const model = await adapter.introspect();
	 * const model = await adapter.introspect({ schema: 'tenant_1' });
	 * const model = await adapter.introspect({ exclude: ['_prisma*'] });
	 * ```
	 */
	async introspect(
		options?: IntrospectionOptions,
	): Promise<IntrospectedModelIR> {
		if (!this.pool) {
			throw new Error(
				'Cannot introspect without a database connection (compile-only adapter)',
			);
		}
		return introspectDb(this.pool, options);
	}

	// =========================================================================
	// TransactionalAdapter Methods
	// =========================================================================

	/**
	 * Execute a callback within a database transaction.
	 */
	async transaction<T>(fn: (adapter: Adapter<DB>) => Promise<T>): Promise<T> {
		// If already in a transaction (this.client exists), reuse it
		if (this.client) {
			return fn(this);
		}

		// Otherwise, acquire a client and start transaction
		const pool = this.requireConnection() as Pool;
		const client = await pool.connect();
		try {
			await client.query('BEGIN');

			// Create transaction-scoped adapter
			const txOptions: PgsqlAdapterOptions = {
				...(this.schemaName !== undefined && { schemaName: this.schemaName }),
				...(this._dbCasing !== undefined && {
					dbCasing: this._dbCasing,
				}),
				...(this.model !== undefined && { model: this.model }),
			};
			const txAdapter = new PgsqlAdapter<DB>(client, txOptions);

			const result = await fn(txAdapter);

			await client.query('COMMIT');
			return result;
		} catch (error) {
			await client.query('ROLLBACK');
			throw error;
		} finally {
			client.release();
		}
	}

	/**
	 * Create a schema-scoped adapter for multi-tenant queries.
	 */
	withSchema(schemaName: string): Adapter<DB> {
		// Validate schema name
		validateIdentifier(schemaName, 'schema');

		// Create new adapter with schema scope
		const options: PgsqlAdapterOptions = {
			schemaName,
			...(this._dbCasing !== undefined && {
				dbCasing: this._dbCasing,
			}),
			...(this.model !== undefined && { model: this.model }),
		};
		return new PgsqlAdapter<DB>(this.client ?? this.pool ?? undefined, options);
	}

	// =========================================================================
	// RawSqlAdapter Methods
	// =========================================================================

	/**
	 * Execute raw SQL directly.
	 *
	 * ⚠️  WARNING: Use parameter placeholders ($1, $2, etc.) for all values.
	 */
	async executeRaw<T = unknown>(
		sql: string,
		parameters: readonly unknown[] = [],
	): Promise<T[]> {
		const executor = this.requireConnection();
		const result = await executor.query(sql, [...parameters]);
		return result.rows as T[];
	}

	// =========================================================================
	// DDLGeneratingAdapter Methods
	// =========================================================================

	/**
	 * Generate DDL statements from a ModelIR schema.
	 *
	 * Uses PostgreSQL AST nodes and pgsql-deparser for consistent SQL generation.
	 * Applies the naming plugin for identifier transformation.
	 *
	 * @param schema - The ModelIR schema to generate DDL from
	 * @param overrideOptions - Optional overrides for DDL generation (e.g., includeDropStatements)
	 * @returns Array of DDL statements in dependency order
	 */
	generateDDL(
		schema: ModelIR,
		overrideOptions?: Partial<GenerateDDLOptions>,
	): string[] {
		const options: GenerateDDLOptions = {
			...(this.schemaName ? { schemaName: this.schemaName } : {}),
			naming: this.naming,
			...overrideOptions,
		};
		return generateDDLStatements(schema, options);
	}

	// =========================================================================
	// Validation
	// =========================================================================

	/**
	 * Validate an identifier (table name, column name, schema name).
	 */
	validateIdentifier(value: string, type: string): void {
		// Cast to expected type union
		const identifierType = type as 'table' | 'column' | 'schema' | 'alias';
		validateIdentifier(value, identifierType);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a PgsqlAdapter from a pg Pool instance.
 *
 * @param pool - pg Pool instance
 * @param options - Optional configuration
 * @returns A new PgsqlAdapter instance
 *
 * @example
 * ```typescript
 * import { Pool } from 'pg';
 * import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const adapter = createPgsqlAdapter(pool);
 *
 * // With naming convention
 * const adapter = createPgsqlAdapter(pool, { dbCasing: 'snake_case' });
 * ```
 */
export function createPgsqlAdapter<DB = unknown>(
	pool: Pool,
	options?: PgsqlAdapterOptions,
): PgsqlAdapter<DB> {
	return new PgsqlAdapter<DB>(pool, options);
}

/**
 * Creates a compile-only PgsqlAdapter for SQL generation without a database connection.
 *
 * All compilation methods (compile, compileInsert, etc.), createDump(), and generateDDL()
 * work normally. Execution methods (execute, stream, transaction, etc.) throw an error.
 *
 * @example
 * ```typescript
 * import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';
 * import { createOrm } from '@dbsp/core';
 *
 * const adapter = createPgsqlCompileOnlyAdapter();
 * const orm = createOrm({ model, adapter });
 * const dump = await orm.select('users').dump();
 * console.log(dump.sql);
 * ```
 */
export function createPgsqlCompileOnlyAdapter<DB = unknown>(
	options?: PgsqlAdapterOptions,
): PgsqlAdapter<DB> {
	return new PgsqlAdapter<DB>(undefined, options);
}
