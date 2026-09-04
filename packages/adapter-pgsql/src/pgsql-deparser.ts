/**
 * Internal PostgreSQL AST deparser.
 *
 * Handles all AST node types that dbsp produces (~40 types).
 * Output is intentionally identical to pgsql-deparser (deparseSync) for all
 * nodes the compiler emits.
 *
 * Formatting rules:
 * - Identifiers: double-quoted  →  "table"."column"
 * - String literals: single-quoted  →  'value'
 * - Parameters: $1, $2, etc.
 * - TypeCast: CAST(arg AS type) form (pgsql-deparser normalizes to CAST)
 * - Operators: spaces around  →  a + b, a = b
 * - Keywords: UPPERCASE
 * - NULL literal: NULL
 * - Boolean: TRUE / FALSE
 */

import type {
	A_ArrayExpr,
	A_Const,
	A_Expr,
	Alias,
	BoolExpr,
	CaseExpr,
	CaseWhen,
	ClosePortalStmt,
	CoalesceExpr,
	ColumnRef,
	CommonTableExpr,
	CTECycleClause,
	DeclareCursorStmt,
	DefElem,
	DeleteStmt,
	ExplainStmt,
	FetchStmt,
	Float,
	FuncCall,
	IndexElem,
	InferClause,
	InsertStmt,
	Integer,
	JoinExpr,
	LockingClause,
	Node,
	NullTest,
	OnConflictClause,
	ParamRef,
	String as PgString,
	RangeVar,
	ResTarget,
	SelectStmt,
	SortBy,
	SubLink,
	TypeCast,
	TypeName,
	UpdateStmt,
	WindowDef,
	WithClause,
} from '@pgsql/types';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function deparse(node: Node): string {
	if (node === null || node === undefined) {
		return 'NULL';
	}
	const rec = node as Record<string, unknown>;
	const keys = Object.keys(rec);
	if (keys.length === 0) return '';
	const key = keys[0]!;
	const inner = rec[key];

	switch (key) {
		case 'SelectStmt':
			return deparseSelectStmt(inner as SelectStmt);
		case 'InsertStmt':
			return deparseInsertStmt(inner as InsertStmt);
		case 'UpdateStmt':
			return deparseUpdateStmt(inner as UpdateStmt);
		case 'DeleteStmt':
			return deparseDeleteStmt(inner as DeleteStmt);
		case 'ExplainStmt':
			return deparseExplainStmt(inner as ExplainStmt);
		case 'ColumnRef':
			return deparseColumnRef(inner as ColumnRef);
		case 'RangeVar':
			return deparseRangeVar(inner as RangeVar);
		case 'A_Star':
			return '*';
		case 'ResTarget':
			return deparseResTarget(inner as ResTarget);
		case 'A_Expr':
			return deparseAExpr(inner as A_Expr);
		case 'BoolExpr':
			return deparseBoolExpr(inner as BoolExpr);
		case 'FuncCall':
			return deparseFuncCall(inner as FuncCall);
		case 'CoalesceExpr':
			return deparseCoalesceExpr(inner as CoalesceExpr);
		case 'NullIfExpr':
			return deparseNullIfExpr(inner as { args?: Node[] });
		case 'MinMaxExpr':
			return deparseMinMaxExpr(inner as { op?: string; args?: Node[] });
		case 'CaseExpr':
			return deparseCaseExpr(inner as CaseExpr);
		case 'CaseWhen':
			return deparseCaseWhen(inner as CaseWhen);
		case 'TypeCast':
			return deparseTypeCast(inner as TypeCast);
		case 'TypeName':
			return deparseTypeName(inner as TypeName);
		case 'NullTest':
			return deparseNullTest(inner as NullTest);
		case 'SubLink':
			return deparseSubLink(inner as SubLink);
		case 'ParamRef':
			return deparseParamRef(inner as ParamRef);
		case 'A_Const':
			return deparseAConst(inner as A_Const);
		case 'String':
			return deparseStringNode(inner as PgString);
		case 'Integer':
			return deparseIntegerNode(inner as Integer);
		case 'Float':
			return deparseFloatNode(inner as Float);
		case 'JoinExpr':
			return deparseJoinExpr(inner as JoinExpr);
		case 'SortBy':
			return deparseSortBy(inner as SortBy);
		case 'WindowDef':
			return deparseWindowDef(inner as WindowDef);
		case 'CommonTableExpr':
			return deparseCommonTableExpr(inner as CommonTableExpr);
		case 'WithClause':
			return deparseWithClause(inner as WithClause);
		case 'CTECycleClause':
			return deparseCTECycleClause(inner as CTECycleClause);
		case 'OnConflictClause':
			return deparseOnConflictClause(inner as OnConflictClause);
		case 'LockingClause':
			return deparseLockingClause(inner as LockingClause);
		case 'List':
			return deparseListNode(inner as { items?: Node[] });
		case 'Alias':
			return deparseAlias(inner as Alias);
		case 'ClosePortalStmt':
			return deparseClosePortalStmt(inner as ClosePortalStmt);
		case 'Null':
			return 'NULL';
		case 'InferClause':
			return deparseInferClause(inner as InferClause);
		case 'A_ArrayExpr':
			return deparseArrayExpr(inner as A_ArrayExpr);
		case 'DeclareCursorStmt':
			return deparseDeclareCursorStmt(inner as DeclareCursorStmt);
		case 'FetchStmt':
			return deparseFetchStmt(inner as FetchStmt);
		case 'DefElem':
			return deparseDefElem(inner as DefElem);
		case 'IndexElem':
			return deparseIndexElem(inner as IndexElem);
		case 'RangeFunction':
			return deparseRangeFunction(inner as Record<string, unknown>);
		case 'NamedArgExpr': {
			const nae = inner as { arg: Node; name: string };
			return `${nae.name} => ${deparse(nae.arg)}`;
		}
		case 'RawSQL': {
			// Custom node: verbatim SQL passthrough (used by raw() escape hatch)
			return (inner as { sql: string }).sql;
		}
		case 'RangeSubselect':
			return deparseRangeSubselect(inner as Record<string, unknown>);
		default:
			throw new Error(`deparse: unsupported AST node type: ${key}`);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// PostgreSQL reserved words that must be double-quoted when used as identifiers.
// This is the minimal set needed for identifiers the dbsp compiler emits.
// Note: 'excluded' is intentionally omitted — it's unquoted in UPSERT SET context.
const PG_RESERVED = new Set([
	'all',
	'analyse',
	'analyze',
	'and',
	'any',
	'array',
	'as',
	'asc',
	'asymmetric',
	'both',
	'case',
	'cast',
	'check',
	'collate',
	'column',
	'constraint',
	'create',
	'cross',
	'current_catalog',
	'current_date',
	'current_role',
	'current_schema',
	'current_time',
	'current_timestamp',
	'current_user',
	'default',
	'deferrable',
	'desc',
	'distinct',
	'do',
	'else',
	'end',
	'except',
	'false',
	'fetch',
	'for',
	'foreign',
	'freeze',
	'from',
	'full',
	'grant',
	'group',
	'having',
	'ilike',
	'in',
	'initially',
	'inner',
	'intersect',
	'into',
	'is',
	'isnull',
	'join',
	'lateral',
	'leading',
	'left',
	'like',
	'limit',
	'localtime',
	'localtimestamp',
	'natural',
	'not',
	'notnull',
	'null',
	'offset',
	'on',
	'only',
	'or',
	'order',
	'outer',
	'overlaps',
	'placing',
	'primary',
	'references',
	'returning',
	'right',
	'select',
	'session_user',
	'similar',
	'some',
	'symmetric',
	'system_user',
	'table',
	'timestamp',
	'tablesample',
	'then',
	'to',
	'trailing',
	'true',
	'union',
	'unique',
	'user',
	'using',
	'variadic',
	'verbose',
	'when',
	'where',
	'window',
	'with',
	// Non-reserved but used as output column alias by dbsp compiler
	'exists',
	// SQL standard function keywords that pgsql-deparser quotes in FuncCall context
	'coalesce',
]);

function quoteIdent(name: string): string {
	// Quote when needed: uppercase, spaces, special chars, or reserved words.
	if (/^[a-z_][a-z0-9_]*$/.test(name) && !PG_RESERVED.has(name)) {
		return name;
	}
	return `"${name.replace(/"/g, '""')}"`;
}

function quoteString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function nodeToStr(n: Node): string {
	return deparse(n);
}

function strNodeVal(n: Node): string {
	const r = n as Record<string, unknown>;
	const k = Object.keys(r)[0]!;
	if (k === 'String') {
		return ((r[k] as Record<string, unknown>).sval as string | undefined) ?? '';
	}
	return '';
}

// ---------------------------------------------------------------------------
// Leaf nodes
// ---------------------------------------------------------------------------

function deparseStringNode(node: PgString): string {
	// String nodes are used as identifiers — double-quote them
	return quoteIdent(node.sval ?? '');
}

function deparseIntegerNode(node: Integer): string {
	return String(node.ival ?? 0);
}

function deparseFloatNode(node: Float): string {
	return node.fval ?? '';
}

// ---------------------------------------------------------------------------
// A_Const (literal constant)
// ---------------------------------------------------------------------------

function deparseAConst(node: A_Const): string {
	if ('isnull' in node && (node as Record<string, unknown>).isnull) {
		return 'NULL';
	}
	const rec = node as Record<string, unknown>;
	// integer: { ival: { ival: N } } or { ival: N }
	if ('ival' in rec && rec.ival !== undefined) {
		const iv = rec.ival as Record<string, unknown> | number;
		return String(typeof iv === 'object' ? (iv.ival as number) : iv);
	}
	// float: { fval: { fval: "N" } } or { fval: "N" }
	if ('fval' in rec && rec.fval !== undefined) {
		const fv = rec.fval as Record<string, unknown> | string;
		return typeof fv === 'object' ? String(fv.fval ?? '') : fv;
	}
	// boolean: { boolval: { boolval: bool } } or { boolval: bool }
	if ('boolval' in rec && rec.boolval !== undefined) {
		const bv = rec.boolval as Record<string, unknown> | boolean;
		const val = typeof bv === 'object' ? (bv.boolval as boolean) : bv;
		return val ? 'true' : 'false';
	}
	// string: { sval: { sval: "..." } } or { sval: "..." }
	if ('sval' in rec && rec.sval !== undefined) {
		const sv = rec.sval as Record<string, unknown> | string;
		const s = typeof sv === 'object' ? String(sv.sval ?? '') : sv;
		return quoteString(s);
	}
	return 'NULL';
}

// ---------------------------------------------------------------------------
// ParamRef
// ---------------------------------------------------------------------------

function deparseParamRef(node: ParamRef): string {
	return `$${node.number}`;
}

// ---------------------------------------------------------------------------
// ColumnRef
// ---------------------------------------------------------------------------

function deparseColumnRef(node: ColumnRef): string {
	const fields = node.fields ?? [];
	const parts = fields.map((f) => {
		const r = f as Record<string, unknown>;
		const k = Object.keys(r)[0]!;
		if (k === 'A_Star') return '*';
		// String node → identifier
		const inner = r[k] as Record<string, unknown>;
		return quoteIdent(String(inner.sval ?? ''));
	});
	return parts.join('.');
}

// ---------------------------------------------------------------------------
// RangeVar
// ---------------------------------------------------------------------------

function deparseRangeVar(node: RangeVar): string {
	let result = '';
	if (node.schemaname) {
		result += `${quoteIdent(node.schemaname)}.`;
	}
	result += quoteIdent(node.relname ?? '');
	if (node.alias) {
		result += ` AS ${quoteIdent(node.alias.aliasname ?? '')}`;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Alias
// ---------------------------------------------------------------------------

function deparseAlias(node: Alias): string {
	return quoteIdent(node.aliasname ?? '');
}

// ---------------------------------------------------------------------------
// ResTarget
// ---------------------------------------------------------------------------

function deparseResTarget(node: ResTarget): string {
	if (node.val) {
		const val = deparse(node.val);
		if (node.name) {
			return `${val} AS ${quoteIdent(node.name)}`;
		}
		return val;
	}
	if (node.name) {
		return quoteIdent(node.name);
	}
	return '';
}

// ---------------------------------------------------------------------------
// A_Expr
// ---------------------------------------------------------------------------

function getOpName(node: A_Expr): string {
	if (!node.name || node.name.length === 0) return '';
	return strNodeVal(node.name[0]!);
}

function deparseAExpr(node: A_Expr): string {
	const kind = node.kind;
	const op = getOpName(node);

	if (kind === 'AEXPR_OP') {
		// Parenthesize nested A_Expr operands to preserve operator precedence.
		// Custom operators have unknown precedence — wrap nested binary
		// expressions to guarantee correct SQL semantics.
		const leftRaw = node.lexpr ? deparse(node.lexpr) : '';
		const rightRaw = node.rexpr ? deparse(node.rexpr) : '';
		const left =
			node.lexpr && 'A_Expr' in node.lexpr ? `(${leftRaw})` : leftRaw;
		const right =
			node.rexpr && 'A_Expr' in node.rexpr ? `(${rightRaw})` : rightRaw;
		if (!left) {
			return `${op} ${right}`;
		}
		return `${left} ${op} ${right}`;
	}

	if (kind === 'AEXPR_OP_ANY') {
		const left = node.lexpr ? deparse(node.lexpr) : '';
		const right = node.rexpr ? deparse(node.rexpr) : '';
		return `${left} ${op} ANY (${right})`;
	}

	if (kind === 'AEXPR_OP_ALL') {
		const left = node.lexpr ? deparse(node.lexpr) : '';
		const right = node.rexpr ? deparse(node.rexpr) : '';
		return `${left} ${op} ALL (${right})`;
	}

	if (kind === 'AEXPR_DISTINCT') {
		const leftRaw = node.lexpr ? deparse(node.lexpr) : '';
		const rightRaw = node.rexpr ? deparse(node.rexpr) : '';
		const left =
			node.lexpr && 'A_Expr' in node.lexpr ? `(${leftRaw})` : leftRaw;
		const right =
			node.rexpr && 'A_Expr' in node.rexpr ? `(${rightRaw})` : rightRaw;
		return `${left} IS DISTINCT FROM ${right}`;
	}

	if (kind === 'AEXPR_BETWEEN' || kind === 'AEXPR_NOT_BETWEEN') {
		const left = node.lexpr ? deparse(node.lexpr) : '';
		const listRec = node.rexpr as Record<string, unknown>;
		const listInner = listRec.List as { items: Node[] } | undefined;
		const items = listInner?.items ?? [];
		const low = items[0] ? deparse(items[0]) : '';
		const high = items[1] ? deparse(items[1]) : '';
		const betweenOp = kind === 'AEXPR_BETWEEN' ? 'BETWEEN' : 'NOT BETWEEN';
		return `${left} ${betweenOp} ${low} AND ${high}`;
	}

	if (kind === 'AEXPR_LIKE') {
		const left = node.lexpr ? deparse(node.lexpr) : '';
		const right = node.rexpr ? deparse(node.rexpr) : '';
		const base =
			op === '!~~' ? `${left} NOT LIKE ${right}` : `${left} LIKE ${right}`;
		const escapeNode = (node as unknown as Record<string, unknown>).escape as
			| import('@pgsql/types').Node
			| undefined;
		if (escapeNode) {
			return `${base} ESCAPE ${deparse(escapeNode)}`;
		}
		return base;
	}

	if (kind === 'AEXPR_ILIKE') {
		const left = node.lexpr ? deparse(node.lexpr) : '';
		const right = node.rexpr ? deparse(node.rexpr) : '';
		return op === '!~~*'
			? `${left} NOT ILIKE ${right}`
			: `${left} ILIKE ${right}`;
	}

	if (kind === 'AEXPR_IN') {
		const left = node.lexpr ? deparse(node.lexpr) : '';
		const right = node.rexpr ? deparse(node.rexpr) : '';
		// Wrap List in parentheses for proper IN (...) syntax
		const rightWrapped =
			node.rexpr && 'List' in node.rexpr ? `(${right})` : right;
		return op === '<>'
			? `${left} NOT IN ${rightWrapped}`
			: `${left} IN ${rightWrapped}`;
	}

	if (kind === 'AEXPR_NULLIF') {
		const left = node.lexpr ? deparse(node.lexpr) : '';
		const right = node.rexpr ? deparse(node.rexpr) : '';
		return `NULLIF(${left}, ${right})`;
	}

	// Fallback
	const left = node.lexpr ? deparse(node.lexpr) : '';
	const right = node.rexpr ? deparse(node.rexpr) : '';
	if (!left) return `${op} ${right}`;
	return `${left} ${op} ${right}`;
}

// ---------------------------------------------------------------------------
// BoolExpr
// ---------------------------------------------------------------------------

function deparseBoolExpr(node: BoolExpr): string {
	const args = node.args ?? [];

	if (node.boolop === 'NOT_EXPR') {
		const arg = args[0] ? deparse(args[0]) : '';
		return `NOT (${arg})`;
	}

	const sep = node.boolop === 'AND_EXPR' ? ' AND ' : ' OR ';
	const parts = args.map((arg) => {
		// When building AND, wrap OR children in parens to enforce precedence.
		// Without this, "A OR B AND C" would be emitted instead of "(A OR B) AND C".
		if (
			node.boolop === 'AND_EXPR' &&
			'BoolExpr' in arg &&
			(arg as { BoolExpr: { boolop: string } }).BoolExpr.boolop === 'OR_EXPR'
		) {
			return `(${nodeToStr(arg)})`;
		}
		return nodeToStr(arg);
	});
	return parts.join(sep);
}

// ---------------------------------------------------------------------------
// FuncCall
// ---------------------------------------------------------------------------

function deparseFuncCall(node: FuncCall): string {
	const nameParts = (node.funcname ?? []).map((n) => {
		const r = n as Record<string, unknown>;
		const k = Object.keys(r)[0]!;
		if (k === 'String') {
			return quoteIdent(String((r[k] as Record<string, unknown>).sval ?? ''));
		}
		return deparse(n);
	});
	const name = nameParts.join('.');

	const overClause = node.over
		? ` OVER (${deparseWindowDef(node.over as WindowDef)})`
		: '';

	let argStr: string;
	if (node.agg_star) {
		argStr = '*';
	} else {
		const args = node.args ?? [];
		const distinct = node.agg_distinct ? 'DISTINCT ' : '';
		const argParts = args.map(nodeToStr);

		let orderByClause = '';
		if (node.agg_order && node.agg_order.length > 0) {
			orderByClause = ` ORDER BY ${node.agg_order.map(nodeToStr).join(', ')}`;
		}

		argStr = `${distinct}${argParts.join(', ')}${orderByClause}`;
	}

	let filterClause = '';
	if (node.agg_filter) {
		filterClause = ` FILTER (WHERE ${deparse(node.agg_filter)})`;
	}

	return `${name}(${argStr})${filterClause}${overClause}`;
}

// ---------------------------------------------------------------------------
// CoalesceExpr
// ---------------------------------------------------------------------------

function deparseCoalesceExpr(node: CoalesceExpr): string {
	const args = (node.args ?? []).map(nodeToStr);
	return `COALESCE(${args.join(', ')})`;
}

function deparseNullIfExpr(node: { args?: Node[] }): string {
	const args = node.args ?? [];
	if (args.length !== 2) {
		throw new Error(
			`NullIfExpr requires exactly 2 arguments, got ${args.length}`,
		);
	}
	return `NULLIF(${deparse(args[0]!)}, ${deparse(args[1]!)})`;
}

function deparseMinMaxExpr(node: { op?: string; args?: Node[] }): string {
	const args = (node.args ?? []).map(nodeToStr);
	const fn = node.op === 'IS_GREATEST' ? 'GREATEST' : 'LEAST';
	return `${fn}(${args.join(', ')})`;
}

// ---------------------------------------------------------------------------
// CaseExpr / CaseWhen
// ---------------------------------------------------------------------------

function deparseCaseExpr(node: CaseExpr): string {
	const parts: string[] = ['CASE'];
	if (node.arg) parts.push(deparse(node.arg));
	for (const w of node.args ?? []) {
		parts.push(deparse(w));
	}
	if (node.defresult) parts.push(`ELSE ${deparse(node.defresult)}`);
	parts.push('END');
	return parts.join(' ');
}

function deparseCaseWhen(node: CaseWhen): string {
	const expr = node.expr ? deparse(node.expr) : '';
	const result = node.result ? deparse(node.result) : '';
	return `WHEN ${expr} THEN ${result}`;
}

// ---------------------------------------------------------------------------
// TypeCast — always CAST(arg AS type) form
// ---------------------------------------------------------------------------

function deparseTypeCast(node: TypeCast): string {
	const arg = node.arg ? deparse(node.arg) : '';
	const typeName = node.typeName ? deparseTypeName(node.typeName) : '';
	// Use :: shorthand for A_Const (string/int/bool literals) — matches pgsql-deparser
	if (node.arg && 'A_Const' in (node.arg as Record<string, unknown>)) {
		return `${arg}::${typeName}`;
	}
	return `CAST(${arg} AS ${typeName})`;
}

function deparseTypeName(node: TypeName): string {
	const names = (node.names ?? [])
		.map((n) => {
			const r = n as Record<string, unknown>;
			const k = Object.keys(r)[0]!;
			if (k === 'String') {
				const sval = String((r[k] as Record<string, unknown>).sval ?? '');
				if (sval === 'pg_catalog') return null;
				return sval;
			}
			return deparse(n);
		})
		.filter((v): v is string => v !== null && v !== undefined);

	let typeName = names.join('.');

	if (node.arrayBounds && node.arrayBounds.length > 0) {
		typeName += '[]';
	}

	return typeName;
}

// ---------------------------------------------------------------------------
// NullTest
// ---------------------------------------------------------------------------

function deparseNullTest(node: NullTest): string {
	const arg = node.arg ? deparse(node.arg) : '';
	if (node.nulltesttype === 'IS_NULL') {
		return `${arg} IS NULL`;
	}
	return `${arg} IS NOT NULL`;
}

// ---------------------------------------------------------------------------
// SubLink
// ---------------------------------------------------------------------------

function deparseSubLink(node: SubLink): string {
	const subquery = node.subselect ? deparse(node.subselect) : '';

	if (node.subLinkType === 'EXISTS_SUBLINK') {
		return `EXISTS (${subquery})`;
	}

	if (node.subLinkType === 'ANY_SUBLINK') {
		if (node.testexpr && node.operName && node.operName.length > 0) {
			const testExpr = deparse(node.testexpr);
			const op = strNodeVal(node.operName[0]!);
			return `${testExpr} ${op} ANY (${subquery})`;
		}
		return `ANY (${subquery})`;
	}

	if (node.subLinkType === 'ALL_SUBLINK') {
		if (node.testexpr && node.operName && node.operName.length > 0) {
			const testExpr = deparse(node.testexpr);
			const op = strNodeVal(node.operName[0]!);
			return `${testExpr} ${op} ALL (${subquery})`;
		}
		return `ALL (${subquery})`;
	}

	// EXPR_SUBLINK — scalar subquery in expression context
	return `(${subquery})`;
}

// ---------------------------------------------------------------------------
// JoinExpr
// ---------------------------------------------------------------------------

const JOIN_TYPE_MAP: Record<string, string> = {
	JOIN_INNER: 'JOIN',
	JOIN_LEFT: 'LEFT JOIN',
	JOIN_FULL: 'FULL JOIN',
	JOIN_RIGHT: 'RIGHT JOIN',
	JOIN_SEMI: 'SEMI JOIN',
	JOIN_ANTI: 'ANTI JOIN',
};

function deparseJoinExpr(node: JoinExpr): string {
	const left = node.larg ? deparse(node.larg) : '';
	const joinType = node.jointype
		? (JOIN_TYPE_MAP[node.jointype] ?? 'JOIN')
		: 'JOIN';
	const right = node.rarg ? deparse(node.rarg) : '';

	let result = `${left} ${joinType} ${right}`;

	if (node.quals) {
		result += ` ON ${deparse(node.quals)}`;
	}

	if (node.alias) {
		// When a JoinExpr has an outer alias, wrap the whole join in parens
		result = `(${result}) ${quoteIdent(node.alias.aliasname ?? '')}`;
	}

	return result;
}

// ---------------------------------------------------------------------------
// SortBy
// ---------------------------------------------------------------------------

function deparseSortBy(node: SortBy): string {
	let result = node.node ? deparse(node.node) : '';

	if (node.sortby_dir === 'SORTBY_ASC') {
		result += ' ASC';
	} else if (node.sortby_dir === 'SORTBY_DESC') {
		result += ' DESC';
	}

	if (node.sortby_nulls === 'SORTBY_NULLS_FIRST') {
		result += ' NULLS FIRST';
	} else if (node.sortby_nulls === 'SORTBY_NULLS_LAST') {
		result += ' NULLS LAST';
	}

	return result;
}

// ---------------------------------------------------------------------------
// WindowDef
// ---------------------------------------------------------------------------

// PostgreSQL frameOptions bitmask constants (from parsenodes.h, PostgreSQL 17)
// Only emit a frame clause when FRAMEOPTION_NONDEFAULT is set.
const FRAMEOPTION_NONDEFAULT = 0x00001;
const FRAMEOPTION_RANGE = 0x00002;
const FRAMEOPTION_ROWS = 0x00004;
const FRAMEOPTION_GROUPS = 0x00008;
const FRAMEOPTION_BETWEEN = 0x00010;
const FRAMEOPTION_START_UNBOUNDED_PRECEDING = 0x00020;
const FRAMEOPTION_END_UNBOUNDED_PRECEDING = 0x00040;
const FRAMEOPTION_START_UNBOUNDED_FOLLOWING = 0x00080;
const FRAMEOPTION_END_UNBOUNDED_FOLLOWING = 0x00100;
const FRAMEOPTION_START_CURRENT_ROW = 0x00200;
const FRAMEOPTION_END_CURRENT_ROW = 0x00400;

function deparseFrameOptions(frameOptions: number): string {
	// Only emit a frame clause when the NONDEFAULT bit is set.
	// Implicit default frames (e.g. from row_number()) do not have this bit and
	// pgsql-deparser omits them — we do the same.
	if (!(frameOptions & FRAMEOPTION_NONDEFAULT)) {
		return '';
	}

	const parts: string[] = [];

	if (frameOptions & FRAMEOPTION_RANGE) {
		parts.push('RANGE');
	} else if (frameOptions & FRAMEOPTION_ROWS) {
		parts.push('ROWS');
	} else if (frameOptions & FRAMEOPTION_GROUPS) {
		parts.push('GROUPS');
	}

	if (frameOptions & FRAMEOPTION_BETWEEN) {
		parts.push('BETWEEN');
	}

	if (frameOptions & FRAMEOPTION_START_UNBOUNDED_PRECEDING) {
		parts.push('UNBOUNDED PRECEDING');
	} else if (frameOptions & FRAMEOPTION_START_CURRENT_ROW) {
		parts.push('CURRENT ROW');
	} else if (frameOptions & FRAMEOPTION_START_UNBOUNDED_FOLLOWING) {
		parts.push('UNBOUNDED FOLLOWING');
	}

	if (frameOptions & FRAMEOPTION_BETWEEN) {
		parts.push('AND');

		if (frameOptions & FRAMEOPTION_END_CURRENT_ROW) {
			parts.push('CURRENT ROW');
		} else if (frameOptions & FRAMEOPTION_END_UNBOUNDED_FOLLOWING) {
			parts.push('UNBOUNDED FOLLOWING');
		} else if (frameOptions & FRAMEOPTION_END_UNBOUNDED_PRECEDING) {
			parts.push('UNBOUNDED PRECEDING');
		}
	}

	return parts.join(' ');
}

function deparseWindowDef(node: WindowDef): string {
	const parts: string[] = [];

	if (node.partitionClause && node.partitionClause.length > 0) {
		parts.push(
			`PARTITION BY ${node.partitionClause.map(nodeToStr).join(', ')}`,
		);
	}

	if (node.orderClause && node.orderClause.length > 0) {
		parts.push(`ORDER BY ${node.orderClause.map(nodeToStr).join(', ')}`);
	}

	if (node.frameOptions !== undefined && node.frameOptions !== 0) {
		const frame = deparseFrameOptions(node.frameOptions);
		if (frame) parts.push(frame);
	}

	return parts.join(' ');
}

// ---------------------------------------------------------------------------
// CTEs
// ---------------------------------------------------------------------------

function deparseCommonTableExpr(node: CommonTableExpr): string {
	const rec = node as unknown as Record<string, unknown>;
	const cteName = String(rec.ctename ?? '');
	const ctequery = rec.ctequery as Node | undefined;
	const cteCols = rec.cte_cols as Node[] | undefined;
	const cycleClause = rec.cycle_clause as CTECycleClause | undefined;

	let result = `${quoteIdent(cteName)} AS `;

	if (cteCols && cteCols.length > 0) {
		const cols = cteCols.map((c) => {
			const r = c as Record<string, unknown>;
			const k = Object.keys(r)[0]!;
			if (k === 'String') {
				return quoteIdent(String((r[k] as Record<string, unknown>).sval ?? ''));
			}
			return deparse(c);
		});
		result = `${quoteIdent(cteName)}(${cols.join(', ')}) AS `;
	}

	result += `(${ctequery ? deparse(ctequery) : ''})`;

	if (cycleClause) {
		result += ` ${deparseCTECycleClause(cycleClause)}`;
	}

	return result;
}

function deparseWithClause(node: WithClause): string {
	const recursive = node.recursive ? 'WITH RECURSIVE ' : 'WITH ';
	const ctes = (node.ctes ?? []).map(nodeToStr).join(', ');
	return `${recursive}${ctes}`;
}

function deparseCTECycleClause(node: CTECycleClause): string {
	const rec = node as unknown as Record<string, unknown>;
	const colList = (rec.cycle_col_list ?? []) as Node[];
	const markColumn = String(rec.cycle_mark_column ?? '');
	const pathColumn = String(rec.cycle_path_column ?? '');

	const cols = colList
		.map((c) => {
			const r = c as Record<string, unknown>;
			const k = Object.keys(r)[0]!;
			if (k === 'String') {
				return quoteIdent(String((r[k] as Record<string, unknown>).sval ?? ''));
			}
			return deparse(c);
		})
		.join(', ');

	return `CYCLE ${cols} SET ${quoteIdent(markColumn)} USING ${quoteIdent(pathColumn)}`;
}

// ---------------------------------------------------------------------------
// SelectStmt
// ---------------------------------------------------------------------------

function deparseSelectStmt(node: SelectStmt): string {
	const rec = node as unknown as Record<string, unknown>;
	const op = rec.op as string | undefined;

	// UNION / INTERSECT / EXCEPT
	if (op && op !== 'SETOP_NONE') {
		const larg = rec.larg as SelectStmt | undefined;
		const rarg = rec.rarg as SelectStmt | undefined;
		const all = rec.all as boolean | undefined;
		const left = larg ? deparseSelectStmt(larg) : '';
		const right = rarg ? deparseSelectStmt(rarg) : '';
		let setOp: string;
		switch (op) {
			case 'SETOP_UNION':
				setOp = all ? 'UNION ALL' : 'UNION';
				break;
			case 'SETOP_INTERSECT':
				setOp = all ? 'INTERSECT ALL' : 'INTERSECT';
				break;
			case 'SETOP_EXCEPT':
				setOp = all ? 'EXCEPT ALL' : 'EXCEPT';
				break;
			default:
				setOp = op;
		}
		return `${left} ${setOp} ${right}`;
	}

	// VALUES clause
	const valuesLists = rec.valuesLists as Node[] | undefined;
	if (valuesLists && valuesLists.length > 0) {
		const rows = valuesLists.map((row) => {
			const rowRec = row as Record<string, unknown>;
			const items = (rowRec.List as { items: Node[] } | undefined)?.items ?? [];
			return `(${items.map(nodeToStr).join(', ')})`;
		});
		return `VALUES ${rows.join(', ')}`;
	}

	const parts: string[] = [];

	// WITH clause
	const withClause = rec.withClause as WithClause | undefined;
	if (withClause) {
		parts.push(deparseWithClause(withClause));
	}

	// SELECT [DISTINCT]
	const distinctClause = rec.distinctClause as Node[] | undefined;
	let selectKeyword = 'SELECT';
	if (distinctClause !== undefined) {
		if (Array.isArray(distinctClause) && distinctClause.length > 0) {
			const cols = distinctClause.map(nodeToStr).join(', ');
			selectKeyword = `SELECT DISTINCT ON (${cols})`;
		} else {
			selectKeyword = 'SELECT DISTINCT';
		}
	}
	parts.push(selectKeyword);

	// Target list
	const targetList = node.targetList ?? [];
	if (targetList.length > 0) {
		parts.push(targetList.map(nodeToStr).join(', '));
	}

	// FROM clause
	const fromClause = node.fromClause ?? [];
	if (fromClause.length > 0) {
		parts.push(`FROM ${fromClause.map(nodeToStr).join(', ')}`);
	}

	// WHERE
	if (node.whereClause) {
		parts.push(`WHERE ${deparse(node.whereClause)}`);
	}

	// GROUP BY
	const groupClause = node.groupClause ?? [];
	if (groupClause.length > 0) {
		parts.push(`GROUP BY ${groupClause.map(nodeToStr).join(', ')}`);
	}

	// HAVING
	if (node.havingClause) {
		parts.push(`HAVING ${deparse(node.havingClause)}`);
	}

	// ORDER BY
	const sortClause = node.sortClause ?? [];
	if (sortClause.length > 0) {
		parts.push(`ORDER BY ${sortClause.map(nodeToStr).join(', ')}`);
	}

	// LIMIT
	if (node.limitCount) {
		parts.push(`LIMIT ${deparse(node.limitCount)}`);
	}

	// OFFSET
	if (node.limitOffset) {
		parts.push(`OFFSET ${deparse(node.limitOffset)}`);
	}

	// FOR UPDATE / SHARE locking clause
	const lockingClause = node.lockingClause ?? [];
	for (const lc of lockingClause) {
		parts.push(deparse(lc));
	}

	return parts.join(' ');
}

// ---------------------------------------------------------------------------
// InsertStmt
// ---------------------------------------------------------------------------

function deparseInsertStmt(node: InsertStmt): string {
	const parts: string[] = ['INSERT INTO'];

	if (node.relation) {
		parts.push(deparseRangeVar(node.relation));
	}

	if (node.cols && node.cols.length > 0) {
		const cols = node.cols.map((c) => {
			const r = c as Record<string, unknown>;
			// Format 1: { ResTarget: { name: "col" } }  (ast-helpers.ts)
			if ('ResTarget' in r) {
				const rt = r.ResTarget as ResTarget | undefined;
				return quoteIdent(rt?.name ?? '');
			}
			// Format 2: { String: { sval: "col" } }  (upsert.ts)
			if ('String' in r) {
				const s = r.String as Record<string, unknown> | undefined;
				return quoteIdent(String(s?.sval ?? ''));
			}
			return deparse(c);
		});
		parts.push(`(${cols.join(', ')})`);
	}

	if (node.override && node.override !== 'OVERRIDING_NOT_SET') {
		if (node.override === 'OVERRIDING_SYSTEM_VALUE') {
			parts.push('OVERRIDING SYSTEM VALUE');
		} else if (node.override === 'OVERRIDING_USER_VALUE') {
			parts.push('OVERRIDING USER VALUE');
		}
	}

	if (node.selectStmt) {
		parts.push(deparse(node.selectStmt));
	}

	if (node.onConflictClause) {
		parts.push(`ON CONFLICT ${deparseOnConflictClause(node.onConflictClause)}`);
	}

	const returningExprs = node.returningClause?.exprs ?? [];
	if (returningExprs.length > 0) {
		parts.push(`RETURNING ${returningExprs.map(nodeToStr).join(', ')}`);
	}

	return parts.join(' ');
}

// ---------------------------------------------------------------------------
// UpdateStmt
// ---------------------------------------------------------------------------

function deparseUpdateStmt(node: UpdateStmt): string {
	const parts: string[] = ['UPDATE'];

	if (node.relation) {
		parts.push(deparseRangeVar(node.relation));
	}

	const setItems = (node.targetList ?? []).map((t) => {
		const rt = (t as Record<string, unknown>).ResTarget as
			| ResTarget
			| undefined;
		const name = rt?.name ?? '';
		const val = rt?.val ? deparse(rt.val) : '';
		return `${quoteIdent(name)} = ${val}`;
	});
	parts.push(`SET ${setItems.join(',')}`);

	const fromClause = node.fromClause ?? [];
	if (fromClause.length > 0) {
		parts.push(`FROM ${fromClause.map(nodeToStr).join(', ')}`);
	}

	if (node.whereClause) {
		parts.push(`WHERE ${deparse(node.whereClause)}`);
	}

	const returningExprs = node.returningClause?.exprs ?? [];
	if (returningExprs.length > 0) {
		parts.push(`RETURNING ${returningExprs.map(nodeToStr).join(', ')}`);
	}

	return parts.join(' ');
}

// ---------------------------------------------------------------------------
// DeleteStmt
// ---------------------------------------------------------------------------

function deparseDeleteStmt(node: DeleteStmt): string {
	const parts: string[] = ['DELETE FROM'];

	if (node.relation) {
		parts.push(deparseRangeVar(node.relation));
	}

	const usingClause = (node as unknown as Record<string, unknown>)
		.usingClause as Node[] | undefined;
	if (usingClause && usingClause.length > 0) {
		parts.push(`USING ${usingClause.map(nodeToStr).join(', ')}`);
	}

	if (node.whereClause) {
		parts.push(`WHERE ${deparse(node.whereClause)}`);
	}

	const returningExprs = node.returningClause?.exprs ?? [];
	if (returningExprs.length > 0) {
		parts.push(`RETURNING ${returningExprs.map(nodeToStr).join(', ')}`);
	}

	return parts.join(' ');
}

// ---------------------------------------------------------------------------
// OnConflictClause
// ---------------------------------------------------------------------------

function deparseOnConflictClause(node: OnConflictClause): string {
	const parts: string[] = [];

	if (node.infer) {
		parts.push(deparseInferClause(node.infer));
	}

	if (node.action === 'ONCONFLICT_NOTHING') {
		parts.push('DO NOTHING');
	} else if (node.action === 'ONCONFLICT_UPDATE') {
		const setItems = (node.targetList ?? []).map((t) => {
			const rt = (t as Record<string, unknown>).ResTarget as
				| ResTarget
				| undefined;
			const name = rt?.name ?? '';
			const val = rt?.val ? deparse(rt.val) : '';
			return `${quoteIdent(name)} = ${val}`;
		});
		parts.push(`DO UPDATE SET ${setItems.join(', ')}`);

		if (node.whereClause) {
			parts.push(`WHERE ${deparse(node.whereClause)}`);
		}
	}

	return parts.join(' ');
}

// ---------------------------------------------------------------------------
// InferClause
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
function deparseInferClause(node: InferClause): string {
	if (node.conname) {
		return `ON CONSTRAINT ${quoteIdent(node.conname)}`;
	}
	const indexElems = node.indexElems ?? [];
	let result = '';
	if (indexElems.length > 0) {
		const cols = indexElems.map((e) => {
			const ie = (e as Record<string, unknown>).IndexElem as
				| IndexElem
				| undefined;
			return ie ? deparseIndexElem(ie) : deparse(e);
		});
		result = `(${cols.join(', ')})`;
	}
	// Partial-index predicate for ON CONFLICT: emit WHERE <expr> after the column list.
	// e.g. ON CONFLICT (col) WHERE active = true DO UPDATE ...
	if (node.whereClause) {
		const where = deparse(node.whereClause as Node);
		result = result ? `${result} WHERE ${where}` : `WHERE ${where}`;
	}
	return result;
}

// ---------------------------------------------------------------------------
// IndexElem
// ---------------------------------------------------------------------------

function deparseIndexElem(node: IndexElem): string {
	if (node.name) {
		return quoteIdent(node.name);
	}
	if (node.expr) {
		return deparse(node.expr);
	}
	return '';
}

// ---------------------------------------------------------------------------
// RangeFunction  (e.g. unnest(...) [WITH ORDINALITY] AS alias(col1, col2))
// ---------------------------------------------------------------------------

function deparseRangeFunction(node: Record<string, unknown>): string {
	const functions = (node.functions ?? []) as Node[];
	const ordinality = node.ordinality as boolean | undefined;
	const alias = node.alias as Record<string, unknown> | undefined;

	// Each element in `functions` is a List node with [funcCall, defList?]
	const funcParts = functions.map((f) => {
		const fRec = f as Record<string, unknown>;
		if ('List' in fRec) {
			const items = (fRec.List as Record<string, unknown>).items as
				| Node[]
				| undefined;
			// First item is the function call, rest are def elements
			const funcNode = items?.[0];
			return funcNode ? deparse(funcNode) : '';
		}
		return deparse(f);
	});

	let result = funcParts.join(', ');

	if (ordinality) {
		result += ' WITH ORDINALITY';
	}

	if (alias) {
		const aliasname = String(alias.aliasname ?? '');
		result += ` AS ${quoteIdent(aliasname)}`;

		const colnames = (alias.colnames ?? []) as Node[];
		if (colnames.length > 0) {
			const cols = colnames.map((c) => {
				const cr = c as Record<string, unknown>;
				if ('String' in cr) {
					return quoteIdent(
						String((cr.String as Record<string, unknown>).sval ?? ''),
					);
				}
				return deparse(c);
			});
			result += `(${cols.join(', ')})`;
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// RangeSubselect  (e.g. LATERAL (SELECT ...) AS alias)
// ---------------------------------------------------------------------------

function deparseRangeSubselect(node: Record<string, unknown>): string {
	const lateral = node.lateral as boolean | undefined;
	const subquery = node.subquery as Node | undefined;
	const alias = node.alias as Record<string, unknown> | undefined;

	const prefix = lateral ? 'LATERAL ' : '';
	const subStr = subquery ? deparse(subquery) : '';
	let result = `${prefix}(${subStr})`;

	if (alias) {
		const aliasname = String(alias.aliasname ?? '');
		result += ` AS ${quoteIdent(aliasname)}`;
	}

	return result;
}

// ---------------------------------------------------------------------------
// LockingClause
// ---------------------------------------------------------------------------

const LOCK_STRENGTH_MAP: Record<string, string> = {
	LCS_NONE: '',
	LCS_FORKEYSHARE: 'FOR KEY SHARE',
	LCS_FORSHARE: 'FOR SHARE',
	LCS_FORNOKEYUPDATE: 'FOR NO KEY UPDATE',
	LCS_FORUPDATE: 'FOR UPDATE',
};

const WAIT_POLICY_MAP: Record<string, string> = {
	LockWaitBlock: '',
	LockWaitSkip: 'SKIP LOCKED',
	LockWaitError: 'NOWAIT',
};

function deparseLockingClause(node: LockingClause): string {
	const parts: string[] = [];

	const strength = node.strength
		? (LOCK_STRENGTH_MAP[node.strength] ?? '')
		: '';
	if (strength) parts.push(strength);

	const lockedRels = node.lockedRels ?? [];
	if (lockedRels.length > 0) {
		const tables = lockedRels.map(nodeToStr).join(', ');
		parts.push(`OF ${tables}`);
	}

	const waitPolicy = node.waitPolicy
		? (WAIT_POLICY_MAP[node.waitPolicy] ?? '')
		: '';
	if (waitPolicy) parts.push(waitPolicy);

	return parts.join(' ');
}

// ---------------------------------------------------------------------------
// ExplainStmt
// ---------------------------------------------------------------------------

function deparseExplainStmt(node: ExplainStmt): string {
	const parts: string[] = ['EXPLAIN'];

	const opts = node.options ?? [];
	if (opts.length > 0) {
		const optStr = opts.map(nodeToStr).join(', ');
		parts.push(`(${optStr})`);
	}

	if (node.query) {
		parts.push(deparse(node.query));
	}

	return parts.join(' ');
}

// ---------------------------------------------------------------------------
// DefElem (used in EXPLAIN options)
// ---------------------------------------------------------------------------

function deparseDefElem(node: DefElem): string {
	const rec = node as unknown as Record<string, unknown>;
	const defname = String(rec.defname ?? '');
	const name = defname.toUpperCase();
	const arg = rec.arg as Node | undefined;

	if (arg) {
		const argRec = arg as Record<string, unknown>;
		const argKey = Object.keys(argRec)[0]!;
		if (argKey === 'String') {
			const sval = String(
				(argRec[argKey] as Record<string, unknown>).sval ?? '',
			);
			return `${name} ${sval.toUpperCase()}`;
		}
		return `${name} ${deparse(arg)}`;
	}
	return name;
}

// ---------------------------------------------------------------------------
// ClosePortalStmt
// ---------------------------------------------------------------------------

function deparseClosePortalStmt(node: ClosePortalStmt): string {
	const rec = node as unknown as Record<string, unknown>;
	const portalname = rec.portalname as string | undefined;
	if (portalname) {
		return `CLOSE ${quoteIdent(portalname)}`;
	}
	return 'CLOSE ALL';
}

// ---------------------------------------------------------------------------
// List (used in BETWEEN rexpr etc.)
// ---------------------------------------------------------------------------

function deparseListNode(node: { items?: Node[] }): string {
	return (node.items ?? []).map(nodeToStr).join(', ');
}

// ---------------------------------------------------------------------------
// A_ArrayExpr (ARRAY[...])
// ---------------------------------------------------------------------------

function deparseArrayExpr(node: A_ArrayExpr): string {
	const elements = (node.elements ?? []).map(nodeToStr);
	return `ARRAY[${elements.join(', ')}]`;
}

// ---------------------------------------------------------------------------
// DeclareCursorStmt
// ---------------------------------------------------------------------------

function deparseDeclareCursorStmt(node: DeclareCursorStmt): string {
	const rec = node as unknown as Record<string, unknown>;
	const portalname = String(rec.portalname ?? '');
	const query = rec.query as Node | undefined;
	const opts = (rec.options as number | undefined) ?? 0;

	const parts: string[] = ['DECLARE', quoteIdent(portalname)];

	if (opts & 0x0001) parts.push('BINARY');
	if (opts & 0x0002) parts.push('SCROLL');
	if (opts & 0x0004) parts.push('NO SCROLL');

	parts.push('CURSOR');

	if (opts & 0x0010) parts.push('WITH HOLD');

	parts.push('FOR');
	if (query) parts.push(deparse(query));

	return parts.join(' ');
}

// ---------------------------------------------------------------------------
// FetchStmt
// ---------------------------------------------------------------------------

const FETCH_DIR_MAP: Record<string, string> = {
	FETCH_FORWARD: 'FORWARD',
	FETCH_BACKWARD: 'BACKWARD',
	FETCH_ABSOLUTE: 'ABSOLUTE',
	FETCH_RELATIVE: 'RELATIVE',
};

function deparseFetchStmt(node: FetchStmt): string {
	const rec = node as unknown as Record<string, unknown>;
	const direction = String(rec.direction ?? '');
	const howMany = rec.howMany;
	const portalname = String(rec.portalname ?? '');

	// PostgreSQL uses LONG_MAX (9223372036854775807) as a sentinel for "ALL".
	// The pgsql-deparser library stores this as the float64 approximation 9223372036854776000.
	// Mirror the same sentinel check so the internal deparser matches the external one.
	const isAll = howMany === 9223372036854776000;

	const parts: string[] = ['FETCH'];
	const dir = FETCH_DIR_MAP[direction] ?? direction;

	switch (direction) {
		case 'FETCH_FORWARD':
			if (isAll) {
				parts.push('FORWARD', 'ALL');
			} else if (howMany !== undefined && howMany !== null) {
				parts.push(`${dir} ${String(howMany)}`);
			} else {
				parts.push(dir);
			}
			break;
		case 'FETCH_BACKWARD':
			if (isAll) {
				parts.push('BACKWARD', 'ALL');
			} else if (howMany !== undefined && howMany !== null) {
				parts.push(`${dir} ${String(howMany)}`);
			} else {
				parts.push(dir);
			}
			break;
		default:
			if (howMany !== undefined && howMany !== null) {
				parts.push(`${dir} ${String(howMany)}`);
			} else {
				parts.push(dir);
			}
	}

	parts.push(`FROM ${quoteIdent(portalname)}`);

	return parts.join(' ');
}
