/**
 * Mutation Compiler
 *
 * Compiles INSERT, UPDATE, and DELETE statements from plan decisions.
 * Supports:
 * - INSERT with values/from subquery
 * - INSERT with RETURNING
 * - UPDATE with SET and WHERE
 * - DELETE with WHERE
 * - RETURNING clause for all mutations
 */

import { isSqlRaw } from '@dbsp/core';
import {
	isParamIntent,
	type MutationReturningItem,
	type ParamIntent,
} from '@dbsp/types';
import type { Node } from '@pgsql/types';
import {
	funcCall,
	type SqlDeleteOptions,
	type SqlInsertOptions,
	type SqlUpdateOptions,
	sqlColumnRef,
	sqlColumnRefStar,
	sqlDeleteStmt,
	sqlInsertStmt,
	sqlResTarget,
	sqlUpdateStmt,
	typeCast,
} from '../ast-helpers.js';
import type { RelationBinding } from '../binding-registry.js';
import {
	inferPgArrayType,
	parseRawExpression,
	stripArraySuffix,
	transposeToColumnArrays,
	validateBatchCardinality,
} from '../compiler-utils.js';
import { compileWhereIntent } from '../condition-compiler.js';
import { createWhereDispatcher } from '../handlers/index.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	InsertStmtNode,
} from '../handlers/types.js';
import { unwrapParamIntent } from '../param-intent.js';
import { createTypeCastParamRef } from '../param-ref.js';
import {
	queryLocal,
	resolveDeclaredIdentifier,
	type SqlIdentifier,
} from '../sql-identifier.js';

// ============================================================================
// Shared Helpers
// ============================================================================

/**
 * Build RETURNING clause AST nodes from column names.
 * Shared across INSERT, UPDATE, DELETE, UPSERT, and INSERT FROM.
 */
export function buildReturningExprs(
	columns: readonly string[] | undefined,
	table: SqlIdentifier,
	sourceInput: readonly SqlIdentifier[] | undefined,
	returningItems?: readonly MutationReturningItem[],
): Node[] | undefined {
	const addressedSources = sourceInput;
	if (returningItems !== undefined) {
		const returning = columns ?? [];
		if (returningItems.length !== returning.length) {
			throw new Error(
				`Invalid mutation RETURNING items: returningItems length (${returningItems.length}) must match returning length (${returning.length}).`,
			);
		}
		if (
			returning.includes('*') ||
			returningItems.some((item) => item.output === '*' || item.source === '*')
		) {
			throw new Error(
				'Invalid mutation RETURNING items: star RETURNING cannot carry alias-aware returningItems.',
			);
		}
		if (returningItems.length === 0) return undefined;
		const emittedOutputs = new Map<string, string>();
		return returningItems.map((item, index) => {
			if (item.output !== returning[index]) {
				throw new Error(
					`Invalid mutation RETURNING items: returningItems[${index}].output '${item.output}' must match returning[${index}] '${returning[index]}'.`,
				);
			}
			// RETURNING labels are query-local output identifiers, not declared
			// columns. Keep the alias exactly as the caller wrote it.
			const emittedOutput = item.output;
			const previousOutput = emittedOutputs.get(emittedOutput);
			if (previousOutput !== undefined) {
				throw new Error(
					`Duplicate mutation RETURNING output: '${emittedOutput}' from '${previousOutput}' and '${item.output}'.`,
				);
			}
			emittedOutputs.set(emittedOutput, item.output);
			const source = addressedSources?.[index];
			if (source === undefined) {
				throw new Error(
					`Mutation RETURNING source '${item.source}' has no addressed identifier.`,
				);
			}
			return sqlResTarget(
				sqlColumnRef(source, table),
				queryLocal(emittedOutput),
			);
		});
	}
	if (!columns || columns.length === 0) return undefined;
	return columns.map((col, index) =>
		col === '*'
			? sqlResTarget(sqlColumnRefStar())
			: sqlResTarget(
					sqlColumnRef(
						requireAddressedReturningSource(addressedSources, index, col),
						table,
					),
					queryLocal(col),
				),
	);
}

function requireAddressedReturningSource(
	sources: readonly SqlIdentifier[] | undefined,
	index: number,
	label: string,
): SqlIdentifier {
	const source = sources?.[index];
	if (source === undefined) {
		throw new Error(
			`Mutation RETURNING source '${label}' has no addressed identifier.`,
		);
	}
	return source;
}

function sourceColumnPair(column: {
	target: SqlIdentifier;
	source: SqlIdentifier;
	targetAddress?: MutationColumnAddress;
	sourceAddress?: MutationColumnAddress;
}): { target: SqlIdentifier; source: SqlIdentifier } {
	return {
		target: column.targetAddress?.physicalName ?? column.target,
		source: column.sourceAddress?.physicalName ?? column.source,
	};
}

// ============================================================================
// Types
// ============================================================================

/** Resolver-addressed declared column carried beside its physical SQL name. */
export interface MutationColumnAddress {
	readonly logicalTable: string;
	readonly logicalColumn: string;
	readonly physicalName: SqlIdentifier;
}

export interface MutationColumnMetadata extends MutationColumnAddress {
	readonly databaseType: string;
}

export interface MutationTableMetadata {
	readonly logicalTable: string;
	readonly physicalName: SqlIdentifier;
}

export type MutationColumnTypes = Record<
	string,
	string | MutationColumnMetadata
>;

export function mutationColumnType(
	columnTypes: MutationColumnTypes | undefined,
	physicalName: SqlIdentifier,
): string | undefined {
	const metadata = columnTypes?.[physicalName];
	if (typeof metadata === 'object' && metadata.physicalName !== physicalName) {
		throw new Error(
			`Mutation column metadata for '${metadata.logicalTable}.${metadata.logicalColumn}' addresses physical '${metadata.physicalName}' while the compiler uses '${physicalName}'.`,
		);
	}
	return typeof metadata === 'string' ? metadata : metadata?.databaseType;
}

/**
 * Configuration for INSERT compilation
 */
export interface InsertConfig {
	/** Table to insert into */
	table: SqlIdentifier;
	tableMetadata?: MutationTableMetadata;
	/** Columns to insert */
	columns: SqlIdentifier[];
	/** Values for each column (array of rows) */
	values: unknown[][];
	/** Columns to return (RETURNING clause) */
	returning?: string[];
	/** Addressed declared sources for RETURNING labels. */
	returningSources?: SqlIdentifier[];
	/** Alias-aware RETURNING projection items */
	returningItems?: readonly MutationReturningItem[];
	/** Subquery for INSERT ... SELECT */
	selectQuery?: Node;
	/** Column database types for type-cast emission (e.g. range types) */
	columnTypes?: MutationColumnTypes;
}

/**
 * Configuration for UPDATE compilation
 */
export interface UpdateConfig {
	/** Table to update */
	table: SqlIdentifier;
	tableMetadata?: MutationTableMetadata;
	/** Column-value pairs to set */
	set: { column: SqlIdentifier; value: unknown }[];
	/** WHERE conditions */
	where?: Decision[];
	/** Columns to return (RETURNING clause) */
	returning?: string[];
	returningSources?: SqlIdentifier[];
	/** Alias-aware RETURNING projection items */
	returningItems?: readonly MutationReturningItem[];
	/** Column database types for type-cast emission (e.g. range types) */
	columnTypes?: MutationColumnTypes;
}

/**
 * Configuration for DELETE compilation
 */
export interface DeleteConfig {
	/** Table to delete from */
	table: SqlIdentifier;
	tableMetadata?: MutationTableMetadata;
	/** WHERE conditions */
	where?: Decision[];
	/** Columns to return (RETURNING clause) */
	returning?: string[];
	returningSources?: SqlIdentifier[];
	/** Alias-aware RETURNING projection items */
	returningItems?: readonly MutationReturningItem[];
}

/**
 * Configuration for INSERT FROM SELECT compilation
 */
export interface InsertFromConfig {
	/** Target table to insert into */
	targetTable: SqlIdentifier;
	targetTableMetadata?: MutationTableMetadata;
	/** Source table to select from */
	source: RelationBinding;
	/** Addressed target and source columns. */
	columns?: {
		target: SqlIdentifier;
		source: SqlIdentifier;
		targetAddress?: MutationColumnAddress;
		sourceAddress?: MutationColumnAddress;
	}[];
	/** WHERE conditions for source query */
	where?: Decision[];
	/** LIMIT for source query */
	limit?: number | ParamIntent;
	/** Columns to return (RETURNING clause) */
	returning?: string[];
	returningSources?: SqlIdentifier[];
	/** Alias-aware RETURNING projection items */
	returningItems?: readonly MutationReturningItem[];
}

export interface UpsertFromConfig {
	/** Target table to upsert into */
	targetTable: SqlIdentifier;
	targetTableMetadata?: MutationTableMetadata;
	/** Source table to select from */
	source: RelationBinding;
	/** Conflict target columns for ON CONFLICT */
	conflictColumns: SqlIdentifier[];
	conflictColumnAddresses?: MutationColumnAddress[];
	/** Addressed target and source columns. */
	columns?: {
		target: SqlIdentifier;
		source: SqlIdentifier;
		targetAddress?: MutationColumnAddress;
		sourceAddress?: MutationColumnAddress;
	}[];
	/** WHERE conditions for source query */
	where?: Decision[];
	/** LIMIT for source query */
	limit?: number | ParamIntent;
	/** Columns to return (RETURNING clause) */
	returning?: string[];
	returningSources?: SqlIdentifier[];
	/** Alias-aware RETURNING projection items */
	returningItems?: readonly MutationReturningItem[];
}

// ============================================================================
// Compilers
// ============================================================================

/**
 * Compile an INSERT statement from configuration.
 */
export function compileInsert(
	config: InsertConfig,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	const dbTable = config.tableMetadata?.physicalName ?? config.table;
	const dbColumns = config.columns;

	// Build VALUES as Node[][] (each row is Node[])
	const columnTypes = config.columnTypes;
	const columns = config.columns;
	const valuesRows: Node[][] = config.values.map((row) =>
		row.map((val, i) => {
			const colName = columns[i];
			const dbType = colName
				? mutationColumnType(columnTypes, colName)
				: undefined;
			return val === DEFAULT_INSERT_CELL
				? { SetToDefault: {} }
				: valueToNode(val, state, dbType);
		}),
	);

	// Build RETURNING clause if specified
	const returningExprs = buildReturningExprs(
		config.returning,
		dbTable,
		config.returningSources,
		config.returningItems,
	);

	// Build INSERT statement using helper
	// Use spread to conditionally include optional properties (exactOptionalPropertyTypes)
	const options: SqlInsertOptions = {
		table: dbTable,
		columns: dbColumns,
		values: valuesRows,
	};
	if (ctx.schema) options.schema = queryLocal(ctx.schema);
	if (returningExprs) options.returning = returningExprs;

	return sqlInsertStmt(options);
}

/**
 * Compile an INSERT statement using the unnest strategy for large batches.
 *
 * Generates:
 *   INSERT INTO "table" ("col1", "col2")
 *   SELECT unnest($1::int4[]), unnest($2::text[])
 *   [RETURNING ...]
 *
 * This avoids the PostgreSQL 65535 parameter limit that VALUES clauses hit
 * at ~5000 rows with 12 columns. Uses N parameters regardless of row count.
 */
/**
 * Compile an INSERT statement using the unnest strategy for large batches.
 *
 * Generates:
 *   INSERT INTO "table" ("col1", "col2")
 *   SELECT unnest($1::int4[]), unnest($2::text[])
 *   [RETURNING ...]
 *
 * This avoids the PostgreSQL 65535 parameter limit that VALUES clauses hit
 * at ~5000 rows with 12 columns. Uses N parameters regardless of row count.
 */
export function compileUnnestInsert(
	config: InsertConfig,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	const dbTable = config.tableMetadata?.physicalName ?? config.table;
	const { values, columnTypes } = config;
	const columns = config.columns;

	// Validate cardinality before any SQL generation (INV-02)
	validateBatchCardinality(columns, values);

	// Transpose row-major → column-major
	const columnArrays = transposeToColumnArrays(columns, values);

	// Build SELECT target list: unnest($N::type[]) AS "col"
	const targetList: Node[] = columns.map((col, i) => {
		// columnArrays[i] is always defined (transposeToColumnArrays maps over columns),
		// but TypeScript doesn't know that — use a safe fallback.
		const colArray: unknown[] = columnArrays[i] ?? [];

		// Find a non-null sample value for runtime type fallback
		const sampleValue = colArray.find((v) => v !== null && v !== undefined);

		// Strip the trailing [] to get base type (inferPgArrayType returns e.g. "int4[]")
		const pgArrayType = inferPgArrayType(col, columnTypes, sampleValue);
		const pgBaseType = stripArraySuffix(pgArrayType);

		// Add array parameter and get its 1-based index
		state.parameters.push(colArray);
		state.paramIndex++;
		const paramIdx = state.paramIndex;

		// Build: unnest($N::base_type[])
		const typeCasted = createTypeCastParamRef(paramIdx, pgBaseType, true);
		const unnestCall = funcCall('unnest', [typeCasted]);

		// ResTarget with column alias: unnest(...) AS "colname"
		return sqlResTarget(unnestCall, col);
	});

	// Build the SELECT statement for INSERT ... SELECT (no op field = SETOP_NONE by default)
	const selectQuery: Node = {
		SelectStmt: {
			targetList,
		},
	};

	// Build RETURNING clause if specified
	const returningExprs = buildReturningExprs(
		config.returning,
		dbTable,
		config.returningSources,
		config.returningItems,
	);

	// Build INSERT INTO "table" ("col1", "col2") <selectQuery>
	const options: SqlInsertOptions = {
		table: dbTable,
		columns,
		selectQuery,
	};
	if (ctx.schema) options.schema = queryLocal(ctx.schema);
	if (returningExprs) options.returning = returningExprs;

	return sqlInsertStmt(options);
}

/**
 * Compile an UPDATE statement from configuration.
 */
export function compileUpdate(
	config: UpdateConfig,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	const tableAlias = config.tableMetadata?.physicalName ?? config.table;

	// Build SET clause - convert unknown values to Node.
	// Raw SQL expressions (SqlRawExpression) are parsed directly into AST nodes;
	// all other values become parameterized $N references.
	const columnTypes = config.columnTypes;
	const setClause: Array<{ column: SqlIdentifier; value: Node }> =
		config.set.map(({ column, value }) => ({
			column,
			value: assignmentToNode(
				value,
				state,
				mutationColumnType(columnTypes, column),
			),
		}));

	// Build WHERE clause if present
	let whereClause: Node | undefined;
	if (config.where && config.where.length > 0) {
		const dispatch = createWhereDispatcher(compileWhereIntent);
		const subCtx = { ...ctx, currentAlias: tableAlias };

		if (config.where.length === 1) {
			whereClause = dispatch(config.where[0]!, subCtx, state);
		} else {
			const conditions = config.where.map((cond) =>
				dispatch(cond, subCtx, state),
			);
			whereClause = {
				BoolExpr: {
					boolop: 'AND_EXPR',
					args: conditions,
				},
			};
		}
	}

	// Build RETURNING clause if specified
	const returningExprs = buildReturningExprs(
		config.returning,
		tableAlias,
		config.returningSources,
		config.returningItems,
	);

	// Build UPDATE statement (exactOptionalPropertyTypes compatible)
	const options: SqlUpdateOptions = {
		table: tableAlias,
		set: setClause,
	};
	if (ctx.schema) options.schema = queryLocal(ctx.schema);
	if (whereClause) options.where = whereClause;
	if (returningExprs) options.returning = returningExprs;

	return sqlUpdateStmt(options);
}

/**
 * Compile a DELETE statement from configuration.
 */

/**
 * Configuration for batch UPDATE via unnest (BATCH-001).
 */
export interface BatchUpdateConfig {
	/** Target table name */
	table: SqlIdentifier;
	tableMetadata?: MutationTableMetadata;
	/** Column(s) used to join for WHERE clause */
	matchColumns: SqlIdentifier[];
	/** All columns (match + update), extracted from updates[0] */
	allColumns: SqlIdentifier[];
	/** Column-major arrays: [[match_vals...], [update_vals...], ...] */
	columnArrays: unknown[][];
	/** Optional scalar SET assignments applied to all rows */
	scalarSet?: { column: SqlIdentifier; value: unknown }[];
	/** Columns to return (RETURNING clause) */
	returning?: string[];
	returningSources?: SqlIdentifier[];
	/** Alias-aware RETURNING projection items */
	returningItems?: readonly MutationReturningItem[];
	/** Column database types for type-cast emission */
	columnTypes?: MutationColumnTypes;
	/** Optional extra WHERE guard appended as AND after match conditions */
	whereGuard?: Node;
}

/**
 * Compile a batch UPDATE statement using the unnest FROM strategy (BATCH-001).
 *
 * Generates:
 *   UPDATE "table" SET "update_col" = t."update_col" [, "scalar_col" = $N]
 *   FROM unnest(CAST($1 AS type[]), CAST($2 AS type[])) AS t("match_col", "update_col")
 *   WHERE "table"."match_col" = t."match_col"
 *   [RETURNING ...]
 */
export function compileUnnestUpdate(
	config: BatchUpdateConfig,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	const { table, matchColumns, allColumns, columnArrays, columnTypes } = config;
	const dbTable = table;
	let sourceAlias = 't';
	for (let index = 1; sourceAlias === dbTable; index++)
		sourceAlias = `t${index}`;
	const dbMatchColumns = matchColumns;
	const dbAllColumns = allColumns;
	const updateColumns = dbAllColumns.filter((c) => !dbMatchColumns.includes(c));

	// Build unnest arguments: CAST($N AS type[]) for each column
	const unnestArgs: Node[] = dbAllColumns.map((col, i) => {
		const colArray: unknown[] = columnArrays[i] ?? [];
		const sampleValue = colArray.find((v) => v !== null && v !== undefined);
		const pgArrayType = inferPgArrayType(col, columnTypes, sampleValue);
		// pgArrayType is already "type[]"; strip [] to get base type for createTypeCastParamRef
		const pgBaseType = stripArraySuffix(pgArrayType);

		state.parameters.push(colArray);
		state.paramIndex++;
		const paramIdx = state.paramIndex;

		return createTypeCastParamRef(paramIdx, pgBaseType, true);
	});

	// Build: FROM unnest(CAST($1 AS int4[]), ...) AS t("col1", "col2", ...)
	const unnestCall = funcCall('unnest', unnestArgs);
	const rangeFunction: Node = {
		RangeFunction: {
			functions: [{ List: { items: [unnestCall] } }],
			alias: {
				aliasname: sourceAlias,
				colnames: dbAllColumns.map((c) => ({
					String: { sval: c },
				})),
			},
		},
	};

	// Build SET clause: update cols = t."col", scalar cols = $N
	const setClause: Array<{ column: SqlIdentifier; value: Node }> = [
		// Array-sourced update columns: "col" = t."col"
		...updateColumns.map((col) => ({
			column: col,
			value: sqlColumnRef(col, queryLocal(sourceAlias)),
		})),
		// Scalar SET from scalarSet (e.g. .set({ confidence: 0.85 }))
		...(config.scalarSet ?? []).map(({ column, value }) => ({
			column,
			value: assignmentToNode(
				value,
				state,
				mutationColumnType(columnTypes, column),
			),
		})),
	];

	// Build WHERE: "table"."match_col" = t."match_col" [AND ...]
	const matchConditions: Node[] = dbMatchColumns.map((col) => ({
		A_Expr: {
			kind: 'AEXPR_OP',
			name: [{ String: { sval: '=' } }],
			lexpr: sqlColumnRef(col, dbTable),
			rexpr: sqlColumnRef(col, queryLocal(sourceAlias)),
		},
	}));

	const matchWhere: Node =
		matchConditions.length === 1
			? matchConditions[0]!
			: {
					BoolExpr: {
						boolop: 'AND_EXPR',
						args: matchConditions,
					},
				};

	// Append optional whereGuard as AND <extra> after the batch match condition
	const whereClause: Node = config.whereGuard
		? {
				BoolExpr: {
					boolop: 'AND_EXPR',
					args: [matchWhere, config.whereGuard],
				},
			}
		: matchWhere;

	// Build RETURNING clause if specified
	const returningExprs = buildReturningExprs(
		config.returning,
		dbTable,
		config.returningSources,
		config.returningItems,
	);

	// Build UPDATE statement
	const options: SqlUpdateOptions = {
		table: dbTable,
		set: setClause,
		from: [rangeFunction],
		where: whereClause,
	};
	if (ctx.schema) options.schema = queryLocal(ctx.schema);
	if (returningExprs) options.returning = returningExprs;

	return sqlUpdateStmt(options);
}

export function compileDelete(
	config: DeleteConfig,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	const tableAlias = config.tableMetadata?.physicalName ?? config.table;

	// Build WHERE clause if present
	let whereClause: Node | undefined;
	if (config.where && config.where.length > 0) {
		const dispatch = createWhereDispatcher(compileWhereIntent);
		const subCtx = { ...ctx, currentAlias: tableAlias };

		if (config.where.length === 1) {
			whereClause = dispatch(config.where[0]!, subCtx, state);
		} else {
			const conditions = config.where.map((cond) =>
				dispatch(cond, subCtx, state),
			);
			whereClause = {
				BoolExpr: {
					boolop: 'AND_EXPR',
					args: conditions,
				},
			};
		}
	}

	// Build RETURNING clause if specified
	const returningExprs = buildReturningExprs(
		config.returning,
		tableAlias,
		config.returningSources,
		config.returningItems,
	);

	// Build DELETE statement (exactOptionalPropertyTypes compatible)
	const options: SqlDeleteOptions = {
		table: tableAlias,
	};
	if (ctx.schema) options.schema = queryLocal(ctx.schema);
	if (whereClause) options.where = whereClause;
	if (returningExprs) options.returning = returningExprs;

	return sqlDeleteStmt(options);
}

/**
 * Compile an INSERT FROM SELECT statement from configuration.
 * INSERT INTO target (cols) SELECT cols FROM source WHERE ... LIMIT ... RETURNING ...
 */
export function compileInsertFrom(
	config: InsertFromConfig,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	const source = config.source;
	const sourceAlias = source.qualifier;
	const sourceSchema =
		source.kind === 'declared-table' && ctx.schema
			? queryLocal(ctx.schema)
			: undefined;
	const dbColumns = config.columns
		?.map(sourceColumnPair)
		.map(({ target }) => target);

	// Build SELECT target list
	let targetList: Node[];
	if (config.columns && config.columns.length > 0) {
		targetList = config.columns
			.map(sourceColumnPair)
			.map(({ target, source: sourceColumn }) =>
				sqlResTarget(
					sqlColumnRef(sourceColumn, sourceAlias, sourceSchema),
					target,
				),
			);
	} else {
		// SELECT *
		targetList = [
			{
				ResTarget: {
					val: { ColumnRef: { fields: [{ A_Star: {} }] } },
				},
			},
		];
	}

	// Build WHERE clause for source query if present
	let whereClause: Node | undefined;
	if (config.where && config.where.length > 0) {
		const dispatch = createWhereDispatcher(compileWhereIntent);
		const subCtx = { ...ctx, currentAlias: sourceAlias };

		if (config.where.length === 1) {
			whereClause = dispatch(config.where[0]!, subCtx, state);
		} else {
			const conditions = config.where.map((cond) =>
				dispatch(cond, subCtx, state),
			);
			whereClause = {
				BoolExpr: {
					boolop: 'AND_EXPR',
					args: conditions,
				},
			};
		}
	}

	// Build LIMIT clause if specified
	let limitCount: Node | undefined;
	if (config.limit !== undefined) {
		limitCount = limitToNode(config.limit, state);
	}

	// Build the SELECT query
	const selectQuery: Node = {
		SelectStmt: {
			targetList,
			fromClause: [
				{
					RangeVar: {
						relname: sourceAlias,
						...(sourceSchema !== undefined && { schemaname: sourceSchema }),
						inh: true,
						relpersistence: 'p',
					},
				},
			],
			...(whereClause && { whereClause }),
			...(limitCount && { limitCount }),
		},
	};

	// Build RETURNING clause for INSERT if specified
	const targetTable =
		config.targetTableMetadata?.physicalName ?? config.targetTable;
	const returningExprs = buildReturningExprs(
		config.returning,
		targetTable,
		config.returningSources,
		config.returningItems,
	);

	// Build INSERT statement with SELECT query
	// Note: dbTargetTable is computed but table in options uses logical name
	// The addressed target is passed directly to the typed AST facade.
	const options: SqlInsertOptions = {
		table: targetTable,
		selectQuery,
	};
	if (dbColumns) options.columns = dbColumns;
	if (ctx.schema) options.schema = queryLocal(ctx.schema);
	if (returningExprs) options.returning = returningExprs;

	return sqlInsertStmt(options);
}

/**
 * Compile an UPSERT FROM statement (INSERT ... SELECT ... ON CONFLICT DO UPDATE).
 *
 * Produces: INSERT INTO target SELECT ... FROM source ON CONFLICT (cols) DO UPDATE SET col = EXCLUDED.col
 */
export function compileUpsertFrom(
	config: UpsertFromConfig,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	const source = config.source;
	const sourceAlias = source.qualifier;
	const sourceSchema =
		source.kind === 'declared-table' && ctx.schema
			? queryLocal(ctx.schema)
			: undefined;
	const dbColumns = config.columns
		?.map(sourceColumnPair)
		.map(({ target }) => target);

	// Build SELECT target list
	let targetList: Node[];
	if (config.columns && config.columns.length > 0) {
		targetList = config.columns
			.map(sourceColumnPair)
			.map(({ target, source: sourceColumn }) =>
				sqlResTarget(
					sqlColumnRef(sourceColumn, sourceAlias, sourceSchema),
					target,
				),
			);
	} else {
		// SELECT *
		targetList = [
			{
				ResTarget: {
					val: { ColumnRef: { fields: [{ A_Star: {} }] } },
				},
			},
		];
	}

	// Build WHERE clause for source query if present
	let whereClause: Node | undefined;
	if (config.where && config.where.length > 0) {
		const dispatch = createWhereDispatcher(compileWhereIntent);
		const subCtx = { ...ctx, currentAlias: sourceAlias };

		if (config.where.length === 1) {
			whereClause = dispatch(config.where[0]!, subCtx, state);
		} else {
			const conditions = config.where.map((cond) =>
				dispatch(cond, subCtx, state),
			);
			whereClause = {
				BoolExpr: {
					boolop: 'AND_EXPR',
					args: conditions,
				},
			};
		}
	}

	// Build LIMIT clause if specified
	let limitCount: Node | undefined;
	if (config.limit !== undefined) {
		limitCount = limitToNode(config.limit, state);
	}

	// Build the SELECT query
	const selectQuery: Node = {
		SelectStmt: {
			targetList,
			fromClause: [
				{
					RangeVar: {
						relname: sourceAlias,
						...(sourceSchema !== undefined && { schemaname: sourceSchema }),
						inh: true,
						relpersistence: 'p',
					},
				},
			],
			...(whereClause && { whereClause }),
			...(limitCount && { limitCount }),
		},
	};

	// Build RETURNING clause
	const targetTable =
		config.targetTableMetadata?.physicalName ?? config.targetTable;
	const returningExprs = buildReturningExprs(
		config.returning,
		targetTable,
		config.returningSources,
		config.returningItems,
	);

	// Build ON CONFLICT clause: DO UPDATE SET col = EXCLUDED.col for non-conflict columns
	const conflictColumns =
		config.conflictColumnAddresses?.map((address) => address.physicalName) ??
		config.conflictColumns;
	const conflictInfer = {
		indexElems: conflictColumns.map((col) => ({
			IndexElem: {
				name: col,
			},
		})),
	};

	// Determine update columns: all source columns minus conflict columns
	const updateColumns = config.columns
		? config.columns
				.map(sourceColumnPair)
				.filter(({ target }) => !conflictColumns.includes(target))
		: [];

	const onConflictTargetList: Node[] = updateColumns.map(
		({ target: dbCol }) => {
			return {
				ResTarget: {
					name: dbCol,
					val: {
						ColumnRef: {
							fields: [
								{ String: { sval: 'excluded' } },
								{ String: { sval: dbCol } },
							],
						},
					},
				},
			};
		},
	);

	// Build INSERT statement with SELECT query + ON CONFLICT
	const options: SqlInsertOptions = {
		table: targetTable,
		selectQuery,
	};
	if (dbColumns) options.columns = dbColumns;
	if (ctx.schema) options.schema = queryLocal(ctx.schema);
	if (returningExprs) options.returning = returningExprs;

	// Get base InsertStmt and add onConflictClause manually
	const node = sqlInsertStmt(options);
	const insertNode = (node as InsertStmtNode).InsertStmt;
	insertNode.onConflictClause = {
		action: 'ONCONFLICT_UPDATE',
		infer: conflictInfer,
		...(onConflictTargetList.length > 0 && {
			targetList: onConflictTargetList,
		}),
	};

	return node;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a JavaScript value to an AST node.
 * Uses parameters for actual values.
 */
/** PostgreSQL range types that require explicit type-cast on parameter binding */
export const RANGE_TYPES = new Set([
	'daterange',
	'tsrange',
	'tstzrange',
	'int4range',
	'int8range',
	'numrange',
]);

export function valueToNode(
	value: unknown,
	state: CompilerState,
	dbType?: string,
	forceParam = false,
): Node {
	const isParam = isParamIntent(value);
	const boundValue = unwrapParamIntent(value);
	if (boundValue === null || boundValue === undefined) {
		if (forceParam || isParam) {
			state.parameters.push(boundValue);
			state.paramIndex++;
			return dbType && RANGE_TYPES.has(dbType)
				? typeCast({ ParamRef: { number: state.paramIndex } }, dbType)
				: {
						ParamRef: {
							number: state.paramIndex,
						},
					};
		}
		return { A_Const: { isnull: true } };
	}

	// Add to parameters and return a ParamRef
	state.parameters.push(boundValue);
	state.paramIndex++;

	// Range types require explicit cast ($N::int4range) for PostgreSQL to parse the literal
	if (dbType && RANGE_TYPES.has(dbType)) {
		return typeCast({ ParamRef: { number: state.paramIndex } }, dbType);
	}

	return {
		ParamRef: {
			number: state.paramIndex,
		},
	};
}

function limitToNode(limit: number | ParamIntent, state: CompilerState): Node {
	if (isParamIntent(limit)) {
		state.parameters.push(unwrapParamIntent(limit));
		state.paramIndex++;
		return {
			ParamRef: {
				number: state.paramIndex,
			},
		};
	}
	return { A_Const: { ival: { ival: limit } } };
}

/**
 * Compile a mutation decision to AST.
 * Determines mutation type from decision.type and delegates.
 */
export function compileMutation(
	decision: Decision,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	const type = decision.type;
	if (type !== 'insert' && type !== 'update' && type !== 'delete') {
		throw new Error(`Unknown mutation type: ${type}`);
	}
	const table = decision.table ?? ctx.rootTable;
	const addressedTable = resolveDeclaredIdentifier(
		ctx.declaredNames,
		ctx.dbCasing ?? 'preserve',
		{ kind: 'table', table },
	);

	switch (type) {
		case 'insert': {
			const columns = decision.columns?.map((column) =>
				resolveDeclaredIdentifier(
					ctx.declaredNames,
					ctx.dbCasing ?? 'preserve',
					{
						kind: 'column',
						table,
						column,
					},
				),
			);
			const insertConfig: InsertConfig = {
				table: addressedTable,
				columns: columns ?? [],
				values: decision.values ? [[...decision.values] as unknown[]] : [],
			};
			if (decision.columns) {
				insertConfig.returning = [...decision.columns];
				insertConfig.returningSources = decision.columns.map((column) =>
					resolveDeclaredIdentifier(
						ctx.declaredNames,
						ctx.dbCasing ?? 'preserve',
						{
							kind: 'column',
							table,
							column,
						},
					),
				);
			}
			return compileInsert(insertConfig, ctx, state);
		}

		case 'update': {
			const set = decision.set?.map(({ column, value }) => ({
				column: resolveDeclaredIdentifier(
					ctx.declaredNames,
					ctx.dbCasing ?? 'preserve',
					{ kind: 'column', table, column },
				),
				value,
			}));
			const updateConfig: UpdateConfig = {
				table: addressedTable,
				set: set ?? [],
			};
			if (decision.conditions) updateConfig.where = [...decision.conditions];
			if (decision.columns) {
				updateConfig.returning = [...decision.columns];
				updateConfig.returningSources = decision.columns.map((column) =>
					resolveDeclaredIdentifier(
						ctx.declaredNames,
						ctx.dbCasing ?? 'preserve',
						{
							kind: 'column',
							table,
							column,
						},
					),
				);
			}
			return compileUpdate(updateConfig, ctx, state);
		}

		case 'delete': {
			const deleteConfig: DeleteConfig = {
				table: addressedTable,
			};
			if (decision.conditions) deleteConfig.where = [...decision.conditions];
			if (decision.columns) {
				deleteConfig.returning = [...decision.columns];
				deleteConfig.returningSources = decision.columns.map((column) =>
					resolveDeclaredIdentifier(
						ctx.declaredNames,
						ctx.dbCasing ?? 'preserve',
						{
							kind: 'column',
							table,
							column,
						},
					),
				);
			}
			return compileDelete(deleteConfig, ctx, state);
		}

		default:
			throw new Error(`Unknown mutation type: ${type}`);
	}
}

/** Internal sentinel for an absent insert cell; explicit undefined is SQL NULL. */
export const DEFAULT_INSERT_CELL = Symbol('default insert cell');

function assignmentToNode(
	value: unknown,
	state: CompilerState,
	dbType: string | undefined,
): Node {
	return isSqlRaw(value)
		? parseRawExpression(value.sql)
		: valueToNode(value, state, dbType);
}
