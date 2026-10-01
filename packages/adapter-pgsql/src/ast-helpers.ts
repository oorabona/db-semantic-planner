/**
 * AST Helpers - Factory functions for building PostgreSQL AST nodes
 *
 * These helpers create properly typed AST nodes for the pgsql-deparser.
 * All functions follow a consistent pattern:
 * - Return wrapped Node types (e.g., { SelectStmt: {...} })
 * - Handle optional properties with exactOptionalPropertyTypes
 * - Accept identifiers only after their authority is established
 */

import type { LockIntent, LockStrength, LockWaitPolicy } from '@dbsp/types';
import type {
	A_Expr,
	A_Expr_Kind,
	BoolExpr,
	BoolExprType,
	DeleteStmt,
	FuncCall,
	InsertStmt,
	JoinExpr,
	JoinType,
	LockClauseStrength,
	Node,
	LockWaitPolicy as PgLockWaitPolicy,
	RangeVar,
	SelectStmt,
	SortBy,
	TypeCast,
	TypeName,
	UpdateStmt,
} from '@pgsql/types';

import {
	identifierText,
	queryLocal,
	type SqlIdentifier,
} from './sql-identifier.js';

// Re-export normalizeSQL from core (canonical location since A-9 DRY refactor)
export { normalizeSQL } from '@dbsp/core';

// ============================================================================
// Internal Helpers
// ============================================================================

function applyReturningClause(
	stmt: { returningClause?: { exprs?: Node[] } },
	returning: Node[] | undefined,
): void {
	if (returning && returning.length > 0) {
		stmt.returningClause = { exprs: returning };
	}
}

// ============================================================================
// Basic Value Nodes
// ============================================================================

/**
 * Create an identifier node for a column, table, function, type, or operator name.
 * For a SQL string value, use stringConstNode.
 */
export function stringNode(value: string): Node {
	return { String: { sval: value } };
}

/**
 * Create an Integer node
 */
export function integerNode(value: number): Node {
	return { Integer: { ival: value } };
}

/**
 * Create a Float node
 */
export function floatNode(value: string): Node {
	return { Float: { fval: value } };
}

/**
 * Create a Boolean node (PostgreSQL constant)
 */
export function booleanConstNode(value: boolean): Node {
	return {
		A_Const: {
			boolval: { boolval: value },
		},
	};
}

/**
 * Create a string constant node. This is a SQL value: it deparses to a quoted literal.
 * For an identifier — a column, table, function, type or operator name — use stringNode.
 */
export function stringConstNode(value: string): Node {
	return { A_Const: { sval: { sval: value } } };
}

/**
 * Create the empty JSON array constant, `'[]'::json`, used as the COALESCE fallback of a
 * json_agg over a relation that matched no rows.
 */
export function emptyJsonArrayNode(): Node {
	return typeCast(stringConstNode('[]'), 'json');
}

/**
 * Create a NULL constant node
 */
export function nullConstNode(): Node {
	return {
		A_Const: {
			isnull: true,
		},
	};
}

// ============================================================================
// Expressions
// ============================================================================

/**
 * Create an A_Expr node for binary operations
 */
export function binaryExpr(
	operator: string,
	left: Node,
	right: Node,
	kind: A_Expr_Kind = 'AEXPR_OP',
): Node {
	const expr: A_Expr = {
		kind,
		name: [stringNode(operator)],
		lexpr: left,
		rexpr: right,
	};

	return { A_Expr: expr };
}

/**
 * Create an equality expression (col = value)
 */
export function eqExpr(left: Node, right: Node): Node {
	return binaryExpr('=', left, right);
}

/**
 * Create a not-equal expression (col <> value)
 */
export function neExpr(left: Node, right: Node): Node {
	return binaryExpr('<>', left, right);
}

/**
 * Create a null-safe inequality expression (col IS DISTINCT FROM value).
 */
export function distinctExpr(left: Node, right: Node): Node {
	return binaryExpr('=', left, right, 'AEXPR_DISTINCT');
}

/**
 * Create comparison expressions
 */
export function ltExpr(left: Node, right: Node): Node {
	return binaryExpr('<', left, right);
}

export function lteExpr(left: Node, right: Node): Node {
	return binaryExpr('<=', left, right);
}

export function gtExpr(left: Node, right: Node): Node {
	return binaryExpr('>', left, right);
}

export function gteExpr(left: Node, right: Node): Node {
	return binaryExpr('>=', left, right);
}

/**
 * Create a LIKE expression
 */
export function likeExpr(left: Node, right: Node): Node {
	return binaryExpr('~~', left, right, 'AEXPR_LIKE');
}

/**
 * Create an ILIKE expression (case-insensitive)
 */
export function ilikeExpr(left: Node, right: Node): Node {
	return binaryExpr('~~*', left, right, 'AEXPR_ILIKE');
}

/**
 * Create a BoolExpr node (AND, OR, NOT)
 */
export function boolExpr(type: BoolExprType, args: Node[]): Node {
	const expr: BoolExpr = {
		boolop: type,
		args,
	};

	return { BoolExpr: expr };
}

/**
 * Create an AND expression
 */
export function andExpr(...args: Node[]): Node {
	return boolExpr('AND_EXPR', args);
}

/**
 * Create an OR expression
 */
export function orExpr(...args: Node[]): Node {
	return boolExpr('OR_EXPR', args);
}

/**
 * Create a NOT expression
 */
export function notExpr(arg: Node): Node {
	return boolExpr('NOT_EXPR', [arg]);
}

// ============================================================================
// Type Casts
// ============================================================================

/**
 * Create a TypeCast node
 */
export function typeCast(arg: Node, typeName: string, isArray = false): Node {
	const tn: TypeName = {
		names: [stringNode(typeName)],
		typemod: -1,
	};

	if (isArray) {
		tn.arrayBounds = [integerNode(-1)];
	}

	const tc: TypeCast = {
		arg,
		typeName: tn,
	};

	return { TypeCast: tc };
}

// ============================================================================
// Function Calls
// ============================================================================

/**
 * Create a FuncCall node for database functions.
 *
 * Note: SQL keywords like COALESCE, NULLIF, CASE, GREATEST, LEAST have their
 * own dedicated AST nodes (CoalesceExpr, NullIfExpr, CaseExpr, MinMaxExpr).
 * Use FuncCall for:
 * - Aggregate functions (count, sum, avg, etc.)
 * - User-defined functions
 * - Extension functions (PostGIS, pgcrypto, etc.)
 *
 * The pgsql-deparser will quote function names to preserve case.
 * This is correct behavior for user-defined and extension functions.
 */
export function funcCall(
	name: string | string[],
	args: Node[] = [],
	options: {
		distinct?: boolean;
		star?: boolean;
		orderBy?: Node[];
		filter?: Node;
	} = {},
): Node {
	const names = Array.isArray(name) ? name.map(stringNode) : [stringNode(name)];

	const fc: FuncCall = {
		funcname: names,
	};

	if (options.star) {
		fc.agg_star = true;
	} else if (args.length > 0) {
		fc.args = args;
	}

	if (options.distinct) {
		fc.agg_distinct = true;
	}

	if (options.orderBy && options.orderBy.length > 0) {
		fc.agg_order = options.orderBy;
	}

	if (options.filter) {
		fc.agg_filter = options.filter;
	}

	return { FuncCall: fc };
}

/**
 * Create a COALESCE expression node.
 * COALESCE is a SQL keyword (not a function), so it uses CoalesceExpr instead of FuncCall.
 */
export function coalesceExpr(args: Node[]): Node {
	return { CoalesceExpr: { args } };
}

/**
 * Shorthand for COUNT(*)
 */
export function countStar(): Node {
	return funcCall('count', [], { star: true });
}

/**
 * Shorthand for COUNT(DISTINCT col)
 */
export function countDistinct(col: Node): Node {
	return funcCall('count', [col], { distinct: true });
}

// ============================================================================
// Sort/Order By
// ============================================================================

/**
 * Create a SortBy node
 */
export function sortBy(
	expr: Node,
	direction: 'ASC' | 'DESC' | 'DEFAULT' = 'DEFAULT',
	nulls: 'FIRST' | 'LAST' | 'DEFAULT' = 'DEFAULT',
): Node {
	const sb: SortBy = {
		node: expr,
		sortby_dir:
			direction === 'ASC'
				? 'SORTBY_ASC'
				: direction === 'DESC'
					? 'SORTBY_DESC'
					: 'SORTBY_DEFAULT',
		sortby_nulls:
			nulls === 'FIRST'
				? 'SORTBY_NULLS_FIRST'
				: nulls === 'LAST'
					? 'SORTBY_NULLS_LAST'
					: 'SORTBY_NULLS_DEFAULT',
	};

	return { SortBy: sb };
}

// ============================================================================
// Joins
// ============================================================================

/**
 * Create a JoinExpr node
 */
export function joinExpr(
	joinType: JoinType,
	left: Node,
	right: Node,
	quals?: Node,
	alias?: string,
): Node {
	const je: JoinExpr = {
		jointype: joinType,
		larg: left,
		rarg: right,
	};

	if (quals) {
		je.quals = quals;
	}

	if (alias) {
		je.alias = { aliasname: alias };
	}

	return { JoinExpr: je };
}

/**
 * Create an INNER JOIN
 */
export function innerJoin(
	left: Node,
	right: Node,
	on: Node,
	alias?: string,
): Node {
	return joinExpr('JOIN_INNER', left, right, on, alias);
}

/**
 * Create a LEFT JOIN
 */
export function leftJoin(
	left: Node,
	right: Node,
	on: Node,
	alias?: string,
): Node {
	return joinExpr('JOIN_LEFT', left, right, on, alias);
}

// ============================================================================
// SELECT Statement
// ============================================================================

interface SelectOptions {
	targetList: Node[];
	from?: Node[];
	where?: Node;
	groupBy?: Node[];
	having?: Node;
	orderBy?: Node[];
	limit?: Node;
	offset?: Node;
	distinct?: boolean | Node[];
	/** WITH clause (e.g., CTEs) — { ctes: Node[], recursive?: boolean } */
	withClause?: { ctes: Node[]; recursive?: boolean };
	/** Row-level locking clause (FOR UPDATE/SHARE/etc.) */
	lockingClause?: {
		strength: LockClauseStrength;
		waitPolicy?: PgLockWaitPolicy;
		/** Tables to lock (FOR UPDATE OF ...). If omitted, locks all tables. */
		lockedRels?: Node[];
	};
}

/**
 * Create a SelectStmt node
 */
export function selectStmt(options: SelectOptions): Node {
	const stmt: SelectStmt = {
		targetList: options.targetList,
	};

	if (options.from && options.from.length > 0) {
		stmt.fromClause = options.from;
	}

	if (options.where) {
		stmt.whereClause = options.where;
	}

	if (options.groupBy && options.groupBy.length > 0) {
		stmt.groupClause = options.groupBy;
	}

	if (options.having) {
		stmt.havingClause = options.having;
	}

	if (options.orderBy && options.orderBy.length > 0) {
		stmt.sortClause = options.orderBy;
	}

	if (options.limit) {
		stmt.limitCount = options.limit;
	}

	if (options.offset) {
		stmt.limitOffset = options.offset;
	}

	if (options.distinct === true) {
		stmt.distinctClause = [];
	} else if (Array.isArray(options.distinct) && options.distinct.length > 0) {
		stmt.distinctClause = options.distinct;
	}

	if (options.withClause && options.withClause.ctes.length > 0) {
		stmt.withClause = {
			ctes: options.withClause.ctes,
			recursive: options.withClause.recursive ?? false,
		};
	}

	if (options.lockingClause) {
		const clause: Record<string, unknown> = {
			strength: options.lockingClause.strength,
			waitPolicy: options.lockingClause.waitPolicy ?? 'LockWaitBlock',
		};
		if (
			options.lockingClause.lockedRels &&
			options.lockingClause.lockedRels.length > 0
		) {
			clause.lockedRels = options.lockingClause.lockedRels;
		}
		stmt.lockingClause = [{ LockingClause: clause }] as Node[];
	}

	return { SelectStmt: stmt };
}

// ============================================================================
// Lock Helpers
// ============================================================================

const STRENGTH_MAP: Record<LockStrength, LockClauseStrength> = {
	forUpdate: 'LCS_FORUPDATE',
	forNoKeyUpdate: 'LCS_FORNOKEYUPDATE',
	forShare: 'LCS_FORSHARE',
	forKeyShare: 'LCS_FORKEYSHARE',
};

const POLICY_MAP: Record<LockWaitPolicy, PgLockWaitPolicy> = {
	block: 'LockWaitBlock',
	skipLocked: 'LockWaitSkip',
	noWait: 'LockWaitError',
};

/**
 * Map a LockIntent (domain type) to AST-level locking parameters.
 * Used by the compiler to translate intent-level lock to SelectOptions.lockingClause.
 */
export function mapLockToAst(lock: LockIntent): {
	strength: LockClauseStrength;
	waitPolicy: PgLockWaitPolicy;
} {
	return {
		strength: STRENGTH_MAP[lock.strength],
		waitPolicy: POLICY_MAP[lock.waitPolicy],
	};
}

// ============================================================================
// INSERT Statement
// ============================================================================

// ============================================================================
// JSON Aggregation (for include strategies)
// ============================================================================

/**
 * Create a json_agg correlated subquery for relation includes.
 *
 * Generates:
 * COALESCE(
 *   (SELECT json_agg(to_jsonb(__t__) ORDER BY __t__.pk ASC NULLS LAST)
 *    FROM schema.table AS __t__ WHERE __t__.fk = parent.pk),
 *   '[]'::json
 * ) AS "relation_json"
 *
 * @param targetTable - The target table name (e.g., 'authors')
 * @param targetAlias - Alias for the target table in subquery (default: '__t__')
 * @param whereExpr - The correlation WHERE expression
 * @param alias - The column alias (e.g., 'author_json')
 * @param schemaName - Optional schema name
 */
// ============================================================================
// Established-identifier façade
// ============================================================================

/** Build a column reference from identifiers that have already crossed authority. */
export function sqlColumnRef(
	column: SqlIdentifier,
	table?: SqlIdentifier,
	schema?: SqlIdentifier,
): Node {
	const fields: Node[] = [];
	if (schema !== undefined) fields.push(stringNode(identifierText(schema)));
	if (table !== undefined) fields.push(stringNode(identifierText(table)));
	fields.push(stringNode(identifierText(column)));
	return { ColumnRef: { fields } };
}

/** Build an established `table.*` reference without applying naming. */
export function sqlColumnRefStar(table?: SqlIdentifier): Node {
	const fields: Node[] = [];
	if (table !== undefined) fields.push(stringNode(identifierText(table)));
	fields.push({ A_Star: {} });
	return { ColumnRef: { fields } };
}

/** Build a FROM range variable from established table, alias, and schema names. */
export function sqlRangeVar(
	table: SqlIdentifier,
	alias?: SqlIdentifier,
	schema?: SqlIdentifier,
): Node {
	const range: RangeVar = {
		relname: identifierText(table),
		inh: true,
		relpersistence: 'p',
	};
	if (schema !== undefined) range.schemaname = identifierText(schema);
	if (alias !== undefined) range.alias = sqlRangeAlias(alias);
	return { RangeVar: range };
}

/** Build a query-local range alias. */
export function sqlRangeAlias(alias: SqlIdentifier): { aliasname: string } {
	return { aliasname: identifierText(alias) };
}

/** Build a SELECT target with an established output alias. */
export function sqlResTarget(val: Node, alias?: SqlIdentifier): Node {
	return {
		ResTarget: {
			val,
			...(alias !== undefined && { name: identifierText(alias) }),
		},
	};
}

export type SqlInsertOptions = {
	table: SqlIdentifier;
	schema?: SqlIdentifier;
	columns?: readonly SqlIdentifier[];
	values?: readonly Node[][];
	selectQuery?: Node;
	returning?: Node[];
};

/** Build INSERT with a declared target and declared column list. */
export function sqlInsertStmt(options: SqlInsertOptions): Node {
	const relation: RangeVar = {
		relname: identifierText(options.table),
		inh: true,
		relpersistence: 'p',
		...(options.schema !== undefined && {
			schemaname: identifierText(options.schema),
		}),
	};
	const stmt: InsertStmt = { relation };
	if (options.columns?.length) {
		stmt.cols = options.columns.map((column) => ({
			ResTarget: { name: identifierText(column) },
		}));
	}
	if (options.selectQuery !== undefined) stmt.selectStmt = options.selectQuery;
	else if (options.values?.length) {
		stmt.selectStmt = {
			SelectStmt: {
				valuesLists: options.values.map((row) => ({
					List: { items: [...row] },
				})),
			},
		};
	}
	applyReturningClause(stmt, options.returning);
	return { InsertStmt: stmt };
}

export type SqlUpdateOptions = {
	table: SqlIdentifier;
	schema?: SqlIdentifier;
	set: ReadonlyArray<{ column: SqlIdentifier; value: Node }>;
	where?: Node;
	from?: Node[];
	returning?: Node[];
};

/** Build UPDATE with a declared target and declared assignment columns. */
export function sqlUpdateStmt(options: SqlUpdateOptions): Node {
	const relation: RangeVar = {
		relname: identifierText(options.table),
		inh: true,
		relpersistence: 'p',
		...(options.schema !== undefined && {
			schemaname: identifierText(options.schema),
		}),
	};
	const stmt: UpdateStmt = {
		relation,
		targetList: options.set.map(({ column, value }) => ({
			ResTarget: { name: identifierText(column), val: value },
		})),
	};
	if (options.where !== undefined) stmt.whereClause = options.where;
	if (options.from?.length) stmt.fromClause = options.from;
	applyReturningClause(stmt, options.returning);
	return { UpdateStmt: stmt };
}

export type SqlDeleteOptions = {
	table: SqlIdentifier;
	schema?: SqlIdentifier;
	where?: Node;
	using?: Node[];
	returning?: Node[];
};

/** Build DELETE with a declared target. */
export function sqlDeleteStmt(options: SqlDeleteOptions): Node {
	const relation: RangeVar = {
		relname: identifierText(options.table),
		inh: true,
		relpersistence: 'p',
		...(options.schema !== undefined && {
			schemaname: identifierText(options.schema),
		}),
	};
	const stmt: DeleteStmt = { relation };
	if (options.where !== undefined) stmt.whereClause = options.where;
	if (options.using?.length) stmt.usingClause = options.using;
	applyReturningClause(stmt, options.returning);
	return { DeleteStmt: stmt };
}

export type SqlJsonAggOptions = {
	innerAlias?: SqlIdentifier;
	columns?: readonly SqlIdentifier[];
	childNodes?: readonly { key: SqlIdentifier; node: Node }[];
	limit?: number;
	columnValueOverrides?: ReadonlyMap<string, Node>;
	orderBy?: readonly SqlIdentifier[];
	orderByFallback?: boolean;
};

/** Build a JSON aggregate using only established relation and output identifiers. */
export function sqlJsonAggSubquery(
	targetTable: SqlIdentifier,
	whereExpr: Node,
	alias: SqlIdentifier,
	schemaName?: SqlIdentifier,
	options?: SqlJsonAggOptions,
): Node {
	const innerAlias = options?.innerAlias ?? queryLocal('__t__');
	const columns = options?.columns;
	let row: Node;
	if (
		columns !== undefined &&
		!(columns.length === 1 && identifierText(columns[0]!) === '*')
	) {
		const args: Node[] = [];
		for (const column of columns) {
			const key = identifierText(column);
			args.push(stringConstNode(key));
			args.push(
				options?.columnValueOverrides?.get(key) ??
					sqlColumnRef(column, innerAlias),
			);
		}
		row = {
			FuncCall: {
				funcname: [stringNode('jsonb_build_object')],
				args,
			} as FuncCall,
		};
	} else {
		row = {
			FuncCall: {
				funcname: [stringNode('to_jsonb')],
				args: [
					{ ColumnRef: { fields: [stringNode(identifierText(innerAlias))] } },
				],
			} as FuncCall,
		};
	}
	if (options?.childNodes?.length) {
		const args: Node[] = [];
		for (const child of options.childNodes) {
			args.push(stringConstNode(identifierText(child.key)), child.node);
		}
		row = {
			A_Expr: {
				kind: 'AEXPR_OP',
				name: [stringNode('||')],
				lexpr: row,
				rexpr: {
					FuncCall: {
						funcname: [stringNode('jsonb_build_object')],
						args,
					} as FuncCall,
				},
			},
		};
	}
	const order = options?.orderBy?.map((entry) =>
		sortBy(
			options.orderByFallback
				? typeCast(sqlColumnRef(entry, innerAlias), 'text')
				: sqlColumnRef(entry, innerAlias),
			'ASC',
			'LAST',
		),
	);
	const aggregate: Node = {
		FuncCall: {
			funcname: [stringNode('json_agg')],
			args: [row],
			...(order !== undefined && { agg_order: order }),
		} as FuncCall,
	};
	const subselect = selectStmt({
		targetList: [{ ResTarget: { val: aggregate } }],
		from: [sqlRangeVar(targetTable, innerAlias, schemaName)],
		where: whereExpr,
		...(options?.limit !== undefined && {
			limit: { A_Const: { ival: { ival: options.limit } } },
		}),
	});
	return sqlResTarget(
		coalesceExpr([
			{ SubLink: { subLinkType: 'EXPR_SUBLINK', subselect } },
			emptyJsonArrayNode(),
		]),
		alias,
	);
}

/** Build a JSON aggregate correlation from established column and alias names. */
export function sqlJsonAggCorrelation(
	parentAlias: SqlIdentifier,
	parentColumn: SqlIdentifier,
	targetAlias: SqlIdentifier,
	targetColumn: SqlIdentifier,
): Node {
	return eqExpr(
		sqlColumnRef(targetColumn, targetAlias),
		sqlColumnRef(parentColumn, parentAlias),
	);
}

/** Build a window-function expression from established identifiers. */
export function sqlWindowFuncCall(
	functionName: SqlIdentifier,
	args: readonly Node[],
	over: {
		partitionBy?: readonly SqlIdentifier[];
		orderBy?: readonly {
			field: SqlIdentifier;
			direction?: 'asc' | 'desc';
		}[];
	},
	table?: SqlIdentifier,
): Node {
	const partitionClause = (over.partitionBy ?? []).map((column) =>
		sqlColumnRef(column, table),
	);
	const orderClause = (over.orderBy ?? []).map(({ field, direction }) =>
		sortBy(sqlColumnRef(field, table), direction === 'desc' ? 'DESC' : 'ASC'),
	);
	const window: Record<string, unknown> = { frameOptions: 1034 };
	if (partitionClause.length) window.partitionClause = partitionClause;
	if (orderClause.length) window.orderClause = orderClause;
	return {
		FuncCall: {
			funcname: [stringNode(identifierText(functionName))],
			over: window,
			...(args.length
				? { args: [...args] }
				: identifierText(functionName).toLowerCase() === 'count'
					? { agg_star: true }
					: {}),
		} as FuncCall,
	};
}
