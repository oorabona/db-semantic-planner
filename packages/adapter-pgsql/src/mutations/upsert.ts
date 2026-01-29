/**
 * Upsert (INSERT ... ON CONFLICT) Compiler
 *
 * Compiles UPSERT statements with ON CONFLICT handling.
 * Supports:
 * - ON CONFLICT DO NOTHING
 * - ON CONFLICT DO UPDATE SET ...
 * - Conflict target (columns or constraint name)
 * - WHERE clause for conflict resolution
 */

import type { InferClause, Node, OnConflictClause } from '@pgsql/types';
import { columnRef, resTarget } from '../ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
} from '../handlers/types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Conflict resolution strategy
 */
export type ConflictAction = 'nothing' | 'update';

/**
 * Conflict target specification
 */
export interface ConflictTarget {
	/** Column names that form the unique constraint */
	columns?: string[];
	/** Named constraint */
	constraint?: string;
	/** WHERE clause for partial index */
	where?: Decision[];
}

/**
 * Configuration for UPSERT compilation
 */
export interface UpsertConfig {
	/** Table to upsert into */
	table: string;
	/** Columns to insert */
	columns: string[];
	/** Values for each column (array of rows) */
	values: unknown[][];
	/** Conflict target (unique columns or constraint) */
	conflictTarget: ConflictTarget;
	/** What to do on conflict */
	conflictAction: ConflictAction;
	/** Columns to update on conflict (for 'update' action) */
	updateColumns?: string[];
	/** Use EXCLUDED.column for update values (default: true) */
	useExcluded?: boolean;
	/** Columns to return (RETURNING clause) */
	returning?: string[];
}

// ============================================================================
// ON CONFLICT Builder
// ============================================================================

/**
 * Build ON CONFLICT clause for INSERT statement.
 */
export function buildOnConflictClause(
	config: UpsertConfig,
	ctx: CompilerContext,
	state: CompilerState,
): OnConflictClause {
	const naming = ctx.naming;
	const action = config.conflictAction;

	// Build conflict target
	let infer: InferClause | undefined;
	if (
		config.conflictTarget.columns &&
		config.conflictTarget.columns.length > 0
	) {
		// Conflict on columns
		infer = {
			indexElems: config.conflictTarget.columns.map((col) => ({
				IndexElem: {
					name: naming.toDatabase(col),
				},
			})),
		};
	} else if (config.conflictTarget.constraint) {
		// Conflict on named constraint
		infer = {
			conname: naming.toDatabase(config.conflictTarget.constraint),
		};
	}

	// DO NOTHING case
	if (action === 'nothing') {
		return {
			action: 'ONCONFLICT_NOTHING',
			...(infer && { infer }),
		};
	}

	// DO UPDATE SET case
	const updateColumns = config.updateColumns ?? config.columns;
	const useExcluded = config.useExcluded ?? true;

	const targetList: Node[] = updateColumns.map((col) => {
		const dbCol = naming.toDatabase(col);
		return {
			ResTarget: {
				name: dbCol,
				val: useExcluded
					? // Use EXCLUDED.column (the value that would have been inserted)
						{
							ColumnRef: {
								fields: [
									{ String: { sval: 'excluded' } },
									{ String: { sval: dbCol } },
								],
							},
						}
					: // Use parameter placeholder
						valueToParam(state),
			},
		};
	});

	return {
		action: 'ONCONFLICT_UPDATE',
		...(infer && { infer }),
		targetList,
	};
}

/**
 * Compile a complete UPSERT statement.
 */
export function compileUpsert(
	config: UpsertConfig,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	const naming = ctx.naming;
	const dbTable = naming.toDatabase(config.table);
	const dbColumns = config.columns.map((c) => naming.toDatabase(c));

	// Build column names
	const cols = dbColumns.map((c) => ({ String: { sval: c } }));

	// Build VALUES lists
	const valuesList: Node[] = config.values.map((row) => ({
		List: {
			items: row.map((val) => valueToParam(state, val)),
		},
	}));

	// Build ON CONFLICT clause
	const onConflict = buildOnConflictClause(config, ctx, state);

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

	// Build INSERT statement with ON CONFLICT
	return {
		InsertStmt: {
			relation: {
				relname: dbTable,
				...(ctx.schema && { schemaname: ctx.schema }),
				inh: true,
				relpersistence: 'p',
			},
			cols,
			selectStmt: {
				SelectStmt: {
					valuesLists: valuesList,
				},
			},
			onConflictClause: onConflict,
			...(returningList && { returningList }),
			override: 'OVERRIDING_NOT_SET',
		},
	};
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert value to a parameter reference.
 */
function valueToParam(state: CompilerState, value?: unknown): Node {
	if (value !== undefined) {
		state.parameters.push(value);
	}
	state.paramIndex++;

	return {
		ParamRef: {
			number: state.paramIndex,
		},
	};
}

/**
 * Build EXCLUDED.column reference.
 * EXCLUDED is a special table alias in ON CONFLICT ... DO UPDATE
 * that refers to the row that would have been inserted.
 */
export function excludedRef(
	column: string,
	naming: { toDatabase: (s: string) => string },
): Node {
	return {
		ColumnRef: {
			fields: [
				{ String: { sval: 'excluded' } },
				{ String: { sval: naming.toDatabase(column) } },
			],
		},
	};
}

/**
 * Build conditional update using COALESCE.
 *
 * Produces: COALESCE(EXCLUDED.col, table.col)
 * This keeps existing value if new value is NULL.
 */
export function conditionalUpdate(
	column: string,
	table: string,
	ctx: CompilerContext,
): Node {
	const naming = ctx.naming;
	const _dbCol = naming.toDatabase(column);
	const dbTable = naming.toDatabase(table);

	return {
		FuncCall: {
			funcname: [{ String: { sval: 'coalesce' } }],
			args: [
				excludedRef(column, naming),
				columnRef(column, dbTable, ctx.schema, naming),
			],
		},
	};
}
