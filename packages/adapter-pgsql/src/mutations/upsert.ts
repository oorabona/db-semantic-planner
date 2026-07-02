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

import type { MutationReturningItem, WhereIntent } from '@dbsp/types';
import type { InferClause, Node, OnConflictClause } from '@pgsql/types';
import { columnRef, funcCall } from '../ast-helpers.js';
import {
	inferPgArrayType,
	parseRawExpression,
	stripArraySuffix,
	transposeToColumnArrays,
	validateBatchCardinality,
} from '../compiler-utils.js';
import { createWhereDispatcher } from '../handlers/index.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
} from '../handlers/types.js';
import { unwrapParamIntent } from '../param-intent.js';
import { createTypeCastParamRef } from '../param-ref.js';
import { buildReturningList } from './mutation-compiler.js';

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
	/** Optional WHERE clause for ON CONFLICT DO UPDATE */
	actionWhere?: Decision[];
	/** Optional direct WHERE intent for ON CONFLICT DO UPDATE */
	actionWhereIntent?: WhereIntent;
	/** Compile the direct action WHERE intent using the caller's WHERE compiler */
	compileActionWhere?: (where: WhereIntent, state: CompilerState) => Node;
	/** Use EXCLUDED.column for update values (default: true) */
	useExcluded?: boolean;
	/** Columns to return (RETURNING clause) */
	returning?: string[];
	/** Alias-aware RETURNING projection items */
	returningItems?: readonly MutationReturningItem[];
	/** Optional column type hints for unnest casting (schema-driven) */
	columnTypes?: Record<string, string>;
	/**
	 * Raw SQL expressions for specific update columns.
	 * These are injected verbatim into the ON CONFLICT DO UPDATE SET clause.
	 * Keys are logical column names (before naming plugin), values are raw SQL fragments.
	 *
	 * @warning SECURITY: fragments are inserted without parameterization.
	 *   Only use with hardcoded expressions. Never with user input.
	 *
	 * @example { last_parsed: 'now()', count: 'excluded.count + 1' }
	 */
	updateExpressions?: Record<string, string>;
}

// ============================================================================
// ON CONFLICT Builder
// ============================================================================

function buildWhereClause(
	conditions: Decision[] | undefined,
	ctx: CompilerContext,
	state: CompilerState,
): Node | undefined {
	if (!conditions || conditions.length === 0) return undefined;

	const dispatch = createWhereDispatcher();
	if (conditions.length === 1) {
		return dispatch(conditions[0]!, ctx, state);
	}

	const nodes = conditions.map((condition) => dispatch(condition, ctx, state));
	return {
		BoolExpr: { boolop: 'AND_EXPR', args: nodes },
	} as unknown as Node;
}

function buildActionWhereClause(
	config: UpsertConfig,
	ctx: CompilerContext,
	state: CompilerState,
): Node | undefined {
	if (config.actionWhereIntent) {
		if (!config.compileActionWhere) {
			throw new Error(
				'Upsert actionWhereIntent requires compileActionWhere callback',
			);
		}
		return config.compileActionWhere(config.actionWhereIntent, state);
	}

	return buildWhereClause(config.actionWhere, ctx, state);
}

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

		// Partial-index conflict: ON CONFLICT (col) WHERE predicate
		if (config.conflictTarget.where && config.conflictTarget.where.length > 0) {
			const whereClause = buildWhereClause(
				config.conflictTarget.where,
				ctx,
				state,
			);
			if (whereClause) infer.whereClause = whereClause;
		}
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

		// Raw SQL expression: emit the parsed AST node verbatim
		const rawExpr = config.updateExpressions?.[col];
		if (rawExpr !== undefined) {
			return {
				ResTarget: {
					name: dbCol,
					val: parseRawExpression(rawExpr),
				},
			};
		}

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
	const whereClause = buildActionWhereClause(config, ctx, state);

	return {
		action: 'ONCONFLICT_UPDATE',
		...(infer && { infer }),
		targetList,
		...(whereClause && { whereClause }),
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
	const returningList = buildReturningList(
		config.returning,
		dbTable,
		ctx,
		config.returningItems,
	);

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

/**
 * Compile a UPSERT statement using the unnest strategy for large batches.
 *
 * Generates:
 *   INSERT INTO "table" ("col1", "col2")
 *   SELECT unnest($1::type[]), unnest($2::type[])
 *   ON CONFLICT ("conflict_col") DO UPDATE SET "col2" = EXCLUDED."col2"
 *   [RETURNING ...]
 *
 * This avoids the PostgreSQL 65535 parameter limit. Uses N parameters
 * (one per column) regardless of row count.
 */
export function compileUnnestUpsert(
	config: UpsertConfig,
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
		const colArray: unknown[] = columnArrays[i] ?? [];

		// Find a non-null sample value for runtime type fallback
		const sampleValue = colArray.find((v) => v !== null && v !== undefined);

		// Strip trailing [] to get base type
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
		return {
			ResTarget: {
				name: naming.toDatabase(col),
				val: unnestCall,
			},
		};
	});

	// Build the SELECT statement for INSERT ... SELECT
	const selectQuery: Node = {
		SelectStmt: {
			targetList,
		},
	};

	// Build ON CONFLICT clause (same as VALUES path)
	const onConflict = buildOnConflictClause(config, ctx, state);

	// Build RETURNING clause if specified
	const returningList = buildReturningList(
		config.returning,
		dbTable,
		ctx,
		config.returningItems,
	);

	// Build INSERT INTO "table" ("col1", "col2") <selectQuery> ON CONFLICT ...
	return {
		InsertStmt: {
			relation: {
				relname: dbTable,
				...(ctx.schema && { schemaname: ctx.schema }),
				inh: true,
				relpersistence: 'p',
			},
			cols: columns.map((c) => ({
				ResTarget: { name: naming.toDatabase(c) },
			})),
			selectStmt: selectQuery,
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
		state.parameters.push(unwrapParamIntent(value));
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
