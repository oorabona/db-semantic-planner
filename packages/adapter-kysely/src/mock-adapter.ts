/**
 * MockAdapter - Compile-only adapter for testing and REPL without database connection
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
	PlanReport,
	RecursivePlanReport,
	SeparateIncludeInfo,
	UpdateIntent,
	UpsertIntent,
} from '@db-semantic-planner/core';
import { ExecutionError } from '@db-semantic-planner/core';
import {
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
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
 * Supported dialects for MockAdapter SQL generation.
 */
export type MockDialect = 'postgresql' | 'mysql' | 'sqlite';

/**
 * Options for creating a MockAdapter.
 */
export interface MockAdapterOptions {
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
 */
function createMockKysely(dialect: MockDialect): Kysely<unknown> {
	// For now, we only support PostgreSQL syntax
	// MySQL and SQLite can be added later with their respective adapters
	if (dialect !== 'postgresql') {
		throw new Error(
			`MockAdapter currently only supports 'postgresql' dialect. Got: '${dialect}'`,
		);
	}

	return new Kysely({
		dialect: {
			createAdapter: () => new PostgresAdapter(),
			createDriver: () => new DummyDriver() as never,
			createIntrospector: (db) => new PostgresIntrospector(db),
			createQueryCompiler: () => new PostgresQueryCompiler(),
		},
	});
}

/**
 * MockAdapter - A compile-only adapter for SQL generation without database execution.
 *
 * Use this adapter when you need to:
 * - Generate SQL without executing it
 * - Test query compilation in unit tests
 * - Preview queries in a REPL/playground
 *
 * @example
 * ```typescript
 * import { createOrm } from '@db-semantic-planner/core';
 * import { createMockAdapter } from '@db-semantic-planner/adapter-kysely';
 *
 * const orm = createOrm({
 *   model: mySchema,
 *   adapter: createMockAdapter(),
 * });
 *
 * // Get SQL without executing
 * const dump = await orm.select('users').where(eq('active', true)).dump();
 * console.log(dump.sql); // SELECT * FROM users WHERE active = $1
 * ```
 */
export class MockAdapter implements Adapter<unknown> {
	private readonly kysely: Kysely<unknown>;
	private readonly _schemaName?: string;
	private readonly _capabilities: AdapterCapabilities;

	constructor(options: MockAdapterOptions = {}) {
		const dialect = options.dialect ?? 'postgresql';
		this.kysely = createMockKysely(dialect);
		if (options.schemaName !== undefined) {
			this._schemaName = options.schemaName;
		}

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

	// =========================================================================
	// Compilation Methods (the main purpose of MockAdapter)
	// =========================================================================

	compile<T = unknown>(
		plan: PlanReport,
		options?: CompileOptions,
	): CompiledQuery<T> {
		if (!options?.model) {
			throw new Error(
				'MockAdapter.compile requires options.model to be provided',
			);
		}

		const schemaName = this._schemaName ?? options.schemaName;
		const compiled = compile(plan, options.model, this.kysely, schemaName);

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
				'MockAdapter.compileWithIncludes requires options.model to be provided',
			);
		}

		const schemaName = this._schemaName ?? options.schemaName;
		const result = compileWithIncludes(plan, options.model, this.kysely, schemaName);

		// Convert to adapter-agnostic format
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
		const schemaName = this._schemaName ?? options?.schemaName;

		const compiled = compileSeparateInclude(
			info,
			parentIds,
			this.kysely,
			schemaName,
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
			reason: 'MockAdapter does not support query execution',
			fix: 'Use createKyselyAdapter() with a real database connection, or use dump() to get SQL without executing',
		});
	}

	async executeOne<T>(_query: CompiledQuery<T>): Promise<T | null> {
		throw new ExecutionError({
			operation: 'executeOne',
			reason: 'MockAdapter does not support query execution',
			fix: 'Use createKyselyAdapter() with a real database connection, or use dump() to get SQL without executing',
		});
	}

	async executeOneOrThrow<T>(_query: CompiledQuery<T>): Promise<T> {
		throw new ExecutionError({
			operation: 'executeOneOrThrow',
			reason: 'MockAdapter does not support query execution',
			fix: 'Use createKyselyAdapter() with a real database connection, or use dump() to get SQL without executing',
		});
	}

	async executeRaw<T = unknown>(
		_sql: string,
		_parameters?: readonly unknown[],
	): Promise<T[]> {
		throw new ExecutionError({
			operation: 'executeRaw',
			reason: 'MockAdapter does not support raw SQL execution',
			fix: 'Use createKyselyAdapter() with a real database connection',
		});
	}

	stream<T>(
		_query: CompiledQuery<T>,
		_options?: AdapterStreamOptions,
	): AsyncIterableIterator<T> {
		throw new ExecutionError({
			operation: 'stream',
			reason: 'MockAdapter does not support streaming',
			fix: 'Use createKyselyAdapter() with a real database connection',
		});
	}

	async transaction<T>(
		_fn: (adapter: Adapter<unknown>) => Promise<T>,
	): Promise<T> {
		throw new ExecutionError({
			operation: 'transaction',
			reason: 'MockAdapter does not support transactions',
			fix: 'Use createKyselyAdapter() with a real database connection',
		});
	}

	// =========================================================================
	// Schema and Introspection
	// =========================================================================

	withSchema(schemaName: string): Adapter<unknown> {
		return new MockAdapter({
			schemaName,
		});
	}

	async introspect(): Promise<ModelIR> {
		throw new ExecutionError({
			operation: 'introspect',
			reason: 'MockAdapter does not support database introspection',
			fix: 'Use createKyselyAdapter() with a real database connection, or provide an explicit schema via defineSchema()',
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
				...(this._schemaName !== undefined && { tenant: this._schemaName }),
				...meta,
			},
		};
	}

	validateIdentifier(value: string, type: string): void {
		validateIdentifier(value, type);
	}
}

/**
 * Creates a MockAdapter for compile-only SQL generation.
 *
 * @param options - Optional configuration
 * @returns A MockAdapter instance
 *
 * @example
 * ```typescript
 * // Basic usage
 * const mockAdapter = createMockAdapter();
 *
 * // With schema (multi-tenant)
 * const tenantAdapter = createMockAdapter({ schemaName: 'tenant_123' });
 *
 * // Use with ORM
 * const orm = createOrm({
 *   model: mySchema,
 *   adapter: createMockAdapter(),
 * });
 *
 * // Preview SQL without execution
 * const dump = await orm.select('users').dump();
 * console.log(dump.sql);
 * ```
 */
export function createMockAdapter(options?: MockAdapterOptions): MockAdapter {
	return new MockAdapter(options);
}
