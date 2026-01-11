/**
 * KyselyAdapter - Implements the Adapter interface for Kysely.
 *
 * This adapter wraps a Kysely instance and provides the unified
 * adapter interface for the db-semantic-planner ORM.
 *
 * @module kysely-adapter
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
	InsertIntent,
	ModelIR,
	PlanReport,
	RecursivePlanReport,
	SeparateIncludeInfo,
	UpdateIntent,
	UpsertIntent,
} from '@db-semantic-planner/core';
import type { Kysely, Transaction } from 'kysely';

import {
	compile,
	compileDelete,
	compileInsert,
	compileRecursive,
	compileSeparateInclude,
	compileUpdate,
	compileUpsert,
	compileWithIncludes,
} from './compiler.js';
import { getCapabilities } from './dialect.js';
import { validateIdentifier } from './errors.js';
import { introspect } from './introspection.js';
import { type StreamQueryOptions, streamQuery } from './stream.js';

// ============================================================================
// KyselyAdapter
// ============================================================================

/**
 * Adapter implementation for Kysely.
 *
 * @typeParam DB - Kysely database schema type
 *
 * @example
 * ```typescript
 * import { Kysely, PostgresDialect } from 'kysely';
 * import { createKyselyAdapter } from '@db-semantic-planner/adapter-kysely';
 *
 * const db = new Kysely<Database>({ dialect: new PostgresDialect(...) });
 * const adapter = createKyselyAdapter(db);
 * const orm = createOrm({ model, adapter });
 * ```
 */
export class KyselyAdapter<DB = unknown> implements Adapter<DB> {
	// biome-ignore lint/suspicious/noExplicitAny: Kysely requires any for generic database schema
	private readonly db: Kysely<any> | Transaction<any>;
	private readonly schemaName: string | undefined;
	private readonly _capabilities: AdapterCapabilities;

	/**
	 * Create a new KyselyAdapter.
	 *
	 * @param db - Kysely instance or Transaction
	 * @param schemaName - Optional schema name for multi-tenant queries
	 */
	// biome-ignore lint/suspicious/noExplicitAny: Kysely requires any for generic database schema
	constructor(db: Kysely<any> | Transaction<any>, schemaName?: string) {
		this.db = db;
		this.schemaName = schemaName;

		// Get capabilities from dialect and map to AdapterCapabilities
		// biome-ignore lint/suspicious/noExplicitAny: Cast needed for Kysely type compatibility
		const dialectCapabilities = getCapabilities(db as Kysely<any>);
		this._capabilities = {
			supportsReturning: dialectCapabilities.supportsReturning,
			// Map supportsWithSchema to supportsSchemas
			supportsSchemas: dialectCapabilities.supportsWithSchema,
			supportsStreaming: dialectCapabilities.supportsStreaming,
			// Map supportsCTE to supportsRecursiveCTE
			supportsRecursiveCTE: dialectCapabilities.supportsCTE,
			supportsWindowFunctions: dialectCapabilities.supportsWindowFunctions,
			supportsArrayType: dialectCapabilities.supportsArrayType,
		};
	}

	/** Adapter capabilities for feature detection */
	get capabilities(): AdapterCapabilities {
		return this._capabilities;
	}

	/**
	 * Compile a plan to executable SQL.
	 */
	compile<T = unknown>(
		plan: PlanReport,
		options?: CompileOptions,
	): CompiledQuery<T> {
		// Model is required for compilation
		if (!options?.model) {
			throw new Error(
				'KyselyAdapter.compile requires options.model to be provided',
			);
		}

		// Merge schema name from adapter with options
		const schemaName = this.schemaName ?? options.schemaName;

		const compiled = compile(plan, options.model, this.db, schemaName);
		return {
			sql: compiled.sql,
			parameters: compiled.parameters as readonly unknown[],
		};
	}

	/**
	 * Compile a plan with includes, returning separate include metadata (DX-033).
	 */
	compileWithIncludes<T = unknown>(
		plan: PlanReport,
		options?: CompileOptions,
	): CompileResultWithIncludes<T> {
		if (!options?.model) {
			throw new Error(
				'KyselyAdapter.compileWithIncludes requires options.model to be provided',
			);
		}

		const schemaName = this.schemaName ?? options.schemaName;
		const result = compileWithIncludes(
			plan,
			options.model,
			this.db,
			schemaName,
		);

		// Convert to adapter-agnostic format (pass through - types are now aligned)
		const separateIncludes: SeparateIncludeInfo[] = result.separateIncludes.map(
			(info) => {
				const mapped: SeparateIncludeInfo = {
					relationName: info.relationName,
					targetTable: info.targetTable,
					foreignKey: info.foreignKey,
					sourceKey: info.sourceKey,
				};
				if (info.select !== undefined) {
					(mapped as { select?: typeof info.select }).select = info.select;
				}
				if (info.where !== undefined) {
					(mapped as { where?: typeof info.where }).where = info.where;
				}
				return mapped;
			},
		);

		return {
			main: {
				sql: result.main.sql,
				parameters: result.main.parameters as readonly unknown[],
			},
			separateIncludes,
		};
	}

	/**
	 * Compile a separate include query for given parent IDs (DX-033).
	 */
	compileSeparateInclude(
		info: SeparateIncludeInfo,
		parentIds: readonly unknown[],
		options?: CompileOptions,
	): CompiledQuery {
		const schemaName = this.schemaName ?? options?.schemaName;

		// The types are now aligned - pass through directly
		const compiled = compileSeparateInclude(
			info,
			parentIds,
			this.db,
			schemaName,
		);

		return {
			sql: compiled.sql,
			parameters: compiled.parameters as readonly unknown[],
		};
	}

	/**
	 * Execute a query and return all results.
	 */
	async execute<T>(query: CompiledQuery<T>): Promise<T[]> {
		// Create a minimal CompiledQuery that Kysely can execute
		// biome-ignore lint/suspicious/noExplicitAny: Kysely executeQuery requires specific internal types
		const kyselyQuery: any = {
			sql: query.sql,
			parameters: query.parameters as unknown[],
			query: { kind: 'RawNode', sqlFragments: [], parameters: [] },
		};
		const result = await this.db.executeQuery(kyselyQuery);
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

	/**
	 * Stream query results as an async iterable iterator.
	 */
	stream<T>(
		query: CompiledQuery<T>,
		options?: AdapterStreamOptions,
	): AsyncIterableIterator<T> {
		// Create a Dump-like object for streamQuery
		const dumpLike = {
			sql: query.sql,
			params: query.parameters as readonly unknown[],
		};

		// Pass chunkSize to streamQuery if provided
		const streamOptions: StreamQueryOptions | undefined =
			options?.chunkSize !== undefined
				? { chunkSize: options.chunkSize }
				: undefined;
		const iterator = streamQuery<T>(this.db, dumpLike as Dump, streamOptions);

		return iterator;
	}

	/**
	 * Execute a callback within a database transaction.
	 */
	async transaction<T>(fn: (adapter: Adapter<DB>) => Promise<T>): Promise<T> {
		// biome-ignore lint/suspicious/noExplicitAny: Kysely Transaction requires any
		return this.db.transaction().execute(async (trx: Transaction<any>) => {
			const txAdapter = new KyselyAdapter<DB>(trx, this.schemaName);
			return fn(txAdapter);
		});
	}

	/**
	 * Create a schema-scoped adapter for multi-tenant queries.
	 */
	withSchema(schemaName: string): Adapter<DB> {
		// Validate schema name
		validateIdentifier(schemaName, 'schema');

		// Create scoped Kysely and new adapter
		const scopedDb = this.db.withSchema(schemaName);
		return new KyselyAdapter<DB>(scopedDb, schemaName);
	}

	/**
	 * Create a dump for observability.
	 * This is a simple assembly of already-compiled pieces.
	 */
	createDump(plan: PlanReport, query: CompiledQuery, meta?: DumpMeta): Dump {
		// Handle exactOptionalPropertyTypes: only include meta if defined
		const dump: Dump = {
			plan,
			sql: query.sql,
			params: query.parameters,
		};
		if (meta !== undefined) {
			return { ...dump, meta };
		}
		return dump;
	}

	// =========================================================================
	// Mutation Compilation
	// =========================================================================

	/**
	 * Compile an insert intent to executable SQL.
	 */
	compileInsert(intent: InsertIntent, options?: CompileOptions): CompiledQuery {
		const schemaName = this.schemaName ?? options?.schemaName;

		const compiled = compileInsert(intent, this.db, schemaName);
		return {
			sql: compiled.sql,
			parameters: compiled.parameters as readonly unknown[],
		};
	}

	/**
	 * Compile an update intent to executable SQL.
	 */
	compileUpdate(intent: UpdateIntent, options?: CompileOptions): CompiledQuery {
		const schemaName = this.schemaName ?? options?.schemaName;

		const compiled = compileUpdate(intent, this.db, schemaName);
		return {
			sql: compiled.sql,
			parameters: compiled.parameters as readonly unknown[],
		};
	}

	/**
	 * Compile a delete intent to executable SQL.
	 */
	compileDelete(intent: DeleteIntent, options?: CompileOptions): CompiledQuery {
		const schemaName = this.schemaName ?? options?.schemaName;

		const compiled = compileDelete(intent, this.db, schemaName);
		return {
			sql: compiled.sql,
			parameters: compiled.parameters as readonly unknown[],
		};
	}

	/**
	 * Compile an upsert intent to executable SQL (DX-026).
	 */
	compileUpsert(intent: UpsertIntent, options?: CompileOptions): CompiledQuery {
		const schemaName = this.schemaName ?? options?.schemaName;

		const compiled = compileUpsert(intent, this.db, schemaName);
		return {
			sql: compiled.sql,
			parameters: compiled.parameters as readonly unknown[],
		};
	}

	// =========================================================================
	// Recursive CTE Compilation
	// =========================================================================

	/**
	 * Compile a recursive CTE plan to executable SQL.
	 */
	compileRecursive(
		report: RecursivePlanReport,
		model: ModelIR,
		options?: CompileOptions,
	): CompiledQuery {
		const schemaName = this.schemaName ?? options?.schemaName;

		const compiled = compileRecursive(report, model, this.db, schemaName);
		return {
			sql: compiled.sql,
			parameters: compiled.parameters as readonly unknown[],
		};
	}

	// =========================================================================
	// Introspection
	// =========================================================================

	/**
	 * Introspect the database schema and return a ModelIR.
	 */
	async introspect(): Promise<ModelIR> {
		const options =
			this.schemaName !== undefined ? { schema: this.schemaName } : undefined;
		// biome-ignore lint/suspicious/noExplicitAny: Cast needed for Kysely type compatibility
		const result = await introspect(this.db as Kysely<any>, options);
		return result;
	}

	// =========================================================================
	// Validation Utilities
	// =========================================================================

	/**
	 * Validate an identifier (table name, column name, schema name).
	 */
	validateIdentifier(value: string, type: string): void {
		validateIdentifier(value, type);
	}

	// =========================================================================
	// Raw SQL Execution (DX-027)
	// =========================================================================

	/**
	 * Execute raw SQL directly.
	 * This is the ultimate escape hatch for queries that cannot be
	 * expressed via the intent system.
	 *
	 * ⚠️  WARNING: The SQL is executed as-is. Use parameter placeholders
	 * ($1, $2, etc.) for any dynamic values to prevent SQL injection.
	 */
	async executeRaw<T = unknown>(
		sqlString: string,
		parameters: readonly unknown[] = [],
	): Promise<T[]> {
		// Create a raw query compatible with Kysely's executeQuery
		// biome-ignore lint/suspicious/noExplicitAny: Kysely executeQuery requires specific internal types
		const kyselyQuery: any = {
			sql: sqlString,
			parameters: [...parameters],
			query: { kind: 'RawNode', sqlFragments: [], parameters: [] },
		};
		const result = await this.db.executeQuery(kyselyQuery);
		return result.rows as T[];
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a KyselyAdapter from a Kysely instance.
 *
 * @param db - Kysely database instance
 * @param schemaName - Optional default schema name
 * @returns KyselyAdapter instance
 *
 * @example
 * ```typescript
 * const adapter = createKyselyAdapter(kyselyDb);
 * const orm = createOrm({ model, adapter });
 * ```
 */
export function createKyselyAdapter<DB = unknown>(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely requires any for generic database schema
	db: Kysely<any>,
	schemaName?: string,
): KyselyAdapter<DB> {
	return new KyselyAdapter<DB>(db, schemaName);
}
