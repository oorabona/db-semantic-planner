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
import type { AdapterCompilerDeps } from './adapter-compiler-deps.js';
import { compileSelect } from './adapter-compiler-select.js';
import {
	emittedBindName,
	hasBindingName,
	withBindingName,
} from './binding-registry.js';
import {
	buildSubqueryFromIntent,
	compileWhereIntent,
	type WhereCompilerCtx,
} from './compile-where.js';
import {
	transposeToColumnArrays,
	validateBatchCardinality,
} from './compiler-utils.js';
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
	type UpdateConfig,
	type UpsertConfig,
	type UpsertFromConfig,
} from './mutations/index.js';
import type { NamingPlugin } from './naming-plugin.js';

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

function compileSourceQueryCte(
	operation: 'compileInsertFrom' | 'compileUpsertFrom',
	sourceName: string,
	sourceQuery: QueryIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	const model = deps.model;
	if (model === undefined) {
		throw new Error(
			`${operation} with sourceQuery requires a model to emit the source CTE for '${sourceName}'.`,
		);
	}
	const sourcePlan = planFn(sourceQuery, model, {
		dialectCapabilities: deps.dialectCapabilities ?? POSTGRESQL_CAPABILITIES,
	});
	return compileSelect(sourcePlan, options, deps);
}

function prependSourceCte(
	sql: string,
	parameters: readonly unknown[],
	sourceName: string,
	sourceCte: CompiledQuery | undefined,
	naming: NamingPlugin,
): CompiledQuery {
	if (sourceCte === undefined) {
		return { sql, parameters };
	}
	const cteParamCount = sourceCte.parameters.length;
	const sourceCteName = emittedBindName(sourceName, naming);
	return {
		sql: `WITH ${quoteIdent(sourceCteName, 'alias')} as (${sourceCte.sql}) ${renumberSqlParams(sql, cteParamCount)}`,
		parameters: [...sourceCte.parameters, ...parameters],
	};
}

function resolveMutationExistsForeignKey(
	foreignKey: string | readonly string[] | undefined,
	relationName: string,
): string | undefined {
	if (typeof foreignKey === 'string') return foreignKey;
	if (!Array.isArray(foreignKey)) return undefined;
	if (foreignKey.length > 1) {
		throw new Error(
			`Mutation exists()/notExists() guards do not support composite foreignKey relations yet: relation '${relationName}' has foreignKey ${JSON.stringify(foreignKey)}. ` +
				'Composite FK correlation is tracked by #179.',
		);
	}
	return foreignKey[0];
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
): { targetTable: string; sourceColumn?: string; targetColumn?: string } {
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
			targetColumn: 'id',
		};
	}
	// For hasMany/hasOne: FK is on the target table (e.g. symbols.id → calls.callee_id)
	const fk = resolveMutationExistsForeignKey(rel.foreignKey, relationName);
	return {
		targetTable,
		sourceColumn: rel.sourceKey ?? 'id',
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
 * Build a column-type map for a table, covering all typed columns so that
 * `inferPgArrayType` can produce schema-driven array casts (e.g. int4[], bool[]).
 * Prefers `originalDbType` when set (preserves precision info from introspection).
 * Returns undefined if no columns found (or model unavailable).
 */
function getColumnTypes(
	tableName: string,
	columns: string[],
	deps: AdapterCompilerDeps,
): Record<string, string> | undefined {
	if (!deps.model) return undefined;
	const table = deps.model.getTable(tableName);
	if (!table) return undefined;
	let result: Record<string, string> | undefined;
	for (const col of columns) {
		const columnIR = table.columns.find((c) => c.name === col);
		if (columnIR) {
			result ??= {};
			// Prefer originalDbType (preserves introspection precision) over ColumnType
			result[col] = columnIR.originalDbType ?? columnIR.type;
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
		naming: deps.naming,
		...(schemaName !== undefined && { schemaName }),
		...(deps.bindingNames !== undefined && { bindingNames: deps.bindingNames }),
		...(deps.model !== undefined && { model: deps.model }),
		...(deps.dialectCapabilities !== undefined && {
			dialectCapabilities: deps.dialectCapabilities,
		}),
		compileSubquery: (sqIntent, paramOffset) =>
			buildSubqueryFromIntent(
				sqIntent,
				paramOffset,
				deps.naming,
				schemaName,
				'rawExists',
				deps.bindingNames,
				deps.dialectCapabilities,
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
	const schemaName = deps.schemaName;

	const ctx: CompilerContext = {
		naming: deps.naming,
		rootTable: intent.table,
		...(schemaName !== undefined && { schema: schemaName }),
		...(deps.dialectCapabilities !== undefined && {
			dialectCapabilities: deps.dialectCapabilities,
		}),
		...(deps.bindingNames !== undefined && { bindingNames: deps.bindingNames }),
		maxRecursiveDepth: 100,
	};
	const state = createCompilerState();

	const firstRow = intent.values?.[0] ?? {};
	const columns = Object.keys(firstRow);
	const rows = intent.values ?? [];
	const values = rows.map((row) => columns.map((col) => row[col]));

	const columnTypes = getColumnTypes(intent.table, columns, deps);

	const config: InsertConfig = {
		table: intent.table,
		columns,
		values,
		...(intent.returning && { returning: [...intent.returning] }),
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
	const batchThreshold = options?.batchThreshold ?? 50;
	const useUnnest =
		values.length > 0 &&
		(batchThreshold === 0 || values.length > batchThreshold);

	const ast = useUnnest
		? compileUnnestInsertMutation(config, ctx, state)
		: compileInsertMutation(config, ctx, state);
	const sql = deparseQuoted(ast);

	return {
		sql,
		parameters: state.parameters,
	};
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
	const schemaName = deps.schemaName;
	const sourceCte =
		intent.sourceQuery !== undefined &&
		!hasBindingName(deps.bindingNames, intent.source, deps.naming)
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
			? withBindingName(deps.bindingNames, intent.source, deps.naming)
			: deps.bindingNames;

	const ctx: CompilerContext = {
		naming: deps.naming,
		rootTable: intent.source,
		...(schemaName !== undefined && { schema: schemaName }),
		...(deps.dialectCapabilities !== undefined && {
			dialectCapabilities: deps.dialectCapabilities,
		}),
		...(bindingNames !== undefined && { bindingNames }),
		maxRecursiveDepth: 100,
	};
	const state = createCompilerState();
	const resolvedWhere = intent.where
		? resolveExistsIntent(intent.where, intent.source, deps)
		: undefined;

	const config: InsertFromConfig = {
		targetTable: intent.table,
		sourceTable: intent.source,
		...(intent.columns && { columns: [...intent.columns] }),
		...(resolvedWhere && { where: [whereIntentAsDecision(resolvedWhere)] }),
		...(intent.limit !== undefined && { limit: intent.limit }),
		...(intent.returning && { returning: [...intent.returning] }),
	};

	const ast = compileInsertFromMutation(config, ctx, state);
	const sql = deparseQuoted(ast);

	return prependSourceCte(
		sql,
		state.parameters,
		intent.source,
		sourceCte,
		deps.naming,
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
	const schemaName = deps.schemaName;
	const resolvedModel = options?.model ?? deps.model;

	const ctx: CompilerContext = {
		naming: deps.naming,
		rootTable: intent.table,
		...(schemaName !== undefined && { schema: schemaName }),
		...(deps.bindingNames !== undefined && { bindingNames: deps.bindingNames }),
		...(resolvedModel !== undefined && { model: resolvedModel }),
		...(deps.dialectCapabilities !== undefined && {
			dialectCapabilities: deps.dialectCapabilities,
		}),
		maxRecursiveDepth: 100,
	};
	const state = createCompilerState();

	const setColumns = Object.keys(intent.set ?? {});
	const columnTypes = getColumnTypes(intent.table, setColumns, deps);
	const resolvedWhere = intent.where
		? resolveExistsIntent(intent.where, intent.table, deps)
		: undefined;

	const config: UpdateConfig = {
		table: intent.table,
		set: Object.entries(intent.set ?? {}).map(([column, value]) => ({
			column,
			value,
		})),
		...(resolvedWhere && { where: [whereIntentAsDecision(resolvedWhere)] }),
		...(intent.returning && { returning: [...intent.returning] }),
		...(columnTypes && { columnTypes }),
	};

	const ast = compileUpdateMutation(config, ctx, state);
	const sql = deparseQuoted(ast);

	return {
		sql,
		parameters: state.parameters,
	};
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

	const ctx: CompilerContext = {
		naming: deps.naming,
		rootTable: intent.table,
		...(schemaName !== undefined && { schema: schemaName }),
		...(deps.dialectCapabilities !== undefined && {
			dialectCapabilities: deps.dialectCapabilities,
		}),
		...(deps.bindingNames !== undefined && { bindingNames: deps.bindingNames }),
		maxRecursiveDepth: 100,
	};
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
	const columnTypes = getColumnTypes(intent.table, allColumns, deps);

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
			naming: deps.naming,
			...(schemaName !== undefined && { schemaName }),
			...(deps.bindingNames !== undefined && {
				bindingNames: deps.bindingNames,
			}),
			...(deps.model !== undefined && { model: deps.model }),
			...(deps.dialectCapabilities !== undefined && {
				dialectCapabilities: deps.dialectCapabilities,
			}),
			compileSubquery: (sqIntent, paramOffset) =>
				buildSubqueryFromIntent(
					sqIntent,
					paramOffset,
					deps.naming,
					schemaName,
					'rawExists',
					deps.bindingNames,
					deps.dialectCapabilities,
				),
		};
		whereGuard = compileWhereIntent(resolvedWhere, whereCtx);
	}

	const config: BatchUpdateConfig = {
		table: intent.table,
		matchColumns,
		allColumns,
		columnArrays,
		...(scalarSet && { scalarSet }),
		...(intent.returning && { returning: [...intent.returning] }),
		...(columnTypes && { columnTypes }),
		...(whereGuard !== undefined && { whereGuard }),
	};

	const ast = compileUnnestUpdateMutation(config, ctx, state);
	const sql = deparseQuoted(ast);

	return {
		sql,
		parameters: state.parameters,
	};
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
	const schemaName = deps.schemaName;

	const resolvedModel = options?.model ?? deps.model;
	const ctx: CompilerContext = {
		naming: deps.naming,
		rootTable: intent.table,
		...(schemaName !== undefined && { schema: schemaName }),
		...(deps.bindingNames !== undefined && { bindingNames: deps.bindingNames }),
		...(deps.dialectCapabilities !== undefined && {
			dialectCapabilities: deps.dialectCapabilities,
		}),
		maxRecursiveDepth: 100,
		...(resolvedModel !== undefined && { model: resolvedModel }),
	};
	const state = createCompilerState();

	// Resolve exists/notExists relation name → real table name before compiling.
	// The mutation path bypasses the planner, so we must resolve targetTable here.
	const resolvedWhere = intent.where
		? resolveExistsIntent(intent.where, intent.table, deps)
		: undefined;

	const config: DeleteConfig = {
		table: intent.table,
		...(resolvedWhere && { where: [whereIntentAsDecision(resolvedWhere)] }),
		...(intent.returning && { returning: [...intent.returning] }),
	};

	const ast = compileDeleteMutation(config, ctx, state);
	const sql = deparseQuoted(ast);

	return {
		sql,
		parameters: state.parameters,
	};
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

	const ctx: CompilerContext = {
		naming: deps.naming,
		rootTable: intent.table,
		...(schemaName !== undefined && { schema: schemaName }),
		...(deps.bindingNames !== undefined && { bindingNames: deps.bindingNames }),
		...(deps.model !== undefined && { model: deps.model }),
		...(deps.dialectCapabilities !== undefined && {
			dialectCapabilities: deps.dialectCapabilities,
		}),
		maxRecursiveDepth: 100,
	};
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

	// Build conflict target
	const conflictTarget: {
		columns?: string[];
		constraint?: string;
	} = {};

	if ('columns' in intent.onConflict) {
		conflictTarget.columns = [...intent.onConflict.columns];
	} else if ('constraint' in intent.onConflict) {
		conflictTarget.constraint = intent.onConflict.constraint;
	}

	// Build conflict action
	const conflictAction: 'nothing' | 'update' =
		intent.action.type === 'doNothing' ? 'nothing' : 'update';

	// Determine update columns.
	// All columns in intent.action.set are update columns (both scalar and raw).
	// Scalar ones use EXCLUDED.column, raw ones use the parsed SQL expression.
	let updateColumns: string[] | undefined;
	if (intent.action.type === 'doUpdate') {
		if (intent.action.set) {
			// All keys in set become update columns (raw + scalar combined)
			updateColumns = Object.keys(intent.action.set);
		} else {
			// Default: update all non-conflict columns
			const conflictCols =
				'columns' in intent.onConflict ? intent.onConflict.columns : [];
			updateColumns = columns.filter((col) => !conflictCols.includes(col));
		}
	}

	const columnTypes = getColumnTypes(intent.table, columns, deps);
	const hasRawExprs = Object.keys(rawExprs).length > 0;
	const actionWhere =
		intent.action.type === 'doUpdate' && intent.action.where
			? intent.action.where
			: undefined;
	const resolvedActionWhere = actionWhere
		? resolveExistsIntent(actionWhere, intent.table, deps)
		: undefined;

	const config: UpsertConfig = {
		table: intent.table,
		columns,
		values,
		conflictTarget,
		conflictAction,
		...(updateColumns && { updateColumns }),
		...(intent.returning && { returning: [...intent.returning] }),
		...(columnTypes && { columnTypes }),
		...(hasRawExprs && { updateExpressions: rawExprs }),
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
	const batchThreshold = options?.batchThreshold ?? 50;
	const useUnnest =
		values.length > 0 &&
		(batchThreshold === 0 || values.length > batchThreshold);

	const ast = useUnnest
		? compileUnnestUpsertMutation(config, ctx, state)
		: compileUpsertMutation(config, ctx, state);
	const sql = deparseQuoted(ast);

	return {
		sql,
		parameters: state.parameters,
	};
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
	const schemaName = deps.schemaName;
	const sourceCte =
		intent.sourceQuery !== undefined &&
		!hasBindingName(deps.bindingNames, intent.source, deps.naming)
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
			? withBindingName(deps.bindingNames, intent.source, deps.naming)
			: deps.bindingNames;

	const ctx: CompilerContext = {
		naming: deps.naming,
		rootTable: intent.source,
		...(schemaName !== undefined && { schema: schemaName }),
		...(deps.dialectCapabilities !== undefined && {
			dialectCapabilities: deps.dialectCapabilities,
		}),
		...(bindingNames !== undefined && { bindingNames }),
		maxRecursiveDepth: 100,
	};
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

	const config: UpsertFromConfig = {
		targetTable: intent.table,
		sourceTable: intent.source,
		conflictColumns: [...intent.conflictColumns],
		...(columns && { columns }),
		...(resolvedWhere && { where: [whereIntentAsDecision(resolvedWhere)] }),
		...(intent.limit !== undefined && { limit: intent.limit }),
		...(intent.returning && { returning: [...intent.returning] }),
	};

	const ast = compileUpsertFromMutation(config, ctx, state);
	const sql = deparseQuoted(ast);

	return prependSourceCte(
		sql,
		state.parameters,
		intent.source,
		sourceCte,
		deps.naming,
	);
}
