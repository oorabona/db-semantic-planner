import { EXPRESSION_BRAND, REF_BRAND } from '@dbsp/types';
import { createWhereDispatcher } from './handlers/index.js';
/**
 * Mutation compilation: INSERT, UPDATE, DELETE, UPSERT.
 * Extracted from PgAdapter.compileInsert/Update/Delete/Upsert/etc.
 *
 * @internal
 */

import {
	InvalidOperationError,
	isSqlRaw,
	POSTGRESQL_CAPABILITIES,
	plan as planFn,
} from '@dbsp/core';
import {
	assertNoPathRefInConditionBodies,
	coerceValue,
	inspectMutationRows,
	resolveSelectWhere,
	resolveValueExpression,
} from '@dbsp/core/internal';
import type {
	BatchUpdateIntent,
	CompiledQuery,
	CompileOptions,
	DeleteIntent,
	ExpressionIntent,
	InsertFromIntent,
	InsertIntent,
	QueryIntent,
	UpdateIntent,
	UpsertFromIntent,
	UpsertIntent,
	WhereIntent,
} from '@dbsp/types';
import { isParamIntent, RangeAllocator } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import type { AdapterCompilerDeps } from './adapter-compiler-deps.js';
import {
	compileSelectEnvelope,
	nestedSelectCompiler,
} from './adapter-compiler-select.js';
import {
	emittedBindName,
	hasBindingName,
	localSourcePredicate,
	queryScope,
	relationBinding,
	withBindingName,
} from './binding-registry.js';
import { compileWhereIntent } from './compile-where.js';
import { buildCustomFnFilter, renumberParamRefsInAst } from './compiler.js';
import {
	parseRawExpression,
	transposeToColumnArrays,
	validateBatchCardinality,
} from './compiler-utils.js';
import {
	dbTypeCastTarget,
	renderColumnDbType,
	validateDbType,
} from './db-type.js';
import { deparseQuoted } from './deparse.js';
import {
	type CompilerContext,
	type CompilerState,
	createCompilerState,
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
	COMPILED_MUTATION_VALUE,
	type CompiledMutationValue,
	DEFAULT_INSERT_CELL,
	isCompiledMutationValue,
} from './mutations/mutation-compiler.js';
import { unwrapParamIntent } from './param-intent.js';
import {
	finalizeEnvelope,
	fromAstProjection,
	type ProjectionEnvelope,
	preserveOneToOne,
} from './projection-envelope.js';
import { MAX_DEPTH_LIMIT } from './recursive/cte-compiler.js';
import {
	compileResolvedCondition,
	compileResolvedExpression,
} from './resolved-condition-compiler.js';
import {
	queryLocal,
	resolveDeclaredIdentifier,
	type SqlIdentifier,
} from './sql-identifier.js';
import {
	commonTableExpression,
	requireStatementAst,
	shiftParameters,
	withLeadingCtes,
} from './statement-ast.js';
import { validateIdentifier } from './validate.js';

export const POSTGRESQL_PARAMETER_LIMIT = 65_535;
export const HETEROGENEOUS_INSERT_CELL_LIMIT = 2 * POSTGRESQL_PARAMETER_LIMIT;

/** Validate nonempty input and the insert/upsert batch-size limit. */
export function validateMutationRowCount(
	operation: 'insert' | 'upsert' | 'update',
	rows: readonly Record<string, unknown>[],
	options?: CompileOptions,
): void {
	if (rows.length === 0)
		throw new InvalidOperationError(
			operation,
			operation === 'update'
				? 'batchSet requires at least one row'
				: `${operation}: values requires at least one row`,
		);
	if (
		operation !== 'update' &&
		options?.maxBatchSize !== undefined &&
		rows.length > options.maxBatchSize
	)
		throw new InvalidOperationError(
			operation,
			`Batch size ${rows.length} exceeds maxBatchSize ${options.maxBatchSize}`,
		);
}

function assertParameterLimit(
	operation: 'insert' | 'upsert',
	count: number,
): void {
	if (count > POSTGRESQL_PARAMETER_LIMIT)
		throw new InvalidOperationError(
			operation,
			`${operation}: batch requires ${count} parameters, exceeding PostgreSQL limit ${POSTGRESQL_PARAMETER_LIMIT}`,
		);
}

// ============================================================================
// Internal helpers
// ============================================================================

type SourceCteFragment = {
	readonly ast: Node;
	readonly parameters: readonly unknown[];
};

function compileSourceQueryCte(
	sourceName: string,
	sourceQuery: QueryIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): SourceCteFragment {
	const model = deps.model;
	const sourcePlan = planFn(sourceQuery, model, {
		dialectCapabilities: deps.dialectCapabilities ?? POSTGRESQL_CAPABILITIES,
	});
	const source = compileSelectEnvelope(sourcePlan, options, deps);
	return {
		ast: requireStatementAst(source, `the source query '${sourceName}'`),
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
	const sourceCteName = emittedBindName(queryLocal(sourceName));
	validateIdentifier(sourceCteName, 'alias');
	// The source query is a CTE in the mutation's own WITH; the mutation's
	// parameters follow the source's, shifted in the tree (ADR 0012).
	const ast = withLeadingCtes(
		shiftParameters(
			requireStatementAst(query, `the mutation reading '${sourceName}'`),
			sourceCte.parameters.length,
		),
		[commonTableExpression(sourceCteName, sourceCte.ast)],
	);
	return finalizeEnvelope(
		preserveOneToOne(query, {
			sql: deparseQuoted(ast),
			parameters: [...sourceCte.parameters, ...query.parameters],
			ast,
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
		createWhereDispatcher: () => createWhereDispatcher(compileWhereIntent),
		compileNestedSelect: nestedSelectCompiler(undefined, deps),
	} as CompilerContext;
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
	operation: 'insert' | 'upsert' | 'update' = 'insert',
): Record<string, MutationColumnMetadata> | undefined {
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
					`Batch mutation of array-typed column '${col}' (${castTarget}) is not supported: unnest flattens multi-dimensional arrays. ${operation === 'update' ? 'Use single-row updates, or scalar set for a non-match assignment column only when every row should receive the same array.' : 'Set batchThreshold to at least the batch size to use VALUES, or use single-row mutations for array columns.'}`,
				);
			}
			// Mutation compiler columns are physical identifiers. Keep the cast map
			// in that same SQL namespace after looking up the logical model column.
			const physicalName = declaredMutationColumn(deps, tableName, col);
			const arrayBase =
				operation === 'update'
					? undefined
					: insertArrayBase(authored, castTarget, columnIR.type);
			result[physicalName] = {
				logicalTable: tableName,
				logicalColumn: col,
				physicalName,
				databaseType: castTarget,
				...(arrayBase !== undefined && { arrayBase }),
			};
		}
	}
	return result;
}

/**
 * The element type an INSERT/UPSERT `unnest` array cast must name when the
 * base mapping would store other values than VALUES does: a physical
 * `timestamp` or `json`, the logical `number` (DDL `INTEGER`) and
 * `float(1..24)` (`real`).
 */
function insertArrayBase(
	authored: string | undefined,
	castTarget: string,
	logicalType: string,
): string | undefined {
	if (authored === undefined || authored === '')
		return logicalType === 'number' ? 'int4' : undefined;
	const base = castTarget.trim().toLowerCase();
	if (base === 'timestamp') return 'timestamp';
	if (base === 'json') return 'json';
	const float = /^float\s*\(\s*(\d+)\s*\)$/.exec(base);
	if (float && Number(float[1]) >= 1 && Number(float[1]) <= 24) return 'float4';
	return undefined;
}

type MutationValuePosition = 'SET' | 'DO UPDATE SET' | 'VALUES';

/** The expression intent of an expression value (ADR 0011), if it is one. */
function valueExpressionIntent(leaf: unknown): ExpressionIntent | undefined {
	if (typeof leaf !== 'object' || leaf === null) return undefined;
	if (
		EXPRESSION_BRAND in leaf &&
		(leaf as { [EXPRESSION_BRAND]: unknown })[EXPRESSION_BRAND] === true &&
		'intent' in leaf
	) {
		const intent = (leaf as { intent: ExpressionIntent }).intent;
		return isParamIntent(intent) ? undefined : intent;
	}
	if (REF_BRAND in leaf)
		return {
			kind: 'ref',
			column: (leaf as unknown as { target: string }).target,
		};
	const candidate = leaf as { kind?: unknown; outer?: unknown };
	if (candidate.kind === 'ref' && candidate.outer === true)
		return leaf as ExpressionIntent;
	return undefined;
}

/**
 * The value preparer of one mutation statement (ADR 0011 delivery 4). Each
 * value goes through core's `coerceValue`; an expression value is resolved
 * against the target table, bound as the root range of an allocator of its
 * own (each value is a separate SQL scope, and a shared allocator would make
 * alias searches grow with the batch), and returned as a
 * `CompiledMutationValue`; a `sql()` marker in
 * `values()` is parsed. Plain values, `param()` wrappers and the `sql()`
 * markers of SET positions are returned unchanged.
 */
function mutationValuePreparer(
	deps: AdapterCompilerDeps,
	table: string,
	operation: 'insert' | 'update' | 'upsert',
): (value: unknown, position: MutationValuePosition) => unknown {
	const valueScope = () => {
		const allocator = new RangeAllocator();
		const root = allocator.bind(table, table);
		for (const name of [
			...(deps.bindingNames ?? []),
			...(deps.scope?.bindings.keys() ?? []),
		]) {
			allocator.reserve(name);
		}
		return { allocator, root };
	};
	const refuseRead = (
		reference: { readonly column: string } | { readonly relation: string },
	): never => {
		const read =
			'column' in reference
				? `column '${reference.column}'`
				: `relation '${reference.relation}'`;
		throw new InvalidOperationError(
			operation,
			`values() cannot read ${read}; an INSERT row has no columns in scope. Use a value, param(), literal() or an uncorrelated subquery`,
		);
	};
	return (value, position) => {
		if (isSqlRaw(value)) {
			if (position !== 'VALUES') return value;
			const sql = value.sql;
			return {
				[COMPILED_MUTATION_VALUE]: true,
				compile: () => parseRawExpression(sql),
			} satisfies CompiledMutationValue;
		}
		const leaf = coerceValue(value, operation);
		const intent = valueExpressionIntent(leaf);
		if (intent === undefined) return leaf;
		const { allocator, root } = valueScope();
		const resolved = resolveValueExpression(
			intent,
			root,
			allocator,
			deps.model,
			{
				label: position,
				isLocalSource: localSourcePredicate(deps.bindingNames, deps.scope),
				...(position === 'VALUES' && { unreadableRoot: refuseRead }),
			},
		);
		const ctx = {
			...mutationContext(deps, table, MAX_DEPTH_LIMIT),
			currentAlias: declaredMutationTable(deps, table),
		};
		return {
			[COMPILED_MUTATION_VALUE]: true,
			compile: (state) => compileResolvedExpression(resolved, ctx, state),
		} satisfies CompiledMutationValue;
	};
}

/**
 * Whether the `unnest` strategy can carry a cell in a column array and store
 * what VALUES stores. An expression value or a `sql()` marker never is; a
 * `param(v)` is judged by `v`, read for transport only.
 */
function carriedByUnnest(cell: unknown): boolean {
	if (isCompiledMutationValue(cell) || isSqlRaw(cell)) return false;
	let value = cell;
	if (
		typeof cell === 'object' &&
		cell !== null &&
		EXPRESSION_BRAND in cell &&
		(cell as { [EXPRESSION_BRAND]: unknown })[EXPRESSION_BRAND] === true &&
		'intent' in cell &&
		isParamIntent((cell as { intent: unknown }).intent)
	)
		value = (
			(cell as { intent: { value: unknown } }).intent as { value: unknown }
		).value;
	else if (isParamIntent(cell)) return false;
	if (value === null || value === undefined) return true;
	switch (typeof value) {
		case 'string':
		case 'number':
		case 'boolean':
		case 'bigint':
			return true;
		case 'object':
			break;
		default:
			return false;
	}
	if (Array.isArray(value)) return false;
	if (value instanceof Date || ArrayBuffer.isView(value)) return true;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	// pg serialises an array element without the null guard of a scalar
	// parameter, so an object that customises its serialisation (toPostgres,
	// toJSON, an accessor) is bound as a VALUES cell. Descriptors are read
	// without invoking a getter.
	const descriptors = Object.getOwnPropertyDescriptors(value);
	for (const descriptor of Reflect.ownKeys(descriptors).map(
		(key) => descriptors[key as keyof typeof descriptors] as PropertyDescriptor,
	))
		if (
			descriptor.get !== undefined ||
			descriptor.set !== undefined ||
			typeof descriptor.value === 'function'
		)
			return false;
	return !isParamIntent(value);
}

/** The column-array cells of an unnest batch: a `param(v)` contributes `v`. */
function unnestCells(values: readonly unknown[][]): unknown[][] {
	return values.map((row) =>
		row.map((cell) => unwrapParamIntent(cell) ?? null),
	);
}

/** Whether a declared column type is itself an array (unnest would flatten it). */
function hasArrayTypedColumn(
	columnTypes: Record<string, MutationColumnMetadata> | undefined,
): boolean {
	return Object.values(columnTypes ?? {}).some((metadata) =>
		metadata.databaseType.trim().endsWith('[]'),
	);
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
 * Extracted body of PgAdapter.compileInsert().
 */
export function compileInsert(
	intent: InsertIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
	rowShape?: ReturnType<typeof inspectMutationRows>,
): CompiledQuery {
	// schemaName precedence (options > adapter ctor) is resolved in PgAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const ctx = mutationContext(deps, intent.table, MAX_DEPTH_LIMIT);
	const state = createCompilerState();

	const rows = intent.values ?? [];
	const { columns, heterogeneous, rowKeys } =
		rowShape ??
		inspectMutationRows(rows, {
			operation: 'insert',
		});
	validateMutationRowCount('insert', rows, options);
	if (
		heterogeneous &&
		rows.length > HETEROGENEOUS_INSERT_CELL_LIMIT / columns.length
	)
		throw new InvalidOperationError(
			'insert',
			`insert: heterogeneous batch has ${rows.length} rows and ${columns.length} columns, exceeding cell limit ${HETEROGENEOUS_INSERT_CELL_LIMIT}; split the rows by shape`,
		);
	const prepare = mutationValuePreparer(deps, intent.table, 'insert');
	const values = rows.map((row, index) =>
		columns.map((col) =>
			rowKeys[index]?.has(col)
				? prepare(row[col] ?? null, 'VALUES')
				: DEFAULT_INSERT_CELL,
		),
	);
	const batchThreshold = options?.batchThreshold ?? 50;
	// unnest only when every cell is carried as is and no column is array-typed;
	// otherwise VALUES stores the same rows (ADR 0011 delivery 4).
	const useUnnest =
		!heterogeneous &&
		values.length > 0 &&
		(batchThreshold === 0 || values.length > batchThreshold) &&
		!hasArrayTypedColumn(getColumnTypes(intent.table, columns, deps)) &&
		values.every((row) => row.every(carriedByUnnest));
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
		values: useUnnest ? unnestCells(values) : values,
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

	// Strategy switch: unnest for large batches, VALUES for small (INV-03)
	const ast = useUnnest
		? compileUnnestInsertMutation(config, ctx, state)
		: compileInsertMutation(config, ctx, state);
	if (!useUnnest) assertParameterLimit('insert', state.parameters.length);
	return compileMutationQuery(ast, intent.table, state, options, deps);
}

// ============================================================================
// compileInsertFrom
// ============================================================================

/**
 * Compile an insert-from intent to executable SQL (NQL-ALIGN).
 * INSERT INTO target (cols) SELECT cols FROM source WHERE ... LIMIT ... RETURNING ...
 * Extracted body of PgAdapter.compileInsertFrom().
 */
export function compileInsertFrom(
	intent: InsertFromIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	// schemaName precedence (options > adapter ctor) is resolved in PgAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const sourceCte =
		intent.sourceQuery !== undefined &&
		!hasBindingName(deps.bindingNames, intent.source)
			? compileSourceQueryCte(intent.source, intent.sourceQuery, options, deps)
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
	assertNoPathRefInConditionBodies(intent.where);
	// The source CTE is a local source of the WHERE, as in its compile context.
	const whereCompiler = resolvedMutationWhere(intent.where, intent.source, {
		...deps,
		...(bindingNames !== undefined && { bindingNames }),
	});

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
		...(whereCompiler && { whereCompiler }),
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

/**
 * Resolve a mutation WHERE through core's root condition resolver, as a SELECT
 * WHERE is, and return a compiler for it. Mutations stay unfiltered: no default
 * filters are applied; a builder nested in the WHERE keeps its own policy.
 * Without a model the old route is kept (undefined).
 */
function resolvedMutationWhere(
	where: WhereIntent | undefined,
	table: string,
	deps: AdapterCompilerDeps,
): ((ctx: CompilerContext, state: CompilerState) => Node) | undefined {
	if (!where) return undefined;
	const allocator = new RangeAllocator();
	const root = allocator.bind(table, table);
	// Generated subquery aliases must not capture a NQL binding in scope.
	for (const name of [
		...(deps.bindingNames ?? []),
		...(deps.scope?.bindings.keys() ?? []),
	]) {
		allocator.reserve(name);
	}
	const resolved = resolveSelectWhere(
		where,
		root,
		[root],
		allocator,
		deps.model,
		0,
		[],
		localSourcePredicate(deps.bindingNames, deps.scope),
	);
	if (!resolved) {
		throw new Error(
			`Internal error: the mutation WHERE on '${table}' resolved to nothing.`,
		);
	}
	return (ctx, state) => compileResolvedCondition(resolved, ctx, state);
}

// ============================================================================
// compileUpdate
// ============================================================================

/**
 * Compile an update intent to executable SQL.
 * Extracted body of PgAdapter.compileUpdate().
 */
export function compileUpdate(
	intent: UpdateIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	// schemaName precedence (options > adapter ctor) is resolved in PgAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const ctx = mutationContext(deps, intent.table, MAX_DEPTH_LIMIT);
	const state = createCompilerState();

	const setColumns = Object.keys(intent.set ?? {});
	const columnTypes = getColumnTypes(intent.table, setColumns, deps);
	const whereCompiler = resolvedMutationWhere(intent.where, intent.table, deps);

	const prepare = mutationValuePreparer(deps, intent.table, 'update');
	const config: UpdateConfig = {
		table: declaredMutationTable(deps, intent.table),
		tableMetadata: declaredMutationTableMetadata(deps, intent.table),
		set: Object.entries(intent.set ?? {}).map(([column, value]) => ({
			column: declaredMutationColumn(deps, intent.table, column),
			value: prepare(value, 'SET'),
		})),
		...(whereCompiler && { whereCompiler }),
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
 * Extracted body of PgAdapter.compileBatchUpdate().
 */
export function compileBatchUpdate(
	intent: BatchUpdateIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	const ctx = mutationContext(deps, intent.table, MAX_DEPTH_LIMIT);
	const state = createCompilerState();

	validateMutationRowCount('update', intent.updates, options);
	if (intent.matchColumns.length === 0)
		throw new InvalidOperationError(
			'update',
			'batchSet requires at least one match key',
		);

	const matchColumns = [...intent.matchColumns];
	const { columns: allColumns, rowKeys } = inspectMutationRows(intent.updates, {
		operation: 'update',
		homogeneous: true,
		requiredKeys: matchColumns,
	});

	const assignmentColumns = allColumns.filter(
		(column) => !matchColumns.includes(column),
	);
	const scalarColumns = Object.keys(intent.scalarSet ?? {});
	if (assignmentColumns.length === 0 && scalarColumns.length === 0)
		throw new InvalidOperationError(
			'update',
			'batchSet requires at least one assignment',
		);
	for (const column of assignmentColumns) {
		if (scalarColumns.includes(column))
			throw new InvalidOperationError(
				'update',
				`batchSet column '${column}' also appears in scalar set`,
			);
	}

	// Build row-major values matrix and validate cardinality
	const values = intent.updates.map((row, index) =>
		allColumns.map((col) =>
			rowKeys[index]?.has(col) ? (row[col] ?? null) : null,
		),
	);
	validateBatchCardinality(allColumns, values);

	// Transpose to column-major arrays
	const columnArrays = transposeToColumnArrays(allColumns, values);

	// Get column types for type inference
	const columnTypes = getColumnTypes(
		intent.table,
		[...allColumns, ...Object.keys(intent.scalarSet ?? {})],
		deps,
		new Set(allColumns),
		'update',
	);

	// Build scalar SET entries from scalarSet
	const prepare = mutationValuePreparer(deps, intent.table, 'update');
	const scalarSet = intent.scalarSet
		? Object.entries(intent.scalarSet).map(([column, value]) => ({
				column,
				value: prepare(value, 'SET'),
			}))
		: undefined;

	// Compile optional WHERE guard (e.g., AND EXISTS(...))
	// The guard uses the shared `state` so $N numbering continues from unnest params.
	let whereGuard: import('@pgsql/types').Node | undefined;
	const guardCompiler = resolvedMutationWhere(intent.where, intent.table, deps);
	// The guard qualifies the updated table by its physical name, as UPDATE's WHERE does.
	if (guardCompiler)
		whereGuard = guardCompiler(
			{
				...ctx,
				currentAlias:
					declaredMutationTableMetadata(deps, intent.table)?.physicalName ??
					declaredMutationTable(deps, intent.table),
			},
			state,
		);

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
	return compileMutationQuery(ast, intent.table, state, options, deps);
}

// ============================================================================
// compileDelete
// ============================================================================

/**
 * Compile a delete intent to executable SQL.
 * Extracted body of PgAdapter.compileDelete().
 */
export function compileDelete(
	intent: DeleteIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	// schemaName precedence (options > adapter ctor) is resolved in PgAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const ctx = mutationContext(deps, intent.table, MAX_DEPTH_LIMIT);
	const state = createCompilerState();

	// Resolve exists/notExists relation name → real table name before compiling.
	// The mutation path bypasses the planner, so we must resolve targetTable here.
	const whereCompiler = resolvedMutationWhere(intent.where, intent.table, deps);

	const config: DeleteConfig = {
		table: declaredMutationTable(deps, intent.table),
		tableMetadata: declaredMutationTableMetadata(deps, intent.table),
		...(whereCompiler && { whereCompiler }),
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
 * Extracted body of PgAdapter.compileUpsert().
 */
export function compileUpsert(
	intent: UpsertIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
	rowShape?: ReturnType<typeof inspectMutationRows>,
): CompiledQuery {
	const ctx = mutationContext(deps, intent.table, MAX_DEPTH_LIMIT);
	const state = createCompilerState();

	const rows = intent.values ?? [];
	const { columns: inspectedColumns, rowKeys } =
		rowShape ??
		inspectMutationRows(rows, {
			operation: 'upsert',
			homogeneous: true,
		});

	validateMutationRowCount('upsert', rows, options);
	const columns = [...inspectedColumns];

	// Explicit SET values apply only on conflict; INSERT rows retain their values().
	const rawExprs: Record<string, string> = {};
	const scalarSet: Record<string, unknown> = {};
	const prepare = mutationValuePreparer(deps, intent.table, 'upsert');
	const values = rows.map((row, index) =>
		columns.map((col) =>
			prepare(rowKeys[index]?.has(col) ? (row[col] ?? null) : null, 'VALUES'),
		),
	);
	if (intent.action.type === 'doUpdate' && intent.action.set) {
		for (const [key, val] of Object.entries(intent.action.set)) {
			if (isSqlRaw(val)) rawExprs[key] = val.sql;
			else {
				// The public param() factory wraps its ParamIntent in an expression ref.
				scalarSet[key] =
					val &&
					typeof val === 'object' &&
					EXPRESSION_BRAND in val &&
					val[EXPRESSION_BRAND] === true &&
					'intent' in val &&
					isParamIntent(val.intent)
						? val.intent
						: prepare(val, 'DO UPDATE SET');
			}
		}
	}
	const batchThreshold = options?.batchThreshold ?? 50;
	// unnest only when every cell is carried as is and no column is array-typed;
	// otherwise VALUES stores the same rows (ADR 0011 delivery 4).
	const useUnnest =
		values.length > 0 &&
		(batchThreshold === 0 || values.length > batchThreshold) &&
		!hasArrayTypedColumn(
			getColumnTypes(intent.table, columns, deps, undefined, 'upsert'),
		) &&
		values.every((row) => row.every(carriedByUnnest));

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
	// Scalars bind independently; raw values use the parsed SQL expression.
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
		[...new Set([...columns, ...Object.keys(scalarSet)])],
		deps,
		useUnnest ? new Set(columns) : undefined,
		'upsert',
	);
	const hasRawExprs = Object.keys(rawExprs).length > 0;
	const actionWhere =
		intent.action.type === 'doUpdate' && intent.action.where
			? intent.action.where
			: undefined;
	const actionWhereCompiler = resolvedMutationWhere(
		actionWhere,
		intent.table,
		deps,
	);

	const config: UpsertConfig = {
		table: declaredMutationTable(deps, intent.table),
		tableMetadata: declaredMutationTableMetadata(deps, intent.table),
		columns: columns.map((column) =>
			declaredMutationColumn(deps, intent.table, column),
		),
		values: useUnnest ? unnestCells(values) : values,
		...(intent.action.type === 'doUpdate' &&
			intent.action.set && {
				updateValues: new Map(
					Object.entries(scalarSet).map(([column, value]) => [
						declaredMutationColumn(deps, intent.table, column),
						value,
					]),
				),
			}),
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
		...(actionWhere &&
			actionWhereCompiler && {
				actionWhereIntent: actionWhere,
				compileActionWhere: (_where, paramState) => {
					// Lower the action in its own parameter namespace, then append it. The
					// complete upsert statement is checked once after all parameters exist.
					const actionState = createCompilerState();
					const actionNode = actionWhereCompiler(
						{
							...mutationContext(deps, intent.table, MAX_DEPTH_LIMIT),
							currentAlias: declaredMutationTable(deps, intent.table),
						},
						actionState,
					);
					const shifted = renumberParamRefsInAst(
						actionNode,
						paramState.paramIndex,
					);
					paramState.parameters.push(...actionState.parameters);
					paramState.paramIndex += actionState.paramIndex;
					return shifted;
				},
			}),
	};

	// Strategy switch: unnest for large batches, VALUES for small (INV-03)
	const ast = useUnnest
		? compileUnnestUpsertMutation(config, ctx, state)
		: compileUpsertMutation(config, ctx, state);
	assertParameterLimit('upsert', state.parameters.length);
	return compileMutationQuery(ast, intent.table, state, options, deps);
}

// ============================================================================
// compileUpsertFrom
// ============================================================================

/**
 * Compile an upsert-from intent to executable SQL (NQL-BIND).
 * INSERT INTO target SELECT ... FROM source ON CONFLICT (cols) DO UPDATE SET ...
 * Extracted body of PgAdapter.compileUpsertFrom().
 */
export function compileUpsertFrom(
	intent: UpsertFromIntent,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery {
	// schemaName precedence (options > adapter ctor) is resolved in PgAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const sourceCte =
		intent.sourceQuery !== undefined &&
		!hasBindingName(deps.bindingNames, intent.source)
			? compileSourceQueryCte(intent.source, intent.sourceQuery, options, deps)
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
	assertNoPathRefInConditionBodies(intent.where);
	// The source CTE is a local source of the WHERE, as in its compile context.
	const whereCompiler = resolvedMutationWhere(intent.where, intent.source, {
		...deps,
		...(bindingNames !== undefined && { bindingNames }),
	});

	// Derive columns from model if not explicitly specified (needed for ON CONFLICT SET)
	let columns: string[] | undefined;
	if (intent.columns) {
		columns = [...intent.columns];
	} else {
		const targetTable = deps.model.getTable(intent.table);
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
		...(whereCompiler && { whereCompiler }),
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
