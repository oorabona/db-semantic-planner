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
import {
	columnRef,
	type DeleteOptions,
	deleteStmt,
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
} from '../handlers/types.js';
import { createTypeCastParamRef } from '../param-ref.js';

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
 * Compile an UPDATE statement from configuration.
 */
export function compileUpdate(
	config: UpdateConfig,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	const naming = ctx.naming;
	const tableAlias = config.table;

	// Build SET clause - convert unknown values to Node
	const columnTypes = config.columnTypes;
	const setClause: Array<{ column: string; value: Node }> = config.set.map(
		({ column, value }) => ({
			column: naming.toDatabase(column),
			value: valueToNode(value, state, columnTypes?.[column]),
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
