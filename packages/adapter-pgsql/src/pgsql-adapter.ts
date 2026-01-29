/**
 * PgsqlAdapter - Implements the Adapter interface for PostgreSQL using native pg driver.
 *
 * This adapter wraps a pg Pool instance and provides the unified
 * adapter interface for the db-semantic-planner ORM.
 *
 * @module pgsql-adapter
 */

import type {
	Adapter,
	AdapterCapabilities,
	AdapterStreamOptions,
	CompiledQuery,
	CompileOptions,
	CompileResultWithIncludes,
	DeleteIntent,
	Dump,
	DumpMeta,
	InsertFromIntent,
	InsertIntent,
	ModelIR,
	NamingConvention,
	PlanReport,
	RecursivePlanReport,
	SubqueryIncludeInfo,
	UpdateIntent,
	UpsertIntent,
} from '@dbsp/core';
import type { Pool, PoolClient } from 'pg';
import { deparseSync } from 'pgsql-deparser';
import { type CompilerOptions, compilePlan } from './compiler.js';
import { type CompilerContext, createCompilerState } from './handlers/index.js';
import {
	compileDelete as compileDeleteMutation,
	compileInsert as compileInsertMutation,
	compileUpdate as compileUpdateMutation,
	type DeleteConfig,
	type InsertConfig,
	type UpdateConfig,
} from './mutations/index.js';
import { getNamingPlugin, type NamingPlugin } from './naming-plugin.js';
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
	/** Naming convention for identifier transformation */
	readonly namingConvention?: NamingConvention;
	/** Optional model for WHERE compilation */
	readonly model?: ModelIR;
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
	private readonly pool: Pool;
	private readonly client: PoolClient | undefined;
	private readonly schemaName: string | undefined;
	private readonly _namingConvention: NamingConvention;
	private readonly naming: NamingPlugin;
	private readonly model: ModelIR | undefined;
	private readonly _capabilities: AdapterCapabilities;

	/**
	 * Create a new PgsqlAdapter.
	 *
	 * @param pool - pg.Pool instance or PoolClient (for transactions)
	 * @param options - Optional configuration
	 */
	constructor(pool: Pool | PoolClient, options?: PgsqlAdapterOptions) {
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

		this.schemaName = options?.schemaName;
		this._namingConvention = options?.namingConvention ?? 'preserve';
		this.naming = getNamingPlugin(this._namingConvention);
		this.model = options?.model;

		// PostgreSQL capabilities - all features supported
		this._capabilities = {
			supportsReturning: true,
			supportsSchemas: true,
			supportsStreaming: true,
			supportsRecursiveCTE: true,
			supportsWindowFunctions: true,
			supportsArrayType: true,
		};
	}

	/** Adapter capabilities for feature detection */
	get capabilities(): AdapterCapabilities {
		return this._capabilities;
	}

	/**
	 * Naming convention used by this adapter.
	 */
	get namingConvention(): NamingConvention {
		return this._namingConvention;
	}

	/**
	 * Get the underlying pg Pool instance.
	 */
	getPoolInstance(): Pool {
		return this.pool;
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
		const schemaName = this.schemaName ?? options?.schemaName;

		const compilerOptions: CompilerOptions = schemaName
			? { naming: this.naming, schema: schemaName }
			: { naming: this.naming };

		// Note: Current compilePlan expects SimplifiedPlanReport
		// In Phase 2, we'll need to adapt PlanReport to SimplifiedPlanReport
		// or update compiler to accept PlanReport directly
		const result = compilePlan(plan as any, compilerOptions);

		return {
			sql: result.sql,
			parameters: result.parameters,
		};
	}

	/**
	 * Compile a plan with includes, returning subquery include metadata (DX-033).
	 * @stub Phase 3 - Include support
	 */
	compileWithIncludes<T = unknown>(
		plan: PlanReport,
		options?: CompileOptions,
	): CompileResultWithIncludes<T> {
		// Phase 3: Implement include compilation
		// For now, compile main query and return empty subqueryIncludes
		const main = this.compile<T>(plan, options);
		return {
			main,
			subqueryIncludes: [],
		};
	}

	/**
	 * Compile a subquery include query for given parent IDs (DX-033).
	 * @stub Phase 3 - Include support
	 */
	compileSubqueryInclude(
		_info: SubqueryIncludeInfo,
		_parentIds: readonly unknown[],
		_options?: CompileOptions,
	): CompiledQuery {
		throw new Error(
			'PgsqlAdapter.compileSubqueryInclude: Not implemented - Phase 3',
		);
	}

	/**
	 * Compile an insert intent to executable SQL.
	 */
	compileInsert(intent: InsertIntent, options?: CompileOptions): CompiledQuery {
		const schemaName = this.schemaName ?? options?.schemaName;

		// Create compiler context and state
		const ctx: CompilerContext = {
			naming: this.naming,
			rootTable: intent.table,
			...(schemaName !== undefined && { schema: schemaName }),
			maxRecursiveDepth: 100,
		};
		const state = createCompilerState();

		// Convert InsertIntent to InsertConfig
		// Extract columns and values from intent
		const firstRow = intent.values?.[0] ?? {};
		const columns = Object.keys(firstRow);
		const values = (intent.values ?? []).map((row) =>
			columns.map((col) => row[col]),
		);

		const config: InsertConfig = {
			table: intent.table,
			columns,
			values,
			...(intent.returning && { returning: [...intent.returning] }),
		};

		const ast = compileInsertMutation(config, ctx, state);
		const sql = deparseSync(ast);

		return {
			sql,
			parameters: state.parameters,
		};
	}

	/**
	 * Compile an insert-from intent to executable SQL (NQL-ALIGN).
	 * @stub Phase 2 - Mutations
	 */
	compileInsertFrom(
		_intent: InsertFromIntent,
		_options?: CompileOptions,
	): CompiledQuery {
		throw new Error(
			'PgsqlAdapter.compileInsertFrom: Not implemented - Phase 2',
		);
	}

	/**
	 * Compile an update intent to executable SQL.
	 */
	compileUpdate(intent: UpdateIntent, options?: CompileOptions): CompiledQuery {
		const schemaName = this.schemaName ?? options?.schemaName;

		// Create compiler context and state
		const ctx: CompilerContext = {
			naming: this.naming,
			rootTable: intent.table,
			...(schemaName !== undefined && { schema: schemaName }),
			maxRecursiveDepth: 100,
		};
		const state = createCompilerState();

		// Convert UpdateIntent to UpdateConfig
		const config: UpdateConfig = {
			table: intent.table,
			set: Object.entries(intent.set ?? {}).map(([column, value]) => ({
				column,
				value,
			})),
			...(intent.where && { where: [intent.where as any] }),
			...(intent.returning && { returning: [...intent.returning] }),
		};

		const ast = compileUpdateMutation(config, ctx, state);
		const sql = deparseSync(ast);

		return {
			sql,
			parameters: state.parameters,
		};
	}

	/**
	 * Compile a delete intent to executable SQL.
	 */
	compileDelete(intent: DeleteIntent, options?: CompileOptions): CompiledQuery {
		const schemaName = this.schemaName ?? options?.schemaName;

		// Create compiler context and state
		const ctx: CompilerContext = {
			naming: this.naming,
			rootTable: intent.table,
			...(schemaName !== undefined && { schema: schemaName }),
			maxRecursiveDepth: 100,
		};
		const state = createCompilerState();

		// Convert DeleteIntent to DeleteConfig
		const config: DeleteConfig = {
			table: intent.table,
			...(intent.where && { where: [intent.where as any] }),
			...(intent.returning && { returning: [...intent.returning] }),
		};

		const ast = compileDeleteMutation(config, ctx, state);
		const sql = deparseSync(ast);

		return {
			sql,
			parameters: state.parameters,
		};
	}

	/**
	 * Compile an upsert intent to executable SQL (DX-026).
	 * @stub Phase 2 - Upsert needs Intent type definition in core
	 */
	compileUpsert(
		_intent: UpsertIntent,
		_options?: CompileOptions,
	): CompiledQuery {
		throw new Error('PgsqlAdapter.compileUpsert: Not implemented - Phase 2');
	}

	/**
	 * Compile a recursive CTE plan to executable SQL.
	 * @stub Phase 2 - Recursive CTE
	 */
	compileRecursive(
		_report: RecursivePlanReport,
		_model: ModelIR,
		_options?: CompileOptions,
	): CompiledQuery {
		throw new Error('PgsqlAdapter.compileRecursive: Not implemented - Phase 2');
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
	 */
	async execute<T>(query: CompiledQuery<T>): Promise<T[]> {
		const executor = this.client ?? this.pool;
		const result = await executor.query(query.sql, query.parameters as any[]);
		return result.rows as T[];
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
	 * @stub Phase 2 - Streaming
	 */
	stream<T>(
		_query: CompiledQuery<T>,
		_options?: AdapterStreamOptions,
	): AsyncIterableIterator<T> {
		// Phase 2: Implement cursor-based streaming
		throw new Error('PgsqlAdapter.stream: Not implemented - Phase 2');
	}

	// =========================================================================
	// IntrospectingAdapter Methods
	// =========================================================================

	/**
	 * Introspect the database schema and return a ModelIR.
	 * @stub Phase 4 - Introspection
	 */
	async introspect(): Promise<ModelIR> {
		throw new Error('PgsqlAdapter.introspect: Not implemented - Phase 4');
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
		const client = await this.pool.connect();
		try {
			await client.query('BEGIN');

			// Create transaction-scoped adapter
			const txOptions: PgsqlAdapterOptions = {
				...(this.schemaName !== undefined && { schemaName: this.schemaName }),
				...(this._namingConvention !== undefined && {
					namingConvention: this._namingConvention,
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
			...(this._namingConvention !== undefined && {
				namingConvention: this._namingConvention,
			}),
			...(this.model !== undefined && { model: this.model }),
		};
		return new PgsqlAdapter<DB>(this.client ?? this.pool, options);
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
		const executor = this.client ?? this.pool;
		const result = await executor.query(sql, parameters as any[]);
		return result.rows as T[];
	}

	// =========================================================================
	// DDLGeneratingAdapter Methods
	// =========================================================================

	/**
	 * Generate DDL statements from a ModelIR schema.
	 * @stub Phase 3 - DDL Generation
	 */
	generateDDL(_schema: ModelIR): string[] {
		throw new Error('PgsqlAdapter.generateDDL: Not implemented - Phase 3');
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
 * const adapter = createPgsqlAdapter(pool, { namingConvention: 'camelCase' });
 * ```
 */
export function createPgsqlAdapter<DB = unknown>(
	pool: Pool,
	options?: PgsqlAdapterOptions,
): PgsqlAdapter<DB> {
	return new PgsqlAdapter<DB>(pool, options);
}
