import type { Adapter } from '../adapter.js';
import type { DialectCapabilities } from '../dialects/index.js';
import type { ModelIR } from '../model-ir.js';
import type { PlanOptions } from '../planner.js';

import { InvalidOperationError } from './errors.js';
import { eq } from './filters.js';
import {
	extractRecursiveField,
	findSelfRefRelation,
} from './hierarchy-helpers.js';
import type { HookErrorHandler, HookStore } from './hooks.js';
import {
	DeleteBuilder,
	InsertBuilder,
	UpdateBuilder,
	UpsertBuilder,
} from './mutation-builders.js';
import { CteBuilder } from './cte-builder.js';
import { createNqlTag, type NqlTag } from './nql.js';
import { QueryBuilderImpl } from './query-builder.js';
import type { DefaultFilters } from './schema.js';
import { TABLE_META } from './symbols.js';
import type { InferTableRow, TableRef } from './table-ref.js';
import type {
	ListHierarchyOptions,
	OrmInstance,
	OrmInstanceInternal,
	QueryBuilder,
	RelationHints,
} from './types.js';

/**
 * Internal factory for creating ORM instances.
 * Supports optional schema name for multi-tenant scenarios.
 *
 * @typeParam DB - Database schema type (passed through from createOrm)
 */
export function createOrmInstance<DB = Record<string, unknown>>(
	model: ModelIR,
	strictMode: boolean,
	relationHints: RelationHints,
	adapter?: Adapter<DB>,
	schemaName?: string,
	dialectCapabilities?: DialectCapabilities,
	schemaDefinition?: unknown,
	globalPlanOptions?: PlanOptions,
	defaultFilters?: DefaultFilters,
	hookStore?: HookStore,
	onHookError?: HookErrorHandler,
	inTransaction?: boolean,
	tablesProxy?: object,
): OrmInstanceInternal<DB> {
	// Create NQL template tag (DX-040)
	// NQL compiler is now integrated directly - @dbsp/nql is imported in nql.ts
	const nql: NqlTag = createNqlTag(
		schemaDefinition,
		model,
		adapter as Adapter<unknown> | undefined,
		schemaName,
	);

	// Helper: build a MutationBuilder options object (shared across mutation methods)
	const mutationOpts = {
		model,
		adapter,
		schemaName,
		hookStore,
		onHookError,
		inTransaction,
	} as const;

	return {
		strictMode,
		nql,
		tables: (tablesProxy ?? {}) as Record<string, TableRef<any, any, any>>,
		from<TTable extends TableRef<any, any, any>>(
			table: TTable,
		): QueryBuilder<InferTableRow<TTable>> {
			const tableName = table[TABLE_META];
			if (tableName === undefined) {
				throw new Error('Invalid TableRef: missing TABLE_META symbol');
			}
			return new QueryBuilderImpl<InferTableRow<TTable>>(
				model,
				strictMode,
				tableName as string,
				relationHints,
				adapter,
				schemaName,
				dialectCapabilities,
				globalPlanOptions,
				defaultFilters,
				hookStore,
				onHookError,
				inTransaction,
			);
		},
		select<K extends keyof DB & string, TResult = DB[K]>(
			from: K,
		): QueryBuilder<TResult> {
			return new QueryBuilderImpl<TResult>(
				model,
				strictMode,
				from as string,
				relationHints,
				adapter,
				schemaName,
				dialectCapabilities,
				globalPlanOptions,
				defaultFilters,
				hookStore,
				onHookError,
				inTransaction,
			);
		},
		withSchema(schemaName: string): OrmInstanceInternal<DB> {
			// Validate schema name to prevent SQL injection
			if (adapter) {
				adapter.validateIdentifier(schemaName, 'schema');
			}
			// Create a schema-scoped adapter if we have one
			const scopedAdapter = adapter?.withSchema(schemaName);
			return createOrmInstance(
				model,
				strictMode,
				relationHints,
				scopedAdapter as Adapter<DB> | undefined,
				schemaName,
				dialectCapabilities,
				schemaDefinition,
				globalPlanOptions,
				defaultFilters,
				hookStore,
				onHookError,
				inTransaction,
				tablesProxy,
			);
		},

		// =====================================================================
		// Hierarchy List Methods (DX-022)
		// Returns flat arrays, uses include() with recursive: true internally
		// =====================================================================

		/**
		 * List all ancestors of a node as a flat array.
		 * Uses the new include({ recursive: true }) API internally.
		 *
		 * @param table - The table name
		 * @param nodeIdValue - The starting node's ID value
		 * @param options - Options including parentId column name
		 * @returns Promise resolving to array of ancestor records
		 */
		async listAncestors<TResult = unknown>(
			table: string,
			nodeIdValue: unknown,
			options: ListHierarchyOptions,
		): Promise<TResult[]> {
			if (!adapter) {
				throw new Error(
					'listAncestors() requires an adapter. ' +
						'Pass an adapter when creating the ORM.',
				);
			}

			// Find the self-referential relation that matches the parent direction
			const selfRefRelation = findSelfRefRelation(model, table, 'ancestors');
			if (!selfRefRelation) {
				throw new InvalidOperationError(
					'listAncestors',
					`Table '${table}' has no self-referential belongsTo/hasOne relation for ancestor traversal`,
				);
			}

			const nodeIdCol = options.nodeId ?? 'id';
			const maxDepth = options.maxDepth ?? 100;

			const builder = new QueryBuilderImpl<TResult>(
				model,
				strictMode,
				table,
				relationHints,
				adapter,
				schemaName,
				dialectCapabilities,
				globalPlanOptions,
				defaultFilters,
				hookStore,
				onHookError,
			);

			const result = await builder
				.where(eq(nodeIdCol, nodeIdValue))
				.include(selfRefRelation.name, {
					recursive: true,
					direction: 'ancestors',
					flat: true,
					omitSelf: true,
					maxDepth,
				})
				.first();

			// Result shape from include({ recursive, direction: 'ancestors' }):
			// { id, ..., ancestors: [...] }
			return extractRecursiveField<TResult>(result, 'ancestors');
		},

		/**
		 * List all descendants of a node as a flat array.
		 * Uses the new include({ recursive: true }) API internally.
		 *
		 * @param table - The table name
		 * @param nodeIdValue - The starting node's ID value
		 * @param options - Options including parentId column name
		 * @returns Promise resolving to array of descendant records
		 */
		async listDescendants<TResult = unknown>(
			table: string,
			nodeIdValue: unknown,
			options: ListHierarchyOptions,
		): Promise<TResult[]> {
			if (!adapter) {
				throw new Error(
					'listDescendants() requires an adapter. ' +
						'Pass an adapter when creating the ORM.',
				);
			}

			// Find the self-referential relation that matches the children direction
			const selfRefRelation = findSelfRefRelation(model, table, 'descendants');
			if (!selfRefRelation) {
				throw new InvalidOperationError(
					'listDescendants',
					`Table '${table}' has no self-referential hasMany relation for descendant traversal`,
				);
			}

			const nodeIdCol = options.nodeId ?? 'id';
			const maxDepth = options.maxDepth ?? 100;

			const builder = new QueryBuilderImpl<TResult>(
				model,
				strictMode,
				table,
				relationHints,
				adapter,
				schemaName,
				dialectCapabilities,
				globalPlanOptions,
				defaultFilters,
				hookStore,
				onHookError,
			);

			const result = await builder
				.where(eq(nodeIdCol, nodeIdValue))
				.include(selfRefRelation.name, {
					recursive: true,
					direction: 'descendants',
					flat: true,
					omitSelf: true,
					maxDepth,
				})
				.first();

			// Result shape from include({ recursive, direction: 'descendants' }):
			// { id, ..., descendants: [...] }
			return extractRecursiveField<TResult>(result, 'descendants');
		},

		// =====================================================================
		// Typed Mutation Entry Points (DX-040-SURFACE)
		// Extract table name from TableRef metadata and delegate to string methods
		// =====================================================================

		into(tableRef: TableRef<any, any, any>): InsertBuilder {
			const tableName = tableRef[TABLE_META];
			if (tableName === undefined) {
				throw new Error('Invalid TableRef: missing TABLE_META symbol');
			}
			return new InsertBuilder({ table: tableName as string, ...mutationOpts });
		},

		modify(tableRef: TableRef<any, any, any>): UpdateBuilder {
			const tableName = tableRef[TABLE_META];
			if (tableName === undefined) {
				throw new Error('Invalid TableRef: missing TABLE_META symbol');
			}
			return new UpdateBuilder({ table: tableName as string, ...mutationOpts });
		},

		removeFrom(tableRef: TableRef<any, any, any>): DeleteBuilder {
			const tableName = tableRef[TABLE_META];
			if (tableName === undefined) {
				throw new Error('Invalid TableRef: missing TABLE_META symbol');
			}
			return new DeleteBuilder({ table: tableName as string, ...mutationOpts });
		},

		upsertInto(tableRef: TableRef<any, any, any>): UpsertBuilder {
			const tableName = tableRef[TABLE_META];
			if (tableName === undefined) {
				throw new Error('Invalid TableRef: missing TABLE_META symbol');
			}
			return new UpsertBuilder({ table: tableName as string, ...mutationOpts });
		},

		// =====================================================================
		// Mutation Methods (DX-010)
		// =====================================================================

		insert(table: string): InsertBuilder {
			return new InsertBuilder({
				table,
				model,
				adapter,
				schemaName,
				hookStore,
				onHookError,
				inTransaction,
			});
		},

		update(table: string): UpdateBuilder {
			return new UpdateBuilder({
				table,
				model,
				adapter,
				schemaName,
				hookStore,
				onHookError,
				inTransaction,
			});
		},

		delete(table: string): DeleteBuilder {
			return new DeleteBuilder({
				table,
				model,
				adapter,
				schemaName,
				hookStore,
				onHookError,
				inTransaction,
			});
		},

		updateAll(table: string): UpdateBuilder {
			return new UpdateBuilder({
				table,
				model,
				adapter,
				schemaName,
				allowAll: true,
				hookStore,
				onHookError,
				inTransaction,
			});
		},

		deleteAll(table: string): DeleteBuilder {
			return new DeleteBuilder({
				table,
				model,
				adapter,
				schemaName,
				allowAll: true,
				hookStore,
				onHookError,
				inTransaction,
			});
		},

		// DX-026: Upsert support
		upsert(table: string): UpsertBuilder {
			return new UpsertBuilder({
				table,
				model,
				adapter,
				schemaName,
				hookStore,
				onHookError,
				inTransaction,
			});
		},

		// =====================================================================
		// Transaction Methods (DX-025)
		// =====================================================================

		async transaction<T>(fn: (tx: OrmInstance<DB>) => Promise<T>): Promise<T> {
			if (!adapter) {
				throw new Error(
					'transaction() requires an adapter. ' +
						'Pass an adapter when creating the ORM.',
				);
			}

			// Passthrough to adapter's transaction API
			return adapter.transaction(async (txAdapter) => {
				// Create a transaction-scoped ORM instance with inTransaction=true
				const txOrm = createOrmInstance<DB>(
					model,
					strictMode,
					relationHints,
					txAdapter as Adapter<DB>,
					schemaName,
					dialectCapabilities,
					schemaDefinition,
					globalPlanOptions,
					defaultFilters,
					hookStore,
					onHookError,
					true, // inTransaction
					tablesProxy,
				);
				return fn(txOrm);
			});
		},

		// =====================================================================
		// Raw SQL Execution (DX-027)
		// =====================================================================

		/**
		 * Execute raw SQL directly - escape hatch for queries that cannot
		 * be expressed via the intent system.
		 *
		 * @warning **SECURITY RISK: POTENTIAL SQL INJECTION**
		 *
		 * This method bypasses the semantic planner and all type safety.
		 * Always use parameter placeholders ($1, $2, etc.) for values.
		 *
		 * **SAFE:**
		 * ```typescript
		 * orm.raw('SELECT * FROM users WHERE id = $1', [userId]);
		 * ```
		 *
		 * **DANGEROUS - NEVER DO THIS:**
		 * ```typescript
		 * orm.raw(`SELECT * FROM users WHERE id = ${userId}`);
		 * ```
		 *
		 * @param sqlString - SQL with parameter placeholders ($1, $2, etc.)
		 * @param parameters - Values to bind (safely escaped by driver)
		 * @returns Promise resolving to typed results
		 *
		 * @see {@link https://owasp.org/www-community/attacks/SQL_Injection | OWASP SQL Injection}
		 */
		async raw<T = unknown>(
			sqlString: string,
			parameters: readonly unknown[] = [],
		): Promise<T[]> {
			if (!adapter) {
				throw new Error(
					'raw() requires an adapter. ' +
						'Pass an adapter when creating the ORM.',
				);
			}

			// Passthrough to adapter's executeRaw API
			return adapter.executeRaw<T>(sqlString, parameters);
		},

		withCte(name: string): CteBuilder {
			return new CteBuilder(name, adapter, schemaName);
		},
	};
}
