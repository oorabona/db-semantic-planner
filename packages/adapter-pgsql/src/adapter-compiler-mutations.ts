/**
 * Mutation compilation: INSERT, UPDATE, DELETE, UPSERT.
 * Extracted from PgsqlAdapter.compileInsert/Update/Delete/Upsert/etc.
 *
 * @internal
 */

import {
	InvalidOperationError,
	isSqlRaw,
	POSTGRESQL_CAPABILITIES,
	plan as planFn,
} from '@dbsp/core';
import type {
	BatchUpdateIntent,
	CompiledQuery,
	CompileOptions,
	DeleteIntent,
	InsertFromIntent,
	InsertIntent,
	QueryIntent,
	UpdateIntent,
	UpsertFromIntent,
	UpsertIntent,
	WhereIntent,
} from '@dbsp/types';
import { toColumnList } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import type { AdapterCompilerDeps } from './adapter-compiler-deps.js';
import { compileSelect } from './adapter-compiler-select.js';
import {
	emittedBindName,
	hasBindingName,
	queryScope,
	relationBinding,
	withBindingName,
} from './binding-registry.js';
import {
	buildSubqueryFromIntent,
	compileWhereIntent,
	type WhereCompilerCtx,
} from './compile-where.js';
import { buildCustomFnFilter } from './compiler.js';
import {
	transposeToColumnArrays,
	validateBatchCardinality,
} from './compiler-utils.js';
import {
	dbTypeCastTarget,
	renderColumnDbType,
	validateDbType,
} from './db-type.js';
import { quoteIdent } from './ddl/phases/utils.js';
import { deparseQuoted } from './deparse.js';
import {
	type CompilerContext,
	createCompilerState,
	type Decision,
} from './handlers/index.js';
import {
	type BatchUpdateConfig,
	compileDelete as compileDeleteMutation,
	compileInsertFrom as compileInsertFromMutation,
	compileInsert as compileInsertMutation,
	compileUnnestInsert as compileUnnestInsertMutation,
	compileUnnestUpdate as compileUnnestUpdateMutation,
	compileUnnestUpsert as compileUnnestUpsertMutation,
	compileUpdate as compileUpdateMutation,
	compileUpsertFrom as compileUpsertFromMutation,
	compileUpsert as compileUpsertMutation,
	type DeleteConfig,
	type InsertConfig,
	type InsertFromConfig,
	type MutationColumnAddress,
	type MutationColumnMetadata,
	type MutationTableMetadata,
	type UpdateConfig,
	type UpsertConfig,
	type UpsertFromConfig,
} from './mutations/index.js';
import {
	finalizeEnvelope,
	fromAstProjection,
	type ProjectionEnvelope,
	preserveOneToOne,
} from './projection-envelope.js';
import { MAX_DEPTH_LIMIT } from './recursive/cte-compiler.js';
import {
	queryLocal,
	resolveDeclaredIdentifier,
	type SqlIdentifier,
} from './sql-identifier.js';

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Bridge a WhereIntent into a Decision for mutation config.
 * The WHERE dispatcher's `normalizeToDecision` handles the actual
 * `kind`/`field` → `type`/`column`/`operator` conversion at runtime.
 */
function whereIntentAsDecision(where: WhereIntent): Decision {
	return where as never as Decision;
}

function renumberSqlParams(sql: string, offset: number): string {
	if (offset === 0) return sql;
	return sql.replace(/\$(\d+)/g, (_match, num) => {
		return `$${Number.parseInt(num, 10) + offset}`;
	});
}

type SourceCteFragment = {
	readonly sql: string;
	readonly parameters: readonly unknown[];
};

function compileSourceQueryCte(
	operation: 'compileInsertFrom' | 'compileUpsertFrom',
	sourceName: string,
	sourceQuery: QueryIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): SourceCteFragment {
	const model = deps.model;
	if (model === undefined) {
		throw new Error(
			`${operation} with sourceQuery requires a model to emit the source CTE for '${sourceName}'.`,
		);
	}
	const sourcePlan = planFn(sourceQuery, model, {
		dialectCapabilities: deps.dialectCapabilities ?? POSTGRESQL_CAPABILITIES,
	});
	const source = compileSelect(sourcePlan, options, deps);
	return {
		sql: source.sql,
		parameters: source.parameters,
	};
}

function compileMutationEnvelope(
	ast: Node,
	rootTable: string,
	state: ReturnType<typeof createCompilerState>,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): ProjectionEnvelope {
	const sql = deparseQuoted(ast);
	return fromAstProjection({
		sql,
		parameters: state.parameters,
		ast,
		rootTable,
		model: options?.model ?? deps.model,
		...(deps.declaredNames !== undefined && {
			declaredNames: deps.declaredNames,
		}),
	});
}

function compileMutationQuery(
	ast: Node,
	rootTable: string,
	state: ReturnType<typeof createCompilerState>,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	return finalizeEnvelope(
		compileMutationEnvelope(ast, rootTable, state, options, deps),
	);
}

function prependSourceCte(
	query: ProjectionEnvelope,
	sourceName: string,
	sourceCte: SourceCteFragment | undefined,
): CompiledQuery {
	if (sourceCte === undefined) {
		return finalizeEnvelope(query);
	}
	const cteParamCount = sourceCte.parameters.length;
	const sourceCteName = emittedBindName(queryLocal(sourceName));
	return finalizeEnvelope(
		preserveOneToOne(query, {
			sql: `WITH ${quoteIdent(sourceCteName, 'alias')} as (${sourceCte.sql}) ${renumberSqlParams(query.sql, cteParamCount)}`,
			parameters: [...sourceCte.parameters, ...query.parameters],
		}),
	);
}

function declaredMutationTable(
	deps: AdapterCompilerDeps,
	table: string,
): SqlIdentifier {
	return resolveDeclaredIdentifier(
		deps.declaredNames,
		deps.dbCasing ?? 'preserve',
		{
			kind: 'table',
			table,
		},
	);
}

function declaredMutationTableMetadata(
	deps: AdapterCompilerDeps,
	logicalTable: string,
): MutationTableMetadata {
	return {
		logicalTable,
		physicalName: declaredMutationTable(deps, logicalTable),
	};
}

function declaredMutationColumn(
	deps: AdapterCompilerDeps,
	table: string,
	column: string,
): SqlIdentifier {
	return resolveDeclaredIdentifier(
		deps.declaredNames,
		deps.dbCasing ?? 'preserve',
		{
			kind: 'column',
			table,
			column,
		},
	);
}

function declaredMutationColumnAddress(
	deps: AdapterCompilerDeps,
	logicalTable: string,
	logicalColumn: string,
): MutationColumnAddress {
	return {
		logicalTable,
		logicalColumn,
		physicalName: declaredMutationColumn(deps, logicalTable, logicalColumn),
	};
}

function mutationBinding(deps: AdapterCompilerDeps, table: string) {
	if (
		hasBindingName(deps.bindingNames, table) ||
		(deps.declaredNames !== undefined &&
			deps.declaredNames.table(table) === undefined)
	) {
		return relationBinding({ qualifier: queryLocal(table), kind: 'cte-bind' });
	}
	return relationBinding({
		qualifier: declaredMutationTable(deps, table),
		kind: 'declared-table',
		logicalTable: table,
	});
}

function mutationSourceColumn(
	deps: AdapterCompilerDeps,
	binding: ReturnType<typeof mutationBinding>,
	logicalTable: string,
	column: string,
): SqlIdentifier {
	if (binding.kind !== 'declared-table') return queryLocal(column);
	return declaredMutationColumn(deps, logicalTable, column);
}

function mutationReturningSources(
	deps: AdapterCompilerDeps,
	table: string,
	returning: readonly string[],
	items: readonly { source: string }[] | undefined,
): SqlIdentifier[] {
	return (items?.map((item) => item.source) ?? returning).map((column) =>
		column === '*'
			? queryLocal(column)
			: declaredMutationColumn(deps, table, column),
	);
}

function mutationContext(
	deps: AdapterCompilerDeps,
	rootTable: string,
	maxRecursiveDepth: number,
): CompilerContext {
	const binding = mutationBinding(deps, rootTable);
	return {
		...deps,
		rootTable,
		scope: deps.scope ?? queryScope([binding]),
		...(deps.schemaName !== undefined && { schema: deps.schemaName }),
		maxRecursiveDepth,
		compileCustomFnFilter: buildCustomFnFilter,
	} as CompilerContext;
}

function resolveMutationExistsForeignKey(
	foreignKey: string | readonly string[] | undefined,
	relationName: string,
): readonly string[] | undefined {
	const columns = toColumnList(foreignKey);
	if (columns.length === 0) return undefined;
	if (columns.some((column) => column.length === 0)) {
		throw new Error(
			`Mutation exists()/notExists() guard relation '${relationName}' has an empty foreignKey column.`,
		);
	}
	return columns;
}

/**
 * Resolve relation metadata for an exists/notExists WHERE condition.
 *
 * `notExists('symbol')` carries `relation: 'symbol'` (the logical relation name).
 * The mutation path bypasses the planner, so `normalizeToDecision` sets
 * `targetTable: relation` — using 'symbol' as the table name instead of 'symbols'.
 *
 * This helper looks up `sourceTable.relation` in ModelIR and returns:
 * - `targetTable`: real DB table name (e.g. 'symbols' for relation 'symbol')
 * - `sourceColumn`: FK column on the root table for `belongsTo` (e.g. 'symbol_id')
 * - `targetColumn`: PK on the target table for belongsTo, FK on the target table for hasMany/hasOne
 *
 * Falls back gracefully when ModelIR is unavailable or relation not found.
 */
function resolveExistsRelation(
	sourceTable: string,
	relation: string,
	model: import('@dbsp/types').ModelIR | undefined,
): {
	targetTable: string;
	sourceColumn?: string | readonly string[];
	targetColumn?: string | readonly string[];
} {
	if (!model) return { targetTable: relation };
	const relationName = `${sourceTable}.${relation}`;
	const rel = model.getRelation(relationName);
	if (!rel) return { targetTable: relation };
	const targetTable = rel.target;
	// For belongsTo: FK is on the source table (e.g. embeddings.symbol_id → symbols.id)
	if (rel.type === 'belongsTo') {
		const fk = resolveMutationExistsForeignKey(rel.foreignKey, relationName);
		return {
			targetTable,
			...(fk !== undefined && { sourceColumn: fk }),
			targetColumn:
				toColumnList(rel.targetKey).length > 0
					? toColumnList(rel.targetKey)
					: ['id'],
		};
	}
	// For hasMany/hasOne: FK is on the target table (e.g. symbols.id → calls.callee_id)
	const fk = resolveMutationExistsForeignKey(rel.foreignKey, relationName);
	return {
		targetTable,
		sourceColumn:
			toColumnList(rel.sourceKey).length > 0
				? toColumnList(rel.sourceKey)
				: ['id'],
		...(fk !== undefined && { targetColumn: fk }),
	};
}

/**
 * Enrich an exists/notExists WhereIntent with the resolved `targetTable`,
 * `sourceColumn`, and `targetColumn` so that `buildExistsSubquery` correlates
 * the subquery using the correct FK columns instead of convention-based defaults.
 */
function resolveExistsIntent(
	where: WhereIntent,
	sourceTable: string,
	deps: AdapterCompilerDeps,
): WhereIntent {
	const w = where as unknown as Record<string, unknown>;
	const kind = w.kind as string | undefined;

	// Recursively walk and/or/not branches so nested exists/notExists are enriched
	if (kind === 'and' || kind === 'or') {
		const conditions = w.conditions as WhereIntent[] | undefined;
		if (!conditions) return where;
		const enriched = conditions.map((c) =>
			resolveExistsIntent(c, sourceTable, deps),
		);
		const changed = enriched.some((c, i) => c !== conditions[i]);
		return changed
			? ({ ...w, conditions: enriched } as unknown as WhereIntent)
			: where;
	}
	if (kind === 'not') {
		const condition = w.condition as WhereIntent | undefined;
		if (!condition) return where;
		const enriched = resolveExistsIntent(condition, sourceTable, deps);
		return enriched !== condition
			? ({ ...w, condition: enriched } as unknown as WhereIntent)
			: where;
	}

	if (kind !== 'exists' && kind !== 'notExists') return where;
	const relation = w.relation as string;
	const resolved = resolveExistsRelation(sourceTable, relation, deps.model);
	const nestedWhere = w.where as WhereIntent | undefined;
	const enrichedNestedWhere =
		nestedWhere !== undefined
			? resolveExistsIntent(nestedWhere, resolved.targetTable, deps)
			: undefined;
	// Only enrich if we resolved to a different name (avoid mutation when model absent)
	if (
		resolved.targetTable === relation &&
		!resolved.sourceColumn &&
		!resolved.targetColumn &&
		enrichedNestedWhere === nestedWhere
	) {
		return where;
	}
	return {
		...w,
		targetTable: resolved.targetTable,
		...(resolved.sourceColumn !== undefined && {
			sourceColumn: resolved.sourceColumn,
		}),
		...(resolved.targetColumn !== undefined && {
			targetColumn: resolved.targetColumn,
		}),
		...(enrichedNestedWhere !== undefined && { where: enrichedNestedWhere }),
	} as unknown as WhereIntent;
}

/**
 * Build addressed column metadata for a table, keyed by emitted physical name.
 * Logical model lookup happens before that key is built, so the SQL compiler
 * never asks a logical map for a physical identifier.
 * `inferPgArrayType` uses the resolved database type for schema-driven casts.
 * Prefers `originalDbType` when set (preserves precision info from introspection).
 * Returns undefined if no columns found (or model unavailable).
 */
function getColumnTypes(
	tableName: string,
	columns: string[],
	deps: AdapterCompilerDeps,
	unnestedColumns: ReadonlySet<string> = new Set(),
): Record<string, MutationColumnMetadata> | undefined {
	if (!deps.model) return undefined;
	const table = deps.model.getTable(tableName);
	if (!table) return undefined;
	const columnsByName = new Map(
		table.columns.map((column) => [column.name, column]),
	);
	let result: Record<string, MutationColumnMetadata> | undefined;
	const targetSchema = deps.schemaName;
	for (const col of columns) {
		const columnIR = columnsByName.get(col);
		if (columnIR) {
			result ??= {};
			// Prefer originalDbType over ColumnType, resolved to a safe cast target.
			// Validate the FULL originalDbType before deriving the cast target:
			// dbTypeCastTarget strips the modifier for bounded built-ins, so a
			// malformed input like numeric(foo) would otherwise be reduced to a
			// valid `numeric` and slip past validation. A defined-but-empty
			// originalDbType is treated as absent (fall back to ColumnType).
			const authored = columnIR.originalDbType?.trim();
			const castTarget =
				authored !== undefined && authored !== ''
					? dbTypeCastTarget(
							validateDbType(renderColumnDbType(columnIR, targetSchema)),
						)
					: columnIR.type;
			// The batch path unnests a single-dimension array parameter into rows.
			// unnest FLATTENS a multi-dimensional array, so a column whose type is
			// itself an array cannot be batch-inserted via unnest — fail loud with a
			// clear message instead of emitting SQL PostgreSQL rejects at runtime.
			if (unnestedColumns.has(col) && castTarget.trim().endsWith('[]')) {
				throw new Error(
					`Batch mutation of array-typed column '${col}' (${castTarget}) is not supported: unnest flattens multi-dimensional arrays. Set batchThreshold to at least the batch size to use VALUES, or use single-row mutations for array columns.`,
				);
			}
			// Mutation compiler columns are physical identifiers. Keep the cast map
			// in that same SQL namespace after looking up the logical model column.
			const physicalName = declaredMutationColumn(deps, tableName, col);
			result[physicalName] = {
				logicalTable: tableName,
				logicalColumn: col,
				physicalName,
				databaseType: castTarget,
			};
		}
	}
	return result;
}

function compileUpsertActionWhere(
	where: WhereIntent,
	table: string,
	state: ReturnType<typeof createCompilerState>,
	deps: AdapterCompilerDeps,
	schemaName: string | undefined,
): import('@pgsql/types').Node {
	const whereCtx: WhereCompilerCtx = {
		rootTable: table,
		aliases: new Map<string, string>(),
		paramState: state,
		...(schemaName !== undefined && { schemaName }),
		...(deps.bindingNames !== undefined && { bindingNames: deps.bindingNames }),
		...(deps.scope !== undefined && { scope: deps.scope }),
		dbCasing: deps.dbCasing ?? 'preserve',
		...(deps.relationTargetProjections !== undefined && {
			relationTargetProjections: deps.relationTargetProjections,
		}),
		...(deps.declaredNames !== undefined && {
			declaredNames: deps.declaredNames,
		}),
		...(deps.model !== undefined && { model: deps.model }),
		...(deps.dialectCapabilities !== undefined && {
			dialectCapabilities: deps.dialectCapabilities,
		}),
		compileSubquery: (sqIntent, paramOffset) =>
			buildSubqueryFromIntent(
				sqIntent,
				paramOffset,
				deps.declaredNames,
				schemaName,
				'rawExists',
				deps.scope,
				deps.dialectCapabilities,
				deps.dbCasing,
			),
	};
	return compileWhereIntent(where, whereCtx);
}

// ============================================================================
// compileInsert
// ============================================================================

/**
 * Compile an insert intent to executable SQL.
 *
 * Strategy switch (per CompileOptions):
 * - rows <= batchThreshold (default 50): VALUES ($1,$2),($3,$4),...
 * - rows > batchThreshold OR batchThreshold === 0: SELECT unnest($1::type[]),...
 *
 * Extracted body of PgsqlAdapter.compileInsert().
 */
export function compileInsert(
	intent: InsertIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	// schemaName precedence (options > adapter ctor) is resolved in PgsqlAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const ctx = mutationContext(deps, intent.table, MAX_DEPTH_LIMIT);
	const state = createCompilerState();

	const firstRow = intent.values?.[0] ?? {};
	const columns = Object.keys(firstRow);
	const rows = intent.values ?? [];
	const values = rows.map((row) => columns.map((col) => row[col]));
	const batchThreshold = options?.batchThreshold ?? 50;
	const useUnnest =
		values.length > 0 &&
		(batchThreshold === 0 || values.length > batchThreshold);
	const columnTypes = getColumnTypes(
		intent.table,
		columns,
		deps,
		useUnnest ? new Set(columns) : undefined,
	);

	const config: InsertConfig = {
		table: declaredMutationTable(deps, intent.table),
		tableMetadata: declaredMutationTableMetadata(deps, intent.table),
		columns: columns.map((column) =>
			declaredMutationColumn(deps, intent.table, column),
		),
		values,
		...(intent.returning && { returning: [...intent.returning] }),
		...(intent.returning && {
			returningSources: mutationReturningSources(
				deps,
				intent.table,
				intent.returning,
				intent.returningItems,
			),
		}),
		...(intent.returningItems && { returningItems: intent.returningItems }),
		...(columnTypes && { columnTypes }),
	};

	// maxBatchSize guard (INV-07)
	const maxBatchSize = options?.maxBatchSize;
	if (maxBatchSize !== undefined && values.length > maxBatchSize) {
		throw new InvalidOperationError(
			'insert',
			`Batch size ${values.length} exceeds maxBatchSize ${maxBatchSize}`,
		);
	}

	// Strategy switch: unnest for large batches, VALUES for small (INV-03)
	const ast = useUnnest
		? compileUnnestInsertMutation(config, ctx, state)
		: compileInsertMutation(config, ctx, state);
	return compileMutationQuery(ast, intent.table, state, options, deps);
}

// ============================================================================
// compileInsertFrom
// ============================================================================

/**
 * Compile an insert-from intent to executable SQL (NQL-ALIGN).
 * INSERT INTO target (cols) SELECT cols FROM source WHERE ... LIMIT ... RETURNING ...
 * Extracted body of PgsqlAdapter.compileInsertFrom().
 */
export function compileInsertFrom(
	intent: InsertFromIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	// schemaName precedence (options > adapter ctor) is resolved in PgsqlAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const sourceCte =
		intent.sourceQuery !== undefined &&
		!hasBindingName(deps.bindingNames, intent.source)
			? compileSourceQueryCte(
					'compileInsertFrom',
					intent.source,
					intent.sourceQuery,
					options,
					deps,
				)
			: undefined;
	const bindingNames =
		intent.sourceQuery !== undefined
			? withBindingName(deps.bindingNames, queryLocal(intent.source))
			: deps.bindingNames;

	const ctx = mutationContext(
		{ ...deps, ...(bindingNames !== undefined && { bindingNames }) },
		intent.source,
		MAX_DEPTH_LIMIT,
	);
	const state = createCompilerState();
	const resolvedWhere = intent.where
		? resolveExistsIntent(intent.where, intent.source, deps)
		: undefined;

	const sourceBinding = mutationBinding(
		{ ...deps, ...(bindingNames !== undefined && { bindingNames }) },
		intent.source,
	);
	const config: InsertFromConfig = {
		targetTable: declaredMutationTable(deps, intent.table),
		targetTableMetadata: declaredMutationTableMetadata(deps, intent.table),
		source: sourceBinding,
		...(intent.columns && {
			columns: intent.columns.map((column) => ({
				target: declaredMutationColumn(deps, intent.table, column),
				source: mutationSourceColumn(
					deps,
					sourceBinding,
					intent.source,
					column,
				),
				targetAddress: declaredMutationColumnAddress(
					deps,
					intent.table,
					column,
				),
				...(sourceBinding.kind === 'declared-table' && {
					sourceAddress: declaredMutationColumnAddress(
						deps,
						intent.source,
						column,
					),
				}),
			})),
		}),
		...(resolvedWhere && { where: [whereIntentAsDecision(resolvedWhere)] }),
		...(intent.limit !== undefined && { limit: intent.limit }),
		...(intent.returning && { returning: [...intent.returning] }),
		...(intent.returning && {
			returningSources: mutationReturningSources(
				deps,
				intent.table,
				intent.returning,
				intent.returningItems,
			),
		}),
		...(intent.returningItems && { returningItems: intent.returningItems }),
	};

	const ast = compileInsertFromMutation(config, ctx, state);

	return prependSourceCte(
		compileMutationEnvelope(ast, intent.table, state, options, deps),
		intent.source,
		sourceCte,
	);
}

// ============================================================================
// compileUpdate
// ============================================================================

/**
 * Compile an update intent to executable SQL.
 * Extracted body of PgsqlAdapter.compileUpdate().
 */
export function compileUpdate(
	intent: UpdateIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	// schemaName precedence (options > adapter ctor) is resolved in PgsqlAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const ctx = mutationContext(deps, intent.table, MAX_DEPTH_LIMIT);
	const state = createCompilerState();

	const setColumns = Object.keys(intent.set ?? {});
	const columnTypes = getColumnTypes(intent.table, setColumns, deps);
	const resolvedWhere = intent.where
		? resolveExistsIntent(intent.where, intent.table, deps)
		: undefined;

	const config: UpdateConfig = {
		table: declaredMutationTable(deps, intent.table),
		tableMetadata: declaredMutationTableMetadata(deps, intent.table),
		set: Object.entries(intent.set ?? {}).map(([column, value]) => ({
			column: declaredMutationColumn(deps, intent.table, column),
			value,
		})),
		...(resolvedWhere && { where: [whereIntentAsDecision(resolvedWhere)] }),
		...(intent.returning && { returning: [...intent.returning] }),
		...(intent.returning && {
			returningSources: mutationReturningSources(
				deps,
				intent.table,
				intent.returning,
				intent.returningItems,
			),
		}),
		...(intent.returningItems && { returningItems: intent.returningItems }),
		...(columnTypes && { columnTypes }),
	};

	const ast = compileUpdateMutation(config, ctx, state);
	return compileMutationQuery(ast, intent.table, state, options, deps);
}

// ============================================================================
// compileBatchUpdate
// ============================================================================

/**
 * Compile a batch update intent to executable SQL using unnest FROM strategy (BATCH-001).
 *
 * Generates:
 *   UPDATE "table" SET "update_col" = t."update_col" [, "scalar_col" = $N]
 *   FROM unnest(CAST($1 AS type[]), CAST($2 AS type[])) AS t("match_col", "update_col")
 *   WHERE "table"."match_col" = t."match_col"
 *   [RETURNING ...]
 *
 * Extracted body of PgsqlAdapter.compileBatchUpdate().
 */
export function compileBatchUpdate(
	intent: BatchUpdateIntent,
	_options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	// schemaName precedence (options > adapter ctor) is resolved in PgsqlAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const schemaName = deps.schemaName;
	const ctx = mutationContext(deps, intent.table, MAX_DEPTH_LIMIT);
	const state = createCompilerState();

	if (intent.updates.length === 0) {
		throw new InvalidOperationError(
			'update',
			'batchSet requires at least one row',
		);
	}

	// Extract all columns from the first row
	const allColumns = Object.keys(intent.updates[0]!);
	const matchColumns = [...intent.matchColumns];

	// Validate that all match columns appear in the data
	for (const mc of matchColumns) {
		if (!allColumns.includes(mc)) {
			throw new InvalidOperationError(
				'update',
				`Match column "${mc}" not found in update data. Each row must include the match column(s).`,
			);
		}
	}

	// Build row-major values matrix and validate cardinality
	const values = intent.updates.map((row) => allColumns.map((col) => row[col]));
	validateBatchCardinality(allColumns, values);

	// Transpose to column-major arrays
	const columnArrays = transposeToColumnArrays(allColumns, values);

	// Get column types for type inference
	const columnTypes = getColumnTypes(
		intent.table,
		[...allColumns, ...Object.keys(intent.scalarSet ?? {})],
		deps,
		new Set(allColumns),
	);

	// Build scalar SET entries from scalarSet
	const scalarSet = intent.scalarSet
		? Object.entries(intent.scalarSet).map(([column, value]) => ({
				column,
				value,
			}))
		: undefined;

	// Compile optional WHERE guard (e.g., AND EXISTS(...))
	// The guard uses the shared `state` so $N numbering continues from unnest params.
	let whereGuard: import('@pgsql/types').Node | undefined;
	if (intent.where) {
		const resolvedWhere = resolveExistsIntent(intent.where, intent.table, deps);
		const whereCtx: WhereCompilerCtx = {
			rootTable: intent.table,
			aliases: new Map<string, string>(),
			paramState: state,
			...(schemaName !== undefined && { schemaName }),
			...(deps.bindingNames !== undefined && {
				bindingNames: deps.bindingNames,
			}),
			...(deps.scope !== undefined && { scope: deps.scope }),
			dbCasing: deps.dbCasing ?? 'preserve',
			...(deps.declaredNames !== undefined && {
				declaredNames: deps.declaredNames,
			}),
			...(deps.model !== undefined && { model: deps.model }),
			...(deps.dialectCapabilities !== undefined && {
				dialectCapabilities: deps.dialectCapabilities,
			}),
			compileSubquery: (sqIntent, paramOffset) =>
				buildSubqueryFromIntent(
					sqIntent,
					paramOffset,
					deps.declaredNames,
					schemaName,
					'rawExists',
					deps.scope,
					deps.dialectCapabilities,
					deps.dbCasing,
				),
		};
		whereGuard = compileWhereIntent(resolvedWhere, whereCtx);
	}

	const config: BatchUpdateConfig = {
		table: declaredMutationTable(deps, intent.table),
		tableMetadata: declaredMutationTableMetadata(deps, intent.table),
		matchColumns: matchColumns.map((column) =>
			declaredMutationColumn(deps, intent.table, column),
		),
		allColumns: allColumns.map((column) =>
			declaredMutationColumn(deps, intent.table, column),
		),
		columnArrays,
		...(scalarSet && {
			scalarSet: scalarSet.map(({ column, value }) => ({
				column: declaredMutationColumn(deps, intent.table, column),
				value,
			})),
		}),
		...(intent.returning && { returning: [...intent.returning] }),
		...(intent.returning && {
			returningSources: mutationReturningSources(
				deps,
				intent.table,
				intent.returning,
				intent.returningItems,
			),
		}),
		...(intent.returningItems && { returningItems: intent.returningItems }),
		...(columnTypes && { columnTypes }),
		...(whereGuard !== undefined && { whereGuard }),
	};

	const ast = compileUnnestUpdateMutation(config, ctx, state);
	return compileMutationQuery(ast, intent.table, state, _options, deps);
}

// ============================================================================
// compileDelete
// ============================================================================

/**
 * Compile a delete intent to executable SQL.
 * Extracted body of PgsqlAdapter.compileDelete().
 */
export function compileDelete(
	intent: DeleteIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	// schemaName precedence (options > adapter ctor) is resolved in PgsqlAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const ctx = mutationContext(deps, intent.table, MAX_DEPTH_LIMIT);
	const state = createCompilerState();

	// Resolve exists/notExists relation name → real table name before compiling.
	// The mutation path bypasses the planner, so we must resolve targetTable here.
	const resolvedWhere = intent.where
		? resolveExistsIntent(intent.where, intent.table, deps)
		: undefined;

	const config: DeleteConfig = {
		table: declaredMutationTable(deps, intent.table),
		tableMetadata: declaredMutationTableMetadata(deps, intent.table),
		...(resolvedWhere && { where: [whereIntentAsDecision(resolvedWhere)] }),
		...(intent.returning && { returning: [...intent.returning] }),
		...(intent.returning && {
			returningSources: mutationReturningSources(
				deps,
				intent.table,
				intent.returning,
				intent.returningItems,
			),
		}),
		...(intent.returningItems && { returningItems: intent.returningItems }),
	};

	const ast = compileDeleteMutation(config, ctx, state);
	return compileMutationQuery(ast, intent.table, state, options, deps);
}

// ============================================================================
// compileUpsert
// ============================================================================

/**
 * Compile an upsert intent to executable SQL (DX-026).
 * Extracted body of PgsqlAdapter.compileUpsert().
 */
export function compileUpsert(
	intent: UpsertIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	// schemaName precedence (options > adapter ctor) is resolved in PgsqlAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const schemaName = deps.schemaName;
	const ctx = mutationContext(deps, intent.table, MAX_DEPTH_LIMIT);
	const state = createCompilerState();

	const firstRow = intent.values?.[0] ?? {};

	// Separate raw SQL expressions from scalar set values.
	// Raw expressions are emitted verbatim in ON CONFLICT DO UPDATE SET —
	// they must NOT be merged into INSERT VALUES rows (they are not values).
	// Scalar set values are merged so EXCLUDED.column picks them up.
	const rawExprs: Record<string, string> = {};
	const scalarSet: Record<string, unknown> = {};
	if (intent.action.type === 'doUpdate' && intent.action.set) {
		for (const [key, val] of Object.entries(intent.action.set)) {
			if (isSqlRaw(val)) {
				rawExprs[key] = val.sql;
			} else {
				scalarSet[key] = val;
			}
		}
	}

	// Merge only scalar set values into INSERT VALUES rows so EXCLUDED.column
	// references resolve correctly.
	const hasScalarSet = Object.keys(scalarSet).length > 0;
	const mergedFirstRow = hasScalarSet
		? { ...firstRow, ...scalarSet }
		: firstRow;

	const columns = Object.keys(mergedFirstRow);
	const values = (intent.values ?? []).map((row) => {
		const mergedRow = hasScalarSet ? { ...row, ...scalarSet } : row;
		return columns.map((col) => mergedRow[col]);
	});
	const batchThreshold = options?.batchThreshold ?? 50;
	const useUnnest =
		values.length > 0 &&
		(batchThreshold === 0 || values.length > batchThreshold);

	// Build conflict target
	const conflictTarget: {
		columns?: SqlIdentifier[];
		columnAddresses?: MutationColumnAddress[];
		constraint?: SqlIdentifier;
		constraintAddress?: {
			logicalTable: string;
			logicalConstraint: string;
			physicalName: SqlIdentifier;
		};
	} = {};

	if ('columns' in intent.onConflict) {
		conflictTarget.columns = intent.onConflict.columns.map((column) =>
			declaredMutationColumn(deps, intent.table, column),
		);
		conflictTarget.columnAddresses = intent.onConflict.columns.map((column) =>
			declaredMutationColumnAddress(deps, intent.table, column),
		);
	} else if ('constraint' in intent.onConflict) {
		const physicalName = resolveDeclaredIdentifier(
			deps.declaredNames,
			deps.dbCasing ?? 'preserve',
			{
				kind: 'constraint',
				table: intent.table,
				constraint: intent.onConflict.constraint,
			},
		);
		conflictTarget.constraint = physicalName;
		conflictTarget.constraintAddress = {
			logicalTable: intent.table,
			logicalConstraint: intent.onConflict.constraint,
			physicalName,
		};
	}

	// Build conflict action
	const conflictAction: 'nothing' | 'update' =
		intent.action.type === 'doNothing' ? 'nothing' : 'update';

	// Determine update columns.
	// All columns in intent.action.set are update columns (both scalar and raw).
	// Scalar ones use EXCLUDED.column, raw ones use the parsed SQL expression.
	let updateColumns: SqlIdentifier[] | undefined;
	let logicalUpdateColumns: string[] | undefined;
	if (intent.action.type === 'doUpdate') {
		if (intent.action.set) {
			// All keys in set become update columns (raw + scalar combined)
			logicalUpdateColumns = Object.keys(intent.action.set);
			updateColumns = logicalUpdateColumns.map((column) =>
				declaredMutationColumn(deps, intent.table, column),
			);
		} else {
			// Default: update all non-conflict columns
			const conflictCols =
				'columns' in intent.onConflict ? intent.onConflict.columns : [];
			logicalUpdateColumns = columns.filter(
				(col) => !conflictCols.includes(col),
			);
			updateColumns = logicalUpdateColumns.map((column) =>
				declaredMutationColumn(deps, intent.table, column),
			);
		}
	}

	const columnTypes = getColumnTypes(
		intent.table,
		columns,
		deps,
		useUnnest ? new Set(columns) : undefined,
	);
	const hasRawExprs = Object.keys(rawExprs).length > 0;
	const actionWhere =
		intent.action.type === 'doUpdate' && intent.action.where
			? intent.action.where
			: undefined;
	const resolvedActionWhere = actionWhere
		? resolveExistsIntent(actionWhere, intent.table, deps)
		: undefined;

	const config: UpsertConfig = {
		table: declaredMutationTable(deps, intent.table),
		tableMetadata: declaredMutationTableMetadata(deps, intent.table),
		columns: columns.map((column) =>
			declaredMutationColumn(deps, intent.table, column),
		),
		values,
		conflictTarget,
		conflictAction,
		...(updateColumns && { updateColumns }),
		...(logicalUpdateColumns && {
			updateColumnAddresses: logicalUpdateColumns.map((column) =>
				declaredMutationColumnAddress(deps, intent.table, column),
			),
		}),
		...(intent.returning && { returning: [...intent.returning] }),
		...(intent.returning && {
			returningSources: mutationReturningSources(
				deps,
				intent.table,
				intent.returning,
				intent.returningItems,
			),
		}),
		...(intent.returningItems && { returningItems: intent.returningItems }),
		...(columnTypes && { columnTypes }),
		...(hasRawExprs && {
			updateExpressions: new Map(
				Object.entries(rawExprs).map(([column, sql]) => [
					declaredMutationColumn(deps, intent.table, column),
					sql,
				]),
			),
		}),
		...(resolvedActionWhere && {
			actionWhereIntent: resolvedActionWhere,
			compileActionWhere: (where, paramState) =>
				compileUpsertActionWhere(
					where,
					intent.table,
					paramState,
					deps,
					schemaName,
				),
		}),
	};

	// maxBatchSize guard (INV-07)
	const maxBatchSize = options?.maxBatchSize;
	if (maxBatchSize !== undefined && values.length > maxBatchSize) {
		throw new InvalidOperationError(
			'upsert',
			`Batch size ${values.length} exceeds maxBatchSize ${maxBatchSize}`,
		);
	}

	// Strategy switch: unnest for large batches, VALUES for small (INV-03)
	const ast = useUnnest
		? compileUnnestUpsertMutation(config, ctx, state)
		: compileUpsertMutation(config, ctx, state);
	return compileMutationQuery(ast, intent.table, state, options, deps);
}

// ============================================================================
// compileUpsertFrom
// ============================================================================

/**
 * Compile an upsert-from intent to executable SQL (NQL-BIND).
 * INSERT INTO target SELECT ... FROM source ON CONFLICT (cols) DO UPDATE SET ...
 * Extracted body of PgsqlAdapter.compileUpsertFrom().
 */
export function compileUpsertFrom(
	intent: UpsertFromIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	// schemaName precedence (options > adapter ctor) is resolved in PgsqlAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const sourceCte =
		intent.sourceQuery !== undefined &&
		!hasBindingName(deps.bindingNames, intent.source)
			? compileSourceQueryCte(
					'compileUpsertFrom',
					intent.source,
					intent.sourceQuery,
					options,
					deps,
				)
			: undefined;
	const bindingNames =
		intent.sourceQuery !== undefined
			? withBindingName(deps.bindingNames, queryLocal(intent.source))
			: deps.bindingNames;

	const ctx = mutationContext(
		{ ...deps, ...(bindingNames !== undefined && { bindingNames }) },
		intent.source,
		MAX_DEPTH_LIMIT,
	);
	const state = createCompilerState();
	const resolvedWhere = intent.where
		? resolveExistsIntent(intent.where, intent.source, deps)
		: undefined;

	// Derive columns from model if not explicitly specified (needed for ON CONFLICT SET)
	let columns: string[] | undefined;
	if (intent.columns) {
		columns = [...intent.columns];
	} else if (options?.model) {
		const targetTable = options.model.getTable(intent.table);
		if (targetTable) {
			columns = targetTable.columns.map((c) => c.name);
		}
	}

	const sourceBinding = mutationBinding(
		{ ...deps, ...(bindingNames !== undefined && { bindingNames }) },
		intent.source,
	);
	const config: UpsertFromConfig = {
		targetTable: declaredMutationTable(deps, intent.table),
		targetTableMetadata: declaredMutationTableMetadata(deps, intent.table),
		source: sourceBinding,
		conflictColumns: intent.conflictColumns.map((column) =>
			declaredMutationColumn(deps, intent.table, column),
		),
		conflictColumnAddresses: intent.conflictColumns.map((column) =>
			declaredMutationColumnAddress(deps, intent.table, column),
		),
		...(columns && {
			columns: columns.map((column) => ({
				target: declaredMutationColumn(deps, intent.table, column),
				source: mutationSourceColumn(
					deps,
					sourceBinding,
					intent.source,
					column,
				),
				targetAddress: declaredMutationColumnAddress(
					deps,
					intent.table,
					column,
				),
				...(sourceBinding.kind === 'declared-table' && {
					sourceAddress: declaredMutationColumnAddress(
						deps,
						intent.source,
						column,
					),
				}),
			})),
		}),
		...(resolvedWhere && { where: [whereIntentAsDecision(resolvedWhere)] }),
		...(intent.limit !== undefined && { limit: intent.limit }),
		...(intent.returning && { returning: [...intent.returning] }),
		...(intent.returning && {
			returningSources: mutationReturningSources(
				deps,
				intent.table,
				intent.returning,
				intent.returningItems,
			),
		}),
		...(intent.returningItems && { returningItems: intent.returningItems }),
	};

	const ast = compileUpsertFromMutation(config, ctx, state);

	return prependSourceCte(
		compileMutationEnvelope(ast, intent.table, state, options, deps),
		intent.source,
		sourceCte,
	);
}
