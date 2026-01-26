/**
 * CompileOnlyAdapter - Compile-only adapter for testing and REPL without database connection
 *
 * DX-031: Provides an adapter that can compile intents to SQL without requiring
 * a real database connection. Useful for:
 * - Unit tests without database setup
 * - REPL/playground mode to preview SQL
 * - Debugging query compilation
 *
 * All execution methods throw ExecutionError with helpful messages.
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
	NamingConvention,
	PlanReport,
	RecursivePlanReport,
	SeparateIncludeInfo,
	UpdateIntent,
	UpsertIntent,
} from '@dbsp/core';
import { ExecutionError } from '@dbsp/core';
import {
	CamelCasePlugin,
	Kysely,
	MssqlAdapter,
	MssqlIntrospector,
	MssqlQueryCompiler,
	MysqlAdapter,
	MysqlIntrospector,
	MysqlQueryCompiler,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
} from 'kysely';
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
import { validateIdentifier } from './errors.js';

/**
 * Supported dialects for CompileOnlyAdapter SQL generation.
 */
export type MockDialect = 'postgresql' | 'mysql' | 'sqlite' | 'mssql';

/**
 * Options for creating a CompileOnlyAdapter.
 */
export interface CompileOnlyAdapterOptions {
	/**
	 * The SQL dialect to use for query compilation.
	 * Affects SQL syntax (e.g., parameter placeholders, quoting).
	 * @default 'postgresql'
	 */
	dialect?: MockDialect;

	/**
	 * Optional schema name for multi-tenant queries.
	 */
	schemaName?: string;

	/**
	 * Column aliasing mode for included relations (ADAPTER-003).
	 * - 'always' (default): Alias all columns from included tables
	 * - 'onCollision': Only alias columns that exist in multiple tables
	 * @default 'always'
	 */
	aliasIncludedColumns?: 'always' | 'onCollision';

	/**
	 * Naming convention for identifier transformation (ARCH-006).
	 * - 'camelCase': Schema uses camelCase, DB uses snake_case
	 * - 'snake_case': Both schema and DB use snake_case
	 * - 'preserve': No transformation
	 * @default 'preserve'
	 */
	namingConvention?: NamingConvention;
}

/**
 * Dummy driver that does nothing (no actual database connection).
 * Required by Kysely to create a query builder instance.
 */
class DummyDriver {
	async init() {}
	async acquireConnection() {
		return {};
	}
	async beginTransaction() {}
	async commitTransaction() {}
	async rollbackTransaction() {}
	async releaseConnection() {}
	async destroy() {}
}

/**
 * Creates a Kysely instance with the specified dialect but no real database connection.
 * CLI-011: Support all major SQL dialects for accurate syntax generation.
 */
function createMockKysely(dialect: MockDialect): Kysely<unknown> {
	// CamelCasePlugin ensures generated SQL uses snake_case column names,
	// matching DDL generation (camelCase schema → snake_case database columns)
	const plugins = [new CamelCasePlugin()];

	switch (dialect) {
		case 'postgresql':
			return new Kysely({
				dialect: {
					createAdapter: () => new PostgresAdapter(),
					createDriver: () => new DummyDriver() as never,
					createIntrospector: (db) => new PostgresIntrospector(db),
					createQueryCompiler: () => new PostgresQueryCompiler(),
				},
				plugins,
			});
		case 'mysql':
			return new Kysely({
				dialect: {
					createAdapter: () => new MysqlAdapter(),
					createDriver: () => new DummyDriver() as never,
					createIntrospector: (db) => new MysqlIntrospector(db),
					createQueryCompiler: () => new MysqlQueryCompiler(),
				},
				plugins,
			});
		case 'sqlite':
			return new Kysely({
				dialect: {
					createAdapter: () => new SqliteAdapter(),
					createDriver: () => new DummyDriver() as never,
					createIntrospector: (db) => new SqliteIntrospector(db),
					createQueryCompiler: () => new SqliteQueryCompiler(),
				},
				plugins,
			});
		case 'mssql':
			return new Kysely({
				dialect: {
					createAdapter: () => new MssqlAdapter(),
					createDriver: () => new DummyDriver() as never,
					createIntrospector: (db) => new MssqlIntrospector(db),
					createQueryCompiler: () => new MssqlQueryCompiler(),
				},
				plugins,
			});
		default: {
			const _exhaustive: never = dialect;
			throw new Error(`Unknown dialect: ${_exhaustive}`);
		}
	}
}

/**
 * CompileOnlyAdapter - A compile-only adapter for SQL generation without database execution.
 *
 * Use this adapter when you need to:
 * - Generate SQL without executing it
 * - Test query compilation in unit tests
 * - Preview queries in a REPL/playground
 *
 * @example
 * ```typescript
 * import { createOrm } from '@dbsp/core';
 * import { createCompileOnlyAdapter } from '@dbsp/adapter-kysely';
 *
 * const orm = createOrm({
 *   model: mySchema,
 *   adapter: createCompileOnlyAdapter(),
 * });
 *
 * // Get SQL without executing
 * const dump = await orm.select('users').where(eq('active', true)).dump();
 * console.log(dump.sql); // SELECT * FROM users WHERE active = $1
 * ```
 */
export class CompileOnlyAdapter implements Adapter<unknown> {
	private readonly kysely: Kysely<unknown>;
	private readonly _schemaName?: string;
	private readonly _dialect: MockDialect;
	private readonly _capabilities: AdapterCapabilities;
	private readonly _aliasIncludedColumns: 'always' | 'onCollision';
	private readonly _namingConvention: NamingConvention;

	constructor(options: CompileOnlyAdapterOptions = {}) {
		const dialect = options.dialect ?? 'postgresql';
		this._dialect = dialect;

		// Create base Kysely instance
		let kyselyInstance = createMockKysely(dialect);

		// Apply schema scoping using Kysely's native API
		if (options.schemaName !== undefined) {
			this._schemaName = options.schemaName;
			kyselyInstance = kyselyInstance.withSchema(options.schemaName);
		}

		this.kysely = kyselyInstance;
		this._aliasIncludedColumns = options.aliasIncludedColumns ?? 'always';
		this._namingConvention = options.namingConvention ?? 'preserve';

		// PostgreSQL capabilities (most permissive)
		this._capabilities = {
			supportsReturning: true,
			supportsSchemas: true,
			supportsStreaming: false, // Mock doesn't support streaming
			supportsRecursiveCTE: true,
			supportsWindowFunctions: true,
			supportsArrayType: true,
		};
	}

	get capabilities(): AdapterCapabilities {
		return this._capabilities;
	}

	/**
	 * Naming convention used by this adapter.
	 * @since ARCH-006
	 */
	get namingConvention(): NamingConvention {
		return this._namingConvention;
	}

	// =========================================================================
	// Compilation Methods (the main purpose of CompileOnlyAdapter)
	// =========================================================================

	compile<T = unknown>(
		plan: PlanReport,
		options?: CompileOptions,
	): CompiledQuery<T> {
		if (!options?.model) {
			throw new Error(
				'CompileOnlyAdapter.compile requires options.model to be provided',
			);
		}

		const schemaName = this._schemaName ?? options.schemaName;
		const compiled = compile(plan, options.model, this.kysely, {
			...(schemaName !== undefined && { schemaName }),
			aliasIncludedColumns: this._aliasIncludedColumns,
		});

		return {
			sql: compiled.sql,
			parameters: compiled.parameters as readonly unknown[],
		};
	}

	/**
	 * Compile a plan with includes (DX-033).
	 */
	compileWithIncludes<T = unknown>(
		plan: PlanReport,
		options?: CompileOptions,
	): CompileResultWithIncludes<T> {
		if (!options?.model) {
			throw new Error(
				'CompileOnlyAdapter.compileWithIncludes requires options.model to be provided',
			);
		}

		const schemaName = this._schemaName ?? options.schemaName;
		const result = compileWithIncludes(plan, options.model, this.kysely, {
			...(schemaName !== undefined && { schemaName }),
			aliasIncludedColumns: this._aliasIncludedColumns,
		});

		// Convert to adapter-agnostic format (preserving all properties including M:N)
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
				// M:N (manyToMany) properties
				if (info.through !== undefined) {
					(mapped as { through?: string }).through = info.through;
				}
				if (info.throughSourceKey !== undefined) {
					(mapped as { throughSourceKey?: string }).throughSourceKey =
						info.throughSourceKey;
				}
				if (info.throughTargetKey !== undefined) {
					(mapped as { throughTargetKey?: string }).throughTargetKey =
						info.throughTargetKey;
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
		const schemaName = this._schemaName ?? options?.schemaName;

		// Pass model and dialect to enable compileWhere for WHERE conditions
		const compiled = compileSeparateInclude(
			info,
			parentIds,
			this.kysely,
			schemaName,
			options?.model,
			undefined, // coreCapabilities - derived from dialect in compileWhere
			this._dialect,
		);

		return {
			sql: compiled.sql,
			parameters: compiled.parameters as readonly unknown[],
		};
	}

	compileInsert(intent: InsertIntent, options?: CompileOptions): CompiledQuery {
		const schemaName = this._schemaName ?? options?.schemaName;
		return compileInsert(intent, this.kysely, schemaName);
	}

	compileUpdate(intent: UpdateIntent, options?: CompileOptions): CompiledQuery {
		const schemaName = this._schemaName ?? options?.schemaName;
		return compileUpdate(intent, this.kysely, schemaName);
	}

	compileDelete(intent: DeleteIntent, options?: CompileOptions): CompiledQuery {
		const schemaName = this._schemaName ?? options?.schemaName;
		return compileDelete(intent, this.kysely, schemaName);
	}

	compileUpsert(intent: UpsertIntent, options?: CompileOptions): CompiledQuery {
		const schemaName = this._schemaName ?? options?.schemaName;
		return compileUpsert(intent, this.kysely, schemaName);
	}

	compileRecursive(
		report: RecursivePlanReport,
		model: ModelIR,
		options?: CompileOptions,
	): CompiledQuery {
		const schemaName = this._schemaName ?? options?.schemaName;
		return compileRecursive(report, model, this.kysely, schemaName);
	}

	// =========================================================================
	// Execution Methods (all throw ExecutionError)
	// =========================================================================

	async execute<T>(_query: CompiledQuery<T>): Promise<T[]> {
		throw new ExecutionError({
			operation: 'execute',
			reason: 'CompileOnlyAdapter does not support query execution',
			fix: 'Use createKyselyAdapter() with a real database connection, or use dump() to get SQL without executing',
		});
	}

	async executeOne<T>(_query: CompiledQuery<T>): Promise<T | null> {
		throw new ExecutionError({
			operation: 'executeOne',
			reason: 'CompileOnlyAdapter does not support query execution',
			fix: 'Use createKyselyAdapter() with a real database connection, or use dump() to get SQL without executing',
		});
	}

	async executeOneOrThrow<T>(_query: CompiledQuery<T>): Promise<T> {
		throw new ExecutionError({
			operation: 'executeOneOrThrow',
			reason: 'CompileOnlyAdapter does not support query execution',
			fix: 'Use createKyselyAdapter() with a real database connection, or use dump() to get SQL without executing',
		});
	}

	async executeRaw<T = unknown>(
		_sql: string,
		_parameters?: readonly unknown[],
	): Promise<T[]> {
		throw new ExecutionError({
			operation: 'executeRaw',
			reason: 'CompileOnlyAdapter does not support raw SQL execution',
			fix: 'Use createKyselyAdapter() with a real database connection',
		});
	}

	stream<T>(
		_query: CompiledQuery<T>,
		_options?: AdapterStreamOptions,
	): AsyncIterableIterator<T> {
		throw new ExecutionError({
			operation: 'stream',
			reason: 'CompileOnlyAdapter does not support streaming',
			fix: 'Use createKyselyAdapter() with a real database connection',
		});
	}

	async transaction<T>(
		_fn: (adapter: Adapter<unknown>) => Promise<T>,
	): Promise<T> {
		throw new ExecutionError({
			operation: 'transaction',
			reason: 'CompileOnlyAdapter does not support transactions',
			fix: 'Use createKyselyAdapter() with a real database connection',
		});
	}

	// =========================================================================
	// Schema and Introspection
	// =========================================================================

	withSchema(schemaName: string): Adapter<unknown> {
		// Create a new CompileOnlyAdapter that preserves dialect, aliasing, and naming options
		// but scopes to the specified schema using Kysely's native withSchema API
		return new CompileOnlyAdapter({
			dialect: this._dialect,
			schemaName,
			aliasIncludedColumns: this._aliasIncludedColumns,
			namingConvention: this._namingConvention,
		});
	}

	async introspect(): Promise<ModelIR> {
		throw new ExecutionError({
			operation: 'introspect',
			reason: 'CompileOnlyAdapter does not support database introspection',
			fix: 'Use createKyselyAdapter() with a real database connection, or provide an explicit schema via schema()',
		});
	}

	generateDDL(_schema: ModelIR): string[] {
		throw new ExecutionError({
			operation: 'generateDDL',
			reason: 'CompileOnlyAdapter does not support DDL generation',
			fix: 'Use createKyselyAdapter() with a real database connection',
		});
	}

	// =========================================================================
	// Dump and Validation
	// =========================================================================

	createDump(plan: PlanReport, query: CompiledQuery, meta?: DumpMeta): Dump {
		return {
			plan,
			sql: query.sql,
			params: query.parameters as readonly unknown[],
			meta: {
				...(this._schemaName !== undefined && { schema: this._schemaName }),
				compiledAt: new Date(),
				...meta,
			},
		};
	}

	validateIdentifier(value: string, type: string): void {
		validateIdentifier(value, type);
	}
}

/**
 * Creates a CompileOnlyAdapter for compile-only SQL generation.
 *
 * @param options - Optional configuration
 * @returns A CompileOnlyAdapter instance
 *
 * @example
 * ```typescript
 * // Basic usage
 * const mockAdapter = createCompileOnlyAdapter();
 *
 * // With schema (multi-tenant)
 * const tenantAdapter = createCompileOnlyAdapter({ schemaName: 'tenant_123' });
 *
 * // Use with ORM
 * const orm = createOrm({
 *   model: mySchema,
 *   adapter: createCompileOnlyAdapter(),
 * });
 *
 * // Preview SQL without execution
 * const dump = await orm.select('users').dump();
 * console.log(dump.sql);
 * ```
 */
export function createCompileOnlyAdapter(
	options?: CompileOnlyAdapterOptions,
): CompileOnlyAdapter {
	return new CompileOnlyAdapter(options);
}
