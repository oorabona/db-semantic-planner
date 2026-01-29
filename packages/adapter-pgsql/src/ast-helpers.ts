/**
 * AST Helpers - Factory functions for building PostgreSQL AST nodes
 *
 * These helpers create properly typed AST nodes for the pgsql-deparser.
 * All functions follow a consistent pattern:
 * - Return wrapped Node types (e.g., { SelectStmt: {...} })
 * - Handle optional properties with exactOptionalPropertyTypes
 * - Support the NamingPlugin for identifier transformation
 */
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
	Node,
	RangeVar,
	ResTarget,
	SelectStmt,
	SortBy,
	TypeCast,
	TypeName,
	UpdateStmt,
} from '@pgsql/types';

import type { NamingPlugin } from './naming-plugin.js';
import { identityNaming } from './naming-plugin.js';

// ============================================================================
// Basic Value Nodes
// ============================================================================

/**
 * Create a String node (for identifiers, operators, etc.)
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
// Column and Table References
// ============================================================================

/**
 * Create a ColumnRef node
 * @param column - Column name
 * @param table - Optional table name or alias
 * @param schema - Optional schema name
 * @param naming - Naming plugin for transformation
 */
export function columnRef(
	column: string,
	table?: string,
	schema?: string,
	naming: NamingPlugin = identityNaming,
): Node {
	const fields: Node[] = [];

	if (schema) {
		fields.push(stringNode(naming.toDatabase(schema)));
	}
	if (table) {
		fields.push(stringNode(naming.toDatabase(table)));
	}
	fields.push(stringNode(naming.toDatabase(column)));

	return { ColumnRef: { fields } };
}

/**
 * Create a ColumnRef for "table.*" (star/wildcard)
 */
export function columnRefStar(
	table?: string,
	naming: NamingPlugin = identityNaming,
): Node {
	const fields: Node[] = [];

	if (table) {
		fields.push(stringNode(naming.toDatabase(table)));
	}
	fields.push({ A_Star: {} });

	return { ColumnRef: { fields } };
}

/**
 * Create a RangeVar node (table reference in FROM clause)
 */
export function rangeVar(
	table: string,
	alias?: string,
	schema?: string,
	naming: NamingPlugin = identityNaming,
): Node {
	const rv: RangeVar = {
		relname: naming.toDatabase(table),
		inh: true,
		relpersistence: 'p',
	};

	if (schema) {
		rv.schemaname = naming.toDatabase(schema);
	}

	if (alias) {
		rv.alias = { aliasname: naming.toDatabase(alias) };
	}

	return { RangeVar: rv };
}

// ============================================================================
// Target List (SELECT expressions)
// ============================================================================

/**
 * Create a ResTarget node (target in SELECT list)
 * @param val - Expression value
 * @param name - Optional alias (AS name)
 */
export function resTarget(val: Node, name?: string): Node {
	const rt: ResTarget = { val };

	if (name) {
		rt.name = name;
	}

	return { ResTarget: rt };
}

/**
 * Create a ResTarget for a simple column
 */
export function columnTarget(
	column: string,
	alias?: string,
	table?: string,
	naming: NamingPlugin = identityNaming,
): Node {
	return resTarget(columnRef(column, table, undefined, naming), alias);
}

/**
 * Create a ResTarget for "*" (all columns)
 */
export function starTarget(
	table?: string,
	naming: NamingPlugin = identityNaming,
): Node {
	return resTarget(columnRefStar(table, naming));
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

/**
 * Create a COALESCE function call
 */
export function coalesce(...args: Node[]): Node {
	return funcCall('coalesce', args);
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

export interface SelectOptions {
	targetList: Node[];
	from?: Node[];
	where?: Node;
	groupBy?: Node[];
	having?: Node;
	orderBy?: Node[];
	limit?: Node;
	offset?: Node;
	distinct?: boolean | Node[];
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

	return { SelectStmt: stmt };
}

// ============================================================================
// INSERT Statement
// ============================================================================

export interface InsertOptions {
	table: string;
	schema?: string;
	columns?: string[];
	/** VALUES rows for INSERT ... VALUES */
	values?: Node[][];
	/** SELECT query for INSERT ... SELECT */
	selectQuery?: Node;
	returning?: Node[];
	onConflict?: {
		target?: string[];
		action: 'nothing' | 'update';
		updateSet?: Array<{ column: string; value: Node }>;
	};
	naming?: NamingPlugin;
}

/**
 * Create an InsertStmt node
 */
export function insertStmt(options: InsertOptions): Node {
	const naming = options.naming ?? identityNaming;

	const relation: RangeVar = {
		relname: naming.toDatabase(options.table),
		inh: true,
		relpersistence: 'p',
	};

	if (options.schema) {
		relation.schemaname = naming.toDatabase(options.schema);
	}

	const stmt: InsertStmt = {
		relation,
	};

	if (options.columns && options.columns.length > 0) {
		stmt.cols = options.columns.map((col) => ({
			ResTarget: { name: naming.toDatabase(col) },
		}));
	}

	if (options.selectQuery) {
		// INSERT ... SELECT: use provided query directly
		stmt.selectStmt = options.selectQuery;
	} else if (options.values && options.values.length > 0) {
		// VALUES clause represented as a SelectStmt with valuesLists
		// Each row is wrapped in a List node
		stmt.selectStmt = {
			SelectStmt: {
				valuesLists: options.values.map((row) => ({ List: { items: row } })),
			},
		};
	}

	if (options.returning && options.returning.length > 0) {
		stmt.returningList = options.returning;
	}

	// ON CONFLICT handling would go here (complex, defer for now)

	return { InsertStmt: stmt };
}

// ============================================================================
// UPDATE Statement
// ============================================================================

export interface UpdateOptions {
	table: string;
	schema?: string;
	set: Array<{ column: string; value: Node }>;
	where?: Node;
	from?: Node[];
	returning?: Node[];
	naming?: NamingPlugin;
}

/**
 * Create an UpdateStmt node
 */
export function updateStmt(options: UpdateOptions): Node {
	const naming = options.naming ?? identityNaming;

	const relation: RangeVar = {
		relname: naming.toDatabase(options.table),
		inh: true,
		relpersistence: 'p',
	};

	if (options.schema) {
		relation.schemaname = naming.toDatabase(options.schema);
	}

	const stmt: UpdateStmt = {
		relation,
		targetList: options.set.map(({ column, value }) => ({
			ResTarget: {
				name: naming.toDatabase(column),
				val: value,
			},
		})),
	};

	if (options.where) {
		stmt.whereClause = options.where;
	}

	if (options.from && options.from.length > 0) {
		stmt.fromClause = options.from;
	}

	if (options.returning && options.returning.length > 0) {
		stmt.returningList = options.returning;
	}

	return { UpdateStmt: stmt };
}

// ============================================================================
// DELETE Statement
// ============================================================================

export interface DeleteOptions {
	table: string;
	schema?: string;
	where?: Node;
	using?: Node[];
	returning?: Node[];
	naming?: NamingPlugin;
}

/**
 * Create a DeleteStmt node
 */
export function deleteStmt(options: DeleteOptions): Node {
	const naming = options.naming ?? identityNaming;

	const relation: RangeVar = {
		relname: naming.toDatabase(options.table),
		inh: true,
		relpersistence: 'p',
	};

	if (options.schema) {
		relation.schemaname = naming.toDatabase(options.schema);
	}

	const stmt: DeleteStmt = {
		relation,
	};

	if (options.where) {
		stmt.whereClause = options.where;
	}

	if (options.using && options.using.length > 0) {
		stmt.usingClause = options.using;
	}

	if (options.returning && options.returning.length > 0) {
		stmt.returningList = options.returning;
	}

	return { DeleteStmt: stmt };
}

// ============================================================================
// Window Functions
// ============================================================================

/**
 * Create a window function call with OVER clause.
 * Example: ROW_NUMBER() OVER (PARTITION BY x ORDER BY y) AS alias
 */
export function windowFuncCall(
	funcName: string,
	args: Node[],
	over: {
		partitionBy?: readonly string[];
		orderBy?: readonly { field: string; direction?: 'asc' | 'desc' }[];
	},
	naming: NamingPlugin,
	table?: string,
): Node {
	// Build partition clause
	const partitionClause: Node[] = (over.partitionBy ?? []).map((col) =>
		columnRef(col, table, undefined, naming),
	);

	// Build order clause using existing sortBy helper
	const orderClause: Node[] = (over.orderBy ?? []).map((ob) =>
		sortBy(
			columnRef(ob.field, table, undefined, naming),
			ob.direction === 'desc' ? 'DESC' : 'ASC',
		),
	);

	// Window definition
	const windowDef: Record<string, unknown> = {
		frameOptions: 1034, // RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW (default)
	};

	if (partitionClause.length > 0) {
		windowDef.partitionClause = partitionClause;
	}
	if (orderClause.length > 0) {
		windowDef.orderClause = orderClause;
	}

	// Build the FuncCall with over property
	// Window functions like row_number, rank, etc. are actual database functions
	// and will work correctly even when quoted by the deparser
	const funcCallObj: Record<string, unknown> = {
		funcname: [stringNode(funcName)],
		over: windowDef,
	};

	if (args.length > 0) {
		funcCallObj.args = args;
	}

	return { FuncCall: funcCallObj as FuncCall };
}
