import { type Adapter, supportsTransactions } from '../adapter.js';
import type { DialectCapabilities } from '../dialects/index.js';
import type { ModelIR } from '../model-ir.js';
import type { PlanOptions } from '../planner.js';
import type { BatchValuesOptions, BatchValuesRef } from './batch-values.js';
import { batchValues } from './batch-values.js';
import { CteBuilder } from './cte-builder.js';
import {
	ExecutionError,
	InvalidOperationError,
	validateIdentifier,
} from './errors.js';
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
import { createNqlTag, type NqlTag } from './nql.js';
import type { SelectExpressionResult } from './orm-instance-types.js';
import { QueryBuilderImpl } from './query-builder.js';
import type { QueryBuilderContext } from './query-builder-context.js';
import {
	createRawCteBuilder,
	type RawCteQueryBuilder,
	type RecursiveOptions,
} from './raw-cte-builder.js';
import type { DefaultFilters } from './schema.js';
import { TABLE_META } from './symbols.js';
import type {
	AlterColumnOptions,
	CreateIndexOptions,
	DropIndexOptions,
	IndexInfo,
	TableDDL,
	TruncateOptions,
	VacuumOptions,
} from './table-ddl-types.js';
import type { InferTableRow, TableRef } from './table-ref.js';
import type {
	ExpressionSpec,
	ListHierarchyOptions,
	OrmInstance,
	OrmInstanceInternal,
	QueryBuilder,
	RelationHints,
} from './types.js';

/**
 * Quote a PostgreSQL identifier (table/schema/column name).
 * Simple double-quoting — no validation, validation is caller's responsibility.
 */

/**
 * Build the qualified table reference string for DDL statements.
 */

/**
 * Build the DDL methods object for a specific table.
 */
// ─── DDL SQL generation helpers ──────────────────────────────────────────────

/** Double-quote a PostgreSQL identifier. */
function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** Build a qualified `"schema"."table"` or `"table"` reference. */
function buildQualifiedTable(
	tableName: string,
	schemaName: string | undefined,
): string {
	return schemaName
		? `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`
		: quoteIdent(tableName);
}

function generateTruncateSQL(
	tableName: string,
	schemaName: string | undefined,
	options: TruncateOptions | undefined,
): string {
	const parts = [`TRUNCATE ${buildQualifiedTable(tableName, schemaName)}`];
	if (options?.restartIdentity) parts.push('RESTART IDENTITY');
	if (options?.cascade) parts.push('CASCADE');
	return parts.join(' ');
}

function generateVacuumSQL(
	tableName: string,
	schemaName: string | undefined,
	options: VacuumOptions | undefined,
): string {
	const modifiers: string[] = [];
	if (options?.full) modifiers.push('FULL');
	if (options?.analyze) modifiers.push('ANALYZE');
	const mod = modifiers.length > 0 ? `(${modifiers.join(', ')}) ` : '';
	return `VACUUM ${mod}${buildQualifiedTable(tableName, schemaName)}`;
}

function createUnsupportedTransactionError(): ExecutionError {
	return new ExecutionError({
		operation: 'transaction()',
		reason:
			'The adapter declares supportsTransactions: false for this ORM instance.',
		fix: 'Use an adapter configuration that supports transactions.',
	});
}

function generateAlterColumnSQL(
	tableName: string,
	column: string,
	schemaName: string | undefined,
	options: AlterColumnOptions,
): string {
	const tbl = buildQualifiedTable(tableName, schemaName);
	const col = quoteIdent(column);
	const clauses: string[] = [];

	if (options.type !== undefined) {
		let clause = `ALTER COLUMN ${col} TYPE ${options.type}`;
		if (options.using !== undefined) {
			clause += ` USING ${options.using}`;
		}
		clauses.push(clause);
	}
	if (options.setNotNull === true) {
		clauses.push(`ALTER COLUMN ${col} SET NOT NULL`);
	} else if (options.setNotNull === false) {
		clauses.push(`ALTER COLUMN ${col} DROP NOT NULL`);
	}
	if (options.dropDefault === true) {
		clauses.push(`ALTER COLUMN ${col} DROP DEFAULT`);
	} else if (options.setDefault !== undefined) {
		clauses.push(`ALTER COLUMN ${col} SET DEFAULT ${options.setDefault}`);
	}
	if (clauses.length === 0) {
		throw new InvalidOperationError(
			'alterColumn',
			'At least one alteration option must be specified.',
		);
	}
	return `ALTER TABLE ${tbl} ${clauses.join(', ')}`;
}

function generateCreateIndexSQL(
	tableName: string,
	schemaName: string | undefined,
	opts: CreateIndexOptions,
): string {
	const tbl = buildQualifiedTable(tableName, schemaName);
	const parts: string[] = ['CREATE'];
	if (opts.unique) parts.push('UNIQUE');
	parts.push('INDEX');
	if (opts.concurrently) parts.push('CONCURRENTLY');
	if (opts.ifNotExists) parts.push('IF NOT EXISTS');
	parts.push(quoteIdent(opts.name));
	parts.push('ON');
	parts.push(tbl);
	if (opts.method) parts.push(`USING ${opts.method}`);

	const colDefs = opts.columns.map((col) => {
		if (typeof col === 'string') {
			const quotedCol = quoteIdent(col);
			const op = opts.opclass?.[col] != null ? ` ${opts.opclass[col]}` : '';
			return `${quotedCol}${op}`;
		}
		const op = col.opclass != null ? ` ${col.opclass}` : '';
		return `(${col.expression})${op}`;
	});
	parts.push(`(${colDefs.join(', ')})`);

	if (opts.include && opts.include.length > 0) {
		parts.push(
			`INCLUDE (${opts.include.map((c) => quoteIdent(c)).join(', ')})`,
		);
	}
	// Emitted unconditionally, matching INCLUDE; full PG-version gating is tracked in #245.
	if (opts.unique && opts.nullsNotDistinct) {
		parts.push('NULLS NOT DISTINCT');
	}
	if (opts.with && Object.keys(opts.with).length > 0) {
		const withClauses = Object.entries(opts.with)
			.map(([k, v]) => `${k} = ${v}`)
			.join(', ');
		parts.push(`WITH (${withClauses})`);
	}
	if (opts.where) parts.push(`WHERE ${opts.where}`);
	return parts.join(' ');
}

function generateDropIndexSQL(
	name: string,
	schemaName: string | undefined,
	options: DropIndexOptions | undefined,
): string {
	const parts: string[] = ['DROP INDEX'];
	if (options?.concurrently) parts.push('CONCURRENTLY');
	if (options?.ifExists) parts.push('IF EXISTS');
	const sc = options?.schema ?? schemaName;
	parts.push(sc ? `${quoteIdent(sc)}.${quoteIdent(name)}` : quoteIdent(name));
	if (options?.cascade) parts.push('CASCADE');
	return parts.join(' ');
}

// ─── indexes sub-API builder ──────────────────────────────────────────────────

function buildIndexAPI(
	tableName: string,
	schemaName: string | undefined,
	adapter: Adapter<unknown> | undefined,
	requireAdapter: () => Adapter<unknown>,
): TableDDL['indexes'] {
	return {
		async create(opts: CreateIndexOptions): Promise<void> {
			const a = requireAdapter();
			if (opts.concurrently && a.inTransaction) {
				throw new InvalidOperationError(
					'createIndex',
					'CREATE INDEX CONCURRENTLY cannot run inside a transaction block',
				);
			}
			const sql = a.generateCreateIndex
				? a.generateCreateIndex(tableName, opts, schemaName)
				: generateCreateIndexSQL(tableName, schemaName, opts);
			await a.executeDDL?.(sql);
		},

		async drop(name: string, options?: DropIndexOptions): Promise<void> {
			const a = requireAdapter();
			if (options?.concurrently && a.inTransaction) {
				throw new InvalidOperationError(
					'dropIndex',
					'DROP INDEX CONCURRENTLY cannot run inside a transaction block',
				);
			}
			// Every other generator on this port takes the schema as an explicit
			// parameter — generateCreateIndex, generateTruncate, generateVacuum,
			// generateAlterColumn — so none of them can forget it. generateDropIndex
			// expects it inside `options`, so it can, and it did: the fallback below
			// used `schemaName` while the adapter path handed PostgreSQL a bare name to
			// resolve through search_path, which in a multi-tenant database drops an
			// index — just possibly somebody else's. An explicit option still wins.
			const scopedOptions: DropIndexOptions | undefined = schemaName
				? { ...options, schema: options?.schema ?? schemaName }
				: options;
			const sql = a.generateDropIndex
				? a.generateDropIndex(name, scopedOptions)
				: generateDropIndexSQL(name, schemaName, options);
			await a.executeDDL?.(sql);
		},

		async list(options?: { namePattern?: string }): Promise<IndexInfo[]> {
			if (!adapter) {
				throw new InvalidOperationError(
					'indexes.list',
					'indexes.list() requires an adapter.',
				);
			}
			// DB-agnostic core must not emit database-specific catalog SQL.
			// Listing indexes requires the adapter to implement listIndexes()
			// (mirrors indexes.exists() below); fail loud rather than fall back
			// to a PostgreSQL-only pg_index/pg_indexes query.
			if (!adapter.listIndexes) {
				throw new InvalidOperationError(
					'indexes.list',
					'indexes.list() requires an adapter that implements listIndexes().',
				);
			}
			return adapter.listIndexes(tableName, schemaName, options);
		},

		async exists(name: string): Promise<boolean> {
			if (!adapter) {
				throw new InvalidOperationError(
					'indexes.exists',
					'indexes.exists() requires an adapter.',
				);
			}
			if (!adapter.indexExists) {
				throw new InvalidOperationError(
					'indexes.exists',
					'indexes.exists() requires an adapter that implements indexExists().',
				);
			}
			return adapter.indexExists(name, tableName, schemaName);
		},
	};
}

// ─── Public assembler ─────────────────────────────────────────────────────────

/**
 * Build the DDL methods object for a specific table.
 */
function buildTableDDL(
	tableName: string,
	schemaName: string | undefined,
	adapter: Adapter<unknown> | undefined,
): TableDDL {
	function requireAdapter(): Adapter<unknown> {
		if (!adapter?.executeDDL) {
			throw new InvalidOperationError(
				'table DDL',
				'executeDDL() requires an adapter that supports DDL execution. ' +
					'Pass an adapter with executeDDL when creating the ORM.',
			);
		}
		return adapter;
	}

	return {
		async truncate(options?: TruncateOptions): Promise<void> {
			const a = requireAdapter();
			const sql = a.generateTruncate
				? a.generateTruncate(tableName, schemaName, options)
				: generateTruncateSQL(tableName, schemaName, options);
			await a.executeDDL?.(sql);
		},

		async vacuum(options?: VacuumOptions): Promise<void> {
			const a = requireAdapter();
			if (a.inTransaction) {
				throw new InvalidOperationError(
					'vacuum',
					'VACUUM cannot run inside a transaction block',
				);
			}
			const sql = a.generateVacuum
				? a.generateVacuum(tableName, schemaName, options)
				: generateVacuumSQL(tableName, schemaName, options);
			await a.executeDDL?.(sql);
		},

		async alterColumn(
			column: string,
			options: AlterColumnOptions,
		): Promise<void> {
			validateIdentifier(tableName, 'table');
			validateIdentifier(column, 'column');
			const a = requireAdapter();
			const sql = a.generateAlterColumn
				? a.generateAlterColumn(tableName, column, options, schemaName)
				: generateAlterColumnSQL(tableName, column, schemaName, options);
			await a.executeDDL?.(sql);
		},

		indexes: buildIndexAPI(tableName, schemaName, adapter, requireAdapter),

		async storageSize(): Promise<number> {
			if (!adapter) {
				throw new InvalidOperationError(
					'storageSize',
					'storageSize() requires an adapter.',
				);
			}
			if (!adapter.storageSize) {
				throw new InvalidOperationError(
					'storageSize',
					'storageSize() requires an adapter that implements storageSize().',
				);
			}
			return adapter.storageSize(tableName, schemaName);
		},
	};
}

/**
 * Wrap a tables proxy (from createTablesProxy or schema.tables) with DDL methods.
 * The returned proxy intercepts property access on each table name and augments
 * the returned TableRef object with a `TableDDL` mixin.
 */
export function wrapTablesProxyWithDDL(
	tablesProxy: object,
	adapter: Adapter<unknown> | undefined,
	schemaName: string | undefined,
): object {
	// Cache augmented table objects to preserve referential equality
	const cache = new Map<string, object>();

	return new Proxy(tablesProxy, {
		get(target, prop, receiver) {
			// Pass through Symbol and non-string properties unchanged
			if (typeof prop !== 'string') {
				return Reflect.get(target, prop, receiver);
			}

			if (cache.has(prop)) {
				return cache.get(prop);
			}

			const tableRef = Reflect.get(target, prop, receiver);
			if (tableRef === undefined || tableRef === null) {
				return tableRef;
			}

			// Augment the TableRef with DDL methods
			const ddl = buildTableDDL(prop, schemaName, adapter);
			const augmented = Object.assign(Object.create(null), tableRef, ddl);
			cache.set(prop, augmented);
			return augmented;
		},
	});
}

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
		hookStore,
		onHookError,
		inTransaction,
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

	// Context bag for QueryBuilderImpl — eliminates the 12-param positional constructor
	const queryCtx: QueryBuilderContext = {
		model,
		strictMode,
		...(adapter !== undefined ? { adapter: adapter as Adapter<unknown> } : {}),
		...(schemaName !== undefined ? { schemaName } : {}),
		...(dialectCapabilities !== undefined ? { dialectCapabilities } : {}),
		...(globalPlanOptions !== undefined
			? { planOptionsOverride: globalPlanOptions }
			: {}),
		...(defaultFilters !== undefined ? { defaultFilters } : {}),
		...(hookStore !== undefined ? { hookStore } : {}),
		...(onHookError !== undefined ? { onHookError } : {}),
		...(inTransaction !== undefined ? { inTransaction } : {}),
	};

	// Wrap the tables proxy to augment each table access with DDL methods
	const tablesDDLProxy = wrapTablesProxyWithDDL(
		tablesProxy ?? {},
		adapter as Adapter<unknown> | undefined,
		schemaName,
	);

	return {
		strictMode,
		nql,
		tables: tablesDDLProxy as OrmInstance<DB>['tables'],
		// biome-ignore lint/suspicious/noExplicitAny: polymorphic constraint — TTable is inferred by callers; TableRef generics are statically erased in this implementation signature
		from<TTable extends TableRef<any, any, any>>(
			table: TTable | BatchValuesRef,
		):
			| QueryBuilder<InferTableRow<TTable>>
			| QueryBuilder<Record<string, unknown>> {
			// BatchValuesRef path
			if (
				typeof table === 'object' &&
				table !== null &&
				'__kind' in table &&
				(table as unknown as BatchValuesRef).__kind === 'batchValues'
			) {
				const bv = table as unknown as BatchValuesRef;
				const builder = new QueryBuilderImpl<Record<string, unknown>>(
					queryCtx,
					bv.alias,
					relationHints,
				);
				builder.batchValuesSource = {
					data: bv.data,
					columns: bv.columns,
					types: bv.types,
					alias: bv.alias,
					ordinality: bv.ordinality,
				};
				return builder;
			}
			const tableRef = table as TTable;
			const tableName = tableRef[TABLE_META];
			if (tableName === undefined) {
				throw new Error('Invalid TableRef: missing TABLE_META symbol');
			}
			return new QueryBuilderImpl<InferTableRow<TTable>>(
				queryCtx,
				tableName as string,
				relationHints,
			);
		},
		select<K extends keyof DB & string, TResult = DB[K]>(
			from: K,
		): QueryBuilder<TResult> {
			return new QueryBuilderImpl<TResult>(
				queryCtx,
				from as string,
				relationHints,
			);
		},
		withSchema(schemaName: string): OrmInstanceInternal<DB> {
			// Always validate schema name — even without an adapter — to prevent injection
			validateIdentifier(schemaName, 'schema');
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

			// FIND-001: Validate table against known tables before use in error messages
			if (!model.getTable(table)) {
				throw new InvalidOperationError('listAncestors', 'Table not found');
			}

			// FIND-007: Cap maxDepth to prevent infinite/excessive recursion.
			// Use isSafeInteger to reject fractional values (e.g. 1.5) that
			// Number.isFinite would accept.
			const MAX_RECURSION_DEPTH = 1000;
			const rawMaxDepth = options.maxDepth ?? 100;
			if (!Number.isSafeInteger(rawMaxDepth) || rawMaxDepth < 1) {
				throw new InvalidOperationError(
					'listAncestors',
					'maxDepth must be a positive safe integer',
				);
			}
			const safeMaxDepth = Math.min(rawMaxDepth, MAX_RECURSION_DEPTH);

			// Find the self-referential relation that matches the parent direction
			const selfRefRelation = findSelfRefRelation(model, table, 'ancestors');
			if (!selfRefRelation) {
				throw new InvalidOperationError(
					'listAncestors',
					'Table has no self-referential belongsTo/hasOne relation for ancestor traversal',
				);
			}

			const nodeIdCol = options.nodeId ?? 'id';

			// Hierarchy helpers historically did NOT propagate inTransaction. Preserve that behavior.
			const { inTransaction: _ignored, ...hierarchyCtxBase } = queryCtx;
			const hierarchyCtx: QueryBuilderContext = hierarchyCtxBase;

			const builder = new QueryBuilderImpl<TResult>(
				hierarchyCtx,
				table,
				relationHints,
			);

			const result = await builder
				.where(eq(nodeIdCol, nodeIdValue))
				.include(selfRefRelation.name, {
					recursive: true,
					direction: 'ancestors',
					flat: true,
					omitSelf: true,
					maxDepth: safeMaxDepth,
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

			// FIND-001: Validate table against known tables before use in error messages
			if (!model.getTable(table)) {
				throw new InvalidOperationError('listDescendants', 'Table not found');
			}

			// FIND-007: Cap maxDepth to prevent infinite/excessive recursion.
			// Use isSafeInteger to reject fractional values (e.g. 1.5) that
			// Number.isFinite would accept.
			const MAX_RECURSION_DEPTH = 1000;
			const rawMaxDepth = options.maxDepth ?? 100;
			if (!Number.isSafeInteger(rawMaxDepth) || rawMaxDepth < 1) {
				throw new InvalidOperationError(
					'listDescendants',
					'maxDepth must be a positive safe integer',
				);
			}
			const safeMaxDepth = Math.min(rawMaxDepth, MAX_RECURSION_DEPTH);

			// Find the self-referential relation that matches the children direction
			const selfRefRelation = findSelfRefRelation(model, table, 'descendants');
			if (!selfRefRelation) {
				throw new InvalidOperationError(
					'listDescendants',
					'Table has no self-referential hasMany relation for descendant traversal',
				);
			}

			const nodeIdCol = options.nodeId ?? 'id';

			// Hierarchy helpers historically did NOT propagate inTransaction. Preserve that behavior.
			const { inTransaction: _ignored, ...hierarchyCtxBase } = queryCtx;
			const hierarchyCtx: QueryBuilderContext = hierarchyCtxBase;

			const builder = new QueryBuilderImpl<TResult>(
				hierarchyCtx,
				table,
				relationHints,
			);

			const result = await builder
				.where(eq(nodeIdCol, nodeIdValue))
				.include(selfRefRelation.name, {
					recursive: true,
					direction: 'descendants',
					flat: true,
					omitSelf: true,
					maxDepth: safeMaxDepth,
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

		// biome-ignore lint/suspicious/noExplicitAny: polymorphic constraint — TTable is inferred by callers; TableRef generics are statically erased in this implementation signature
		into<TTable extends TableRef<any, any, any>>(
			tableRef: TTable,
		): InsertBuilder<InferTableRow<TTable>> {
			const tableName = tableRef[TABLE_META];
			if (tableName === undefined) {
				throw new Error('Invalid TableRef: missing TABLE_META symbol');
			}
			return new InsertBuilder({
				table: tableName as string,
				...mutationOpts,
			}) as InsertBuilder<InferTableRow<TTable>>;
		},

		// biome-ignore lint/suspicious/noExplicitAny: polymorphic constraint — TTable is inferred by callers; TableRef generics are statically erased in this implementation signature
		modify<TTable extends TableRef<any, any, any>>(
			tableRef: TTable,
		): UpdateBuilder<InferTableRow<TTable>> {
			const tableName = tableRef[TABLE_META];
			if (tableName === undefined) {
				throw new Error('Invalid TableRef: missing TABLE_META symbol');
			}
			return new UpdateBuilder({
				table: tableName as string,
				...mutationOpts,
			}) as UpdateBuilder<InferTableRow<TTable>>;
		},

		// biome-ignore lint/suspicious/noExplicitAny: polymorphic constraint — TTable is inferred by callers; TableRef generics are statically erased in this implementation signature
		removeFrom<TTable extends TableRef<any, any, any>>(
			tableRef: TTable,
		): DeleteBuilder<InferTableRow<TTable>> {
			const tableName = tableRef[TABLE_META];
			if (tableName === undefined) {
				throw new Error('Invalid TableRef: missing TABLE_META symbol');
			}
			return new DeleteBuilder({
				table: tableName as string,
				...mutationOpts,
			}) as DeleteBuilder<InferTableRow<TTable>>;
		},

		// biome-ignore lint/suspicious/noExplicitAny: polymorphic constraint — TTable is inferred by callers; TableRef generics are statically erased in this implementation signature
		upsertInto<TTable extends TableRef<any, any, any>>(
			tableRef: TTable,
		): UpsertBuilder<InferTableRow<TTable>> {
			const tableName = tableRef[TABLE_META];
			if (tableName === undefined) {
				throw new Error('Invalid TableRef: missing TABLE_META symbol');
			}
			return new UpsertBuilder({
				table: tableName as string,
				...mutationOpts,
			}) as UpsertBuilder<InferTableRow<TTable>>;
		},

		// =====================================================================
		// Mutation Methods (DX-010)
		// =====================================================================

		insert(table: string): InsertBuilder {
			validateIdentifier(table, 'table');
			return new InsertBuilder({ table, ...mutationOpts });
		},

		update(table: string): UpdateBuilder {
			validateIdentifier(table, 'table');
			return new UpdateBuilder({ table, ...mutationOpts });
		},

		delete(table: string): DeleteBuilder {
			validateIdentifier(table, 'table');
			return new DeleteBuilder({ table, ...mutationOpts });
		},

		updateAll(table: string): UpdateBuilder {
			validateIdentifier(table, 'table');
			return new UpdateBuilder({ table, allowAll: true, ...mutationOpts });
		},

		deleteAll(table: string): DeleteBuilder {
			validateIdentifier(table, 'table');
			return new DeleteBuilder({ table, allowAll: true, ...mutationOpts });
		},

		// DX-026: Upsert support
		upsert(table: string): UpsertBuilder {
			validateIdentifier(table, 'table');
			return new UpsertBuilder({ table, ...mutationOpts });
		},

		// =====================================================================
		// Transaction Methods (DX-025)
		// =====================================================================

		// NOT `async`, and that is load-bearing. An async method awaits whatever it
		// returns and re-wraps it in a fresh Promise — which would mean the language
		// itself attaches to the adapter's promise, and an adapter that needs to know
		// whether the CALLER awaited a nested transaction would see every one of them
		// as awaited, by core, before the caller ever touched it. So the adapter's
		// promise is passed through untouched. The guards still reject rather than
		// throwing synchronously, because that is what callers already rely on.
		transaction<T>(fn: (tx: OrmInstance<DB>) => Promise<T>): Promise<T> {
			if (!adapter) {
				return Promise.reject(
					new Error(
						'transaction() requires an adapter. ' +
							'Pass an adapter when creating the ORM.',
					),
				);
			}

			if (!supportsTransactions<DB>(adapter)) {
				return Promise.reject(createUnsupportedTransactionError());
			}

			// Passthrough to adapter's transaction API.
			//
			// The try/catch is not decoration. This method is NOT async (see above), so
			// an adapter throwing synchronously out of transaction() would throw
			// synchronously out of here — and a method typed `Promise<T>` must reject
			// rather than throw, or `.catch()` and `await expect(...).rejects` stop
			// working on it. The async wrapper converted that for free; dropping it to
			// keep the adapter's promise identity means converting it by hand.
			//
			// The promise itself is still returned untouched. Only a synchronous throw
			// becomes a rejection.
			try {
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
			} catch (error) {
				return Promise.reject(error);
			}
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

		batchValues(
			data: readonly unknown[][],
			columns: readonly string[],
			types: readonly string[],
			opts?: BatchValuesOptions,
		): BatchValuesRef {
			return batchValues(data, columns, types, opts);
		},

		selectExpression(expr: ExpressionSpec): SelectExpressionResult {
			if (!adapter) {
				throw new Error(
					'selectExpression() requires an adapter. ' +
						'Pass an adapter when creating the ORM.',
				);
			}
			const compiled = adapter.compileSelectExpression(expr.intent);
			return {
				sql: compiled.sql,
				parameters: compiled.parameters,
				execute<T = unknown>(): Promise<T[]> {
					return adapter?.executeRaw<T>(compiled.sql, compiled.parameters);
				},
			};
		},

		withCte(name: string): CteBuilder {
			return new CteBuilder(name, adapter, schemaName);
		},

		recursive<TResult = unknown>(
			name: string,
			options: RecursiveOptions,
		): RawCteQueryBuilder<TResult> {
			return createRawCteBuilder<TResult>(name, options, adapter, schemaName);
		},

		// =====================================================================
		// Global DDL Shortcuts (F-005)
		// =====================================================================

		ddl: {
			/**
			 * Drop an index by name (not table-scoped).
			 *
			 * @param name - Index name to drop
			 * @param options - Optional DROP INDEX options
			 */
			async dropIndex(name: string, options?: DropIndexOptions): Promise<void> {
				if (!adapter?.executeDDL) {
					throw new InvalidOperationError(
						'ddl.dropIndex',
						'executeDDL() requires an adapter that supports DDL execution.',
					);
				}
				// The table-scoped `.indexes.drop()` refuses this; so must the global
				// shortcut. PostgreSQL cannot run DROP INDEX CONCURRENTLY inside a
				// transaction block, and reaching the database to be told so aborts the
				// transaction you were in.
				if (options?.concurrently && adapter.inTransaction) {
					throw new InvalidOperationError(
						'dropIndex',
						'DROP INDEX CONCURRENTLY cannot run inside a transaction block',
					);
				}
				// FIND-003: Validate index name and optional schema before building SQL
				validateIdentifier(name, 'index');
				const sc = options?.schema ?? schemaName;
				if (sc) {
					validateIdentifier(sc, 'schema');
				}
				// `sc` resolves the ORM's schema scope, and the adapter must be given it:
				// passing only the caller's options drops `withSchema('tenant')` on the
				// floor and leaves PostgreSQL to resolve the name through search_path —
				// which, in a multi-tenant database, can drop an index in another schema.
				const scopedOptions: DropIndexOptions | undefined = sc
					? { ...options, schema: sc }
					: options;
				const sql = adapter.generateDropIndex
					? adapter.generateDropIndex(name, scopedOptions)
					: (() => {
							const parts: string[] = ['DROP INDEX'];
							if (options?.concurrently) parts.push('CONCURRENTLY');
							if (options?.ifExists) parts.push('IF EXISTS');
							parts.push(
								sc
									? `"${sc.replace(/"/g, '""')}"."${name.replace(/"/g, '""')}"`
									: `"${name.replace(/"/g, '""')}"`,
							);
							if (options?.cascade) parts.push('CASCADE');
							return parts.join(' ');
						})();
				await adapter.executeDDL(sql);
			},
		},
	};
}
