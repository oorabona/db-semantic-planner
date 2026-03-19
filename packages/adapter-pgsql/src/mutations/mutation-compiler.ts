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

import type { Node } from '@pgsql/types';
import { isSqlRaw } from '@dbsp/core';
import {
	columnRef,
	type DeleteOptions,
	deleteStmt,
	funcCall,
	type InsertOptions,
	insertStmt,
	resTarget,
	type UpdateOptions,
	updateStmt,
} from '../ast-helpers.js';
import { createWhereDispatcher } from '../handlers/index.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	InsertStmtNode,
} from '../handlers/types.js';
import { createTypeCastParamRef } from '../param-ref.js';
import {
	inferPgArrayType,
	parseRawExpression,
	transposeToColumnArrays,
	validateBatchCardinality,
} from '../compiler-utils.js';

// ============================================================================
// Shared Helpers
// ============================================================================

/**
 * Build RETURNING clause AST nodes from column names.
 * Shared across INSERT, UPDATE, DELETE, UPSERT, and INSERT FROM.
 */
export function buildReturningList(
	columns: readonly string[] | undefined,
	tableRef: string,
	ctx: CompilerContext,
): Node[] | undefined {
	if (!columns || columns.length === 0) return undefined;
	const { naming } = ctx;
	return columns.map((col) =>
		resTarget(
			columnRef(col, tableRef, ctx.schema, naming),
			naming.toDatabase(col),
		),
	);
}

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for INSERT compilation
 */
export interface InsertConfig {
	/** Table to insert into */
	table: string;
	/** Columns to insert */
	columns: string[];
	/** Values for each column (array of rows) */
	values: unknown[][];
	/** Columns to return (RETURNING clause) */
	returning?: string[];
	/** Subquery for INSERT ... SELECT */
	selectQuery?: Node;
	/** Column database types for type-cast emission (e.g. range types) */
	columnTypes?: Record<string, string>;
}

/**
 * Configuration for UPDATE compilation
 */
export interface UpdateConfig {
	/** Table to update */
	table: string;
	/** Column-value pairs to set */
	set: { column: string; value: unknown }[];
	/** WHERE conditions */
	where?: Decision[];
	/** Columns to return (RETURNING clause) */
	returning?: string[];
	/** Column database types for type-cast emission (e.g. range types) */
	columnTypes?: Record<string, string>;
}

/**
 * Configuration for DELETE compilation
 */
export interface DeleteConfig {
	/** Table to delete from */
	table: string;
	/** WHERE conditions */
	where?: Decision[];
	/** Columns to return (RETURNING clause) */
	returning?: string[];
}

/**
 * Configuration for INSERT FROM SELECT compilation
 */
export interface InsertFromConfig {
	/** Target table to insert into */
	targetTable: string;
	/** Source table to select from */
	sourceTable: string;
	/** Columns to insert (same names in target and source) */
	columns?: string[];
	/** WHERE conditions for source query */
	where?: Decision[];
	/** LIMIT for source query */
	limit?: number;
	/** Columns to return (RETURNING clause) */
	returning?: string[];
}

export interface UpsertFromConfig {
	/** Target table to upsert into */
	targetTable: string;
	/** Source table to select from */
	sourceTable: string;
	/** Conflict target columns for ON CONFLICT */
	conflictColumns: string[];
	/** Columns to insert (same names in target and source) */
	columns?: string[];
	/** WHERE conditions for source query */
	where?: Decision[];
	/** LIMIT for source query */
	limit?: number;
	/** Columns to return (RETURNING clause) */
	returning?: string[];
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
	const naming = ctx.naming;
	const dbTable = naming.toDatabase(config.table);
	const dbColumns = config.columns.map((c) => naming.toDatabase(c));

	// Build VALUES as Node[][] (each row is Node[])
	const columnTypes = config.columnTypes;
	const columns = config.columns;
	const valuesRows: Node[][] = config.values.map((row) =>
		row.map((val, i) => {
			const colName = columns[i];
			const dbType = colName ? columnTypes?.[colName] : undefined;
			return valueToNode(val, state, dbType);
		}),
	);

	// Build RETURNING clause if specified
	const returningList = buildReturningList(config.returning, dbTable, ctx);

	// Build INSERT statement using helper
	// Use spread to conditionally include optional properties (exactOptionalPropertyTypes)
	const options: InsertOptions = {
		table: config.table,
		columns: dbColumns,
		values: valuesRows,
		naming,
	};
	if (ctx.schema) options.schema = ctx.schema;
	if (returningList) options.returning = returningList;

	return insertStmt(options);
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
	const naming = ctx.naming;
	const dbTable = naming.toDatabase(config.table);
	const { columns, values, columnTypes } = config;

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
		const pgBaseType = pgArrayType.endsWith('[]')
			? pgArrayType.slice(0, -2)
			: pgArrayType;

		// Add array parameter and get its 1-based index
		state.parameters.push(colArray);
		state.paramIndex++;
		const paramIdx = state.paramIndex;

		// Build: unnest($N::base_type[])
		const typeCasted = createTypeCastParamRef(paramIdx, pgBaseType, true);
		const unnestCall = funcCall('unnest', [typeCasted]);

		// ResTarget with column alias: unnest(...) AS "colname"
		return {
			ResTarget: {
				name: naming.toDatabase(col),
				val: unnestCall,
			},
		};
	});

	// Build the SELECT statement for INSERT ... SELECT (no op field = SETOP_NONE by default)
	const selectQuery: Node = {
		SelectStmt: {
			targetList,
		},
	};

	// Build RETURNING clause if specified
	const returningList = buildReturningList(config.returning, dbTable, ctx);

	// Build INSERT INTO "table" ("col1", "col2") <selectQuery>
	const options: InsertOptions = {
		table: config.table,
		columns: columns.map((c) => naming.toDatabase(c)),
		selectQuery,
		naming,
	};
	if (ctx.schema) options.schema = ctx.schema;
	if (returningList) options.returning = returningList;

	return insertStmt(options);
}


/**
 * Compile an UPDATE statement from configuration.
 */
export function compileUpdate(
	config: UpdateConfig,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	const naming = ctx.naming;
	const tableAlias = config.table;

	// Build SET clause - convert unknown values to Node.
	// Raw SQL expressions (SqlRawExpression) are parsed directly into AST nodes;
	// all other values become parameterized $N references.
	const columnTypes = config.columnTypes;
	const setClause: Array<{ column: string; value: Node }> = config.set.map(
		({ column, value }) => ({
			column: naming.toDatabase(column),
			value: isSqlRaw(value)
				? parseRawExpression(value.sql)
				: valueToNode(value, state, columnTypes?.[column]),
		}),
	);

	// Build WHERE clause if present
	let whereClause: Node | undefined;
	if (config.where && config.where.length > 0) {
		const dispatch = createWhereDispatcher();
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
	const returningList = buildReturningList(config.returning, tableAlias, ctx);

	// Build UPDATE statement (exactOptionalPropertyTypes compatible)
	const options: UpdateOptions = {
		table: config.table,
		set: setClause,
		naming,
	};
	if (ctx.schema) options.schema = ctx.schema;
	if (whereClause) options.where = whereClause;
	if (returningList) options.returning = returningList;

	return updateStmt(options);
}

/**
 * Compile a DELETE statement from configuration.
 */

/**
 * Configuration for batch UPDATE via unnest (BATCH-001).
 */
export interface BatchUpdateConfig {
	/** Target table name */
	table: string;
	/** Column(s) used to join for WHERE clause */
	matchColumns: string[];
	/** All columns (match + update), extracted from updates[0] */
	allColumns: string[];
	/** Column-major arrays: [[match_vals...], [update_vals...], ...] */
	columnArrays: unknown[][];
	/** Optional scalar SET assignments applied to all rows */
	scalarSet?: { column: string; value: unknown }[];
	/** Columns to return (RETURNING clause) */
	returning?: string[];
	/** Column database types for type-cast emission */
	columnTypes?: Record<string, string>;
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
	const naming = ctx.naming;
	const { table, matchColumns, allColumns, columnArrays, columnTypes } = config;
	const dbTable = naming.toDatabase(table);
	const updateColumns = allColumns.filter((c) => !matchColumns.includes(c));

	// Build unnest arguments: CAST($N AS type[]) for each column
	const unnestArgs: Node[] = allColumns.map((col, i) => {
		const colArray: unknown[] = columnArrays[i] ?? [];
		const sampleValue = colArray.find((v) => v !== null && v !== undefined);
		const pgArrayType = inferPgArrayType(col, columnTypes, sampleValue);
		// pgArrayType is already "type[]"; strip [] to get base type for createTypeCastParamRef
		const pgBaseType = pgArrayType.endsWith('[]')
			? pgArrayType.slice(0, -2)
			: pgArrayType;

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
				aliasname: 't',
				colnames: allColumns.map((c) => ({
					String: { sval: naming.toDatabase(c) },
				})),
			},
		},
	};

	// Build SET clause: update cols = t."col", scalar cols = $N
	const setClause: Array<{ column: string; value: Node }> = [
		// Array-sourced update columns: "col" = t."col"
		...updateColumns.map((col) => ({
			column: naming.toDatabase(col),
			value: columnRef(col, 't', undefined, naming),
		})),
		// Scalar SET from scalarSet (e.g. .set({ confidence: 0.85 }))
		...(config.scalarSet ?? []).map(({ column, value }) => ({
			column: naming.toDatabase(column),
			value: valueToNode(value, state, columnTypes?.[column]),
		})),
	];

	// Build WHERE: "table"."match_col" = t."match_col" [AND ...]
	const matchConditions: Node[] = matchColumns.map((col) => ({
		A_Expr: {
			kind: 'AEXPR_OP',
			name: [{ String: { sval: '=' } }],
			lexpr: columnRef(col, dbTable, undefined, naming),
			rexpr: columnRef(col, 't', undefined, naming),
		},
	}));

	const whereClause: Node =
		matchConditions.length === 1
			? matchConditions[0]!
			: {
					BoolExpr: {
						boolop: 'AND_EXPR',
						args: matchConditions,
					},
				};

	// Build RETURNING clause if specified
	const returningList = buildReturningList(config.returning, dbTable, ctx);

	// Build UPDATE statement
	const options: UpdateOptions = {
		table,
		set: setClause,
		naming,
		from: [rangeFunction],
		where: whereClause,
	};
	if (ctx.schema) options.schema = ctx.schema;
	if (returningList) options.returning = returningList;

	return updateStmt(options);
}


export function compileDelete(
	config: DeleteConfig,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	const naming = ctx.naming;
	const tableAlias = config.table;

	// Build WHERE clause if present
	let whereClause: Node | undefined;
	if (config.where && config.where.length > 0) {
		const dispatch = createWhereDispatcher();
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
	const returningList = buildReturningList(config.returning, tableAlias, ctx);

	// Build DELETE statement (exactOptionalPropertyTypes compatible)
	const options: DeleteOptions = {
		table: config.table,
		naming,
	};
	if (ctx.schema) options.schema = ctx.schema;
	if (whereClause) options.where = whereClause;
	if (returningList) options.returning = returningList;

	return deleteStmt(options);
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
	const naming = ctx.naming;
	const _dbTargetTable = naming.toDatabase(config.targetTable);
	const dbSourceTable = naming.toDatabase(config.sourceTable);
	const sourceAlias = config.sourceTable;

	// Build column list
	const dbColumns = config.columns?.map((c) => naming.toDatabase(c));

	// Build SELECT target list
	let targetList: Node[];
	if (config.columns && config.columns.length > 0) {
		targetList = config.columns.map((col) =>
			resTarget(
				columnRef(col, sourceAlias, ctx.schema, naming),
				naming.toDatabase(col),
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
		const dispatch = createWhereDispatcher();
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
		limitCount = { A_Const: { ival: { ival: config.limit } } };
	}

	// Build the SELECT query
	const sourceRelation: {
		schemaname?: string;
		relname: string;
		inh: boolean;
		relpersistence: string;
		alias?: { aliasname: string };
	} = {
		relname: dbSourceTable,
		inh: true,
		relpersistence: 'p',
	};
	if (ctx.schema) {
		sourceRelation.schemaname = naming.toDatabase(ctx.schema);
	}

	const selectQuery: Node = {
		SelectStmt: {
			targetList,
			fromClause: [{ RangeVar: sourceRelation }],
			...(whereClause && { whereClause }),
			...(limitCount && { limitCount }),
		},
	};

	// Build RETURNING clause for INSERT if specified
	const returningList = buildReturningList(
		config.returning,
		config.targetTable,
		ctx,
	);

	// Build INSERT statement with SELECT query
	// Note: dbTargetTable is computed but table in options uses logical name
	// as insertStmt applies naming internally
	const options: InsertOptions = {
		table: config.targetTable,
		selectQuery,
		naming,
	};
	if (dbColumns) options.columns = dbColumns;
	if (ctx.schema) options.schema = ctx.schema;
	if (returningList) options.returning = returningList;

	return insertStmt(options);
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
	const naming = ctx.naming;
	const dbSourceTable = naming.toDatabase(config.sourceTable);
	const sourceAlias = config.sourceTable;

	// Build column list
	const dbColumns = config.columns?.map((c) => naming.toDatabase(c));

	// Build SELECT target list
	let targetList: Node[];
	if (config.columns && config.columns.length > 0) {
		targetList = config.columns.map((col) =>
			resTarget(
				columnRef(col, sourceAlias, ctx.schema, naming),
				naming.toDatabase(col),
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
		const dispatch = createWhereDispatcher();
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
		limitCount = { A_Const: { ival: { ival: config.limit } } };
	}

	// Build the SELECT query
	const sourceRelation: {
		schemaname?: string;
		relname: string;
		inh: boolean;
		relpersistence: string;
		alias?: { aliasname: string };
	} = {
		relname: dbSourceTable,
		inh: true,
		relpersistence: 'p',
	};
	if (ctx.schema) {
		sourceRelation.schemaname = naming.toDatabase(ctx.schema);
	}

	const selectQuery: Node = {
		SelectStmt: {
			targetList,
			fromClause: [{ RangeVar: sourceRelation }],
			...(whereClause && { whereClause }),
			...(limitCount && { limitCount }),
		},
	};

	// Build RETURNING clause
	const returningList = buildReturningList(
		config.returning,
		config.targetTable,
		ctx,
	);

	// Build ON CONFLICT clause: DO UPDATE SET col = EXCLUDED.col for non-conflict columns
	const conflictInfer = {
		indexElems: config.conflictColumns.map((col) => ({
			IndexElem: {
				name: naming.toDatabase(col),
			},
		})),
	};

	// Determine update columns: all source columns minus conflict columns
	const updateColumns = config.columns
		? config.columns.filter((c) => !config.conflictColumns.includes(c))
		: [];

	const onConflictTargetList: Node[] = updateColumns.map((col) => {
		const dbCol = naming.toDatabase(col);
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
	});

	// Build INSERT statement with SELECT query + ON CONFLICT
	const options: InsertOptions = {
		table: config.targetTable,
		selectQuery,
		naming,
	};
	if (dbColumns) options.columns = dbColumns;
	if (ctx.schema) options.schema = ctx.schema;
	if (returningList) options.returning = returningList;

	// Get base InsertStmt and add onConflictClause manually
	const node = insertStmt(options);
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

function valueToNode(
	value: unknown,
	state: CompilerState,
	dbType?: string,
): Node {
	if (value === null || value === undefined) {
		return { A_Const: { isnull: true } };
	}

	// Add to parameters and return a ParamRef
	state.parameters.push(value);
	state.paramIndex++;

	// Range types require explicit cast ($N::int4range) for PostgreSQL to parse the literal
	if (dbType && RANGE_TYPES.has(dbType)) {
		return createTypeCastParamRef(state.paramIndex, dbType);
	}

	return {
		ParamRef: {
			number: state.paramIndex,
		},
	};
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
	const table = decision.table ?? ctx.rootTable;

	switch (type) {
		case 'insert': {
			const insertConfig: InsertConfig = {
				table,
				columns: decision.columns ? [...decision.columns] : [],
				values: decision.values ? [[...decision.values] as unknown[]] : [],
			};
			if (decision.columns) insertConfig.returning = [...decision.columns];
			return compileInsert(insertConfig, ctx, state);
		}

		case 'update': {
			const updateConfig: UpdateConfig = {
				table,
				set: decision.set ? [...decision.set] : [],
			};
			if (decision.conditions) updateConfig.where = [...decision.conditions];
			if (decision.columns) updateConfig.returning = [...decision.columns];
			return compileUpdate(updateConfig, ctx, state);
		}

		case 'delete': {
			const deleteConfig: DeleteConfig = {
				table,
			};
			if (decision.conditions) deleteConfig.where = [...decision.conditions];
			if (decision.columns) deleteConfig.returning = [...decision.columns];
			return compileDelete(deleteConfig, ctx, state);
		}

		default:
			throw new Error(`Unknown mutation type: ${type}`);
	}
}
