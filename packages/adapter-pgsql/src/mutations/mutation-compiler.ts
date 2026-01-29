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
	const valuesRows: Node[][] = config.values.map((row) =>
		row.map((val) => valueToNode(val, state)),
	);

	// Build RETURNING clause if specified
	let returningList: Node[] | undefined;
	if (config.returning && config.returning.length > 0) {
		returningList = config.returning.map((col) =>
			resTarget(
				columnRef(col, dbTable, ctx.schema, naming),
				naming.toDatabase(col),
			),
		);
	}

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
	const setClause: Array<{ column: string; value: Node }> = config.set.map(
		({ column, value }) => ({
			column: naming.toDatabase(column),
			value: valueToNode(value, state),
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
	let returningList: Node[] | undefined;
	if (config.returning && config.returning.length > 0) {
		returningList = config.returning.map((col) =>
			resTarget(
				columnRef(col, tableAlias, ctx.schema, naming),
				naming.toDatabase(col),
			),
		);
	}

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
	let returningList: Node[] | undefined;
	if (config.returning && config.returning.length > 0) {
		returningList = config.returning.map((col) =>
			resTarget(
				columnRef(col, tableAlias, ctx.schema, naming),
				naming.toDatabase(col),
			),
		);
	}

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

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a JavaScript value to an AST node.
 * Uses parameters for actual values.
 */
function valueToNode(value: unknown, state: CompilerState): Node {
	if (value === null || value === undefined) {
		return { A_Const: { isnull: true } };
	}

	// Add to parameters and return a ParamRef
	state.parameters.push(value);
	state.paramIndex++;

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
