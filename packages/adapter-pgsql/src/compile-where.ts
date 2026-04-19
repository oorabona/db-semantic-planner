/**
 * Unified WHERE compiler: compiles WhereIntent directly to PostgreSQL AST nodes.
 *
 * This is the new direct path that eliminates the intermediate
 * Decision/PlanDecision representation for WHERE clauses.
 * Both paths (Decision-based and WhereIntent-based) produce identical SQL.
 *
 * @internal
 */

import type {
	ExpressionIntent,
	ModelIR,
	QueryIntent,
	WhereAndIntent,
	WhereComparisonIntent,
	WhereIntent,
	WhereLikeIntent,
	WhereNotIntent,
	WhereOrIntent,
	WhereRawExistsIntent,
	WhereRawNotExistsIntent,
	WhereRelationFilterIntent,
} from '@dbsp/types';
import type { Node, SelectStmt, SubLink } from '@pgsql/types';
import {
	andExpr,
	binaryExpr,
	columnRef,
	notExpr,
	orExpr,
	rangeVar,
} from './ast-helpers.js';
import {
	compileExpressionIntent,
	registerWhereDispatcherFactory,
} from './handlers/expression/custom.js';
import { createWhereDispatcher } from './handlers/index.js';

// Register createWhereDispatcher with the expression compiler so that CASE expressions
// in compileExpressionIntent can compile their WHEN conditions. This module is the
// natural bridge: it imports both custom.ts and handlers/index.ts.
// Called once at module-load time (safe: no circular calls, just stores the factory ref).
registerWhereDispatcherFactory(createWhereDispatcher);

import type {
	CompilerContext,
	CompilerState,
	Decision,
} from './handlers/types.js';
import { createCompilerState } from './handlers/types.js';
import type { NamingPlugin } from './naming-plugin.js';
import { identityNaming } from './naming-plugin.js';
import { createParamRef } from './param-ref.js';

// ============================================================================
// Module-level constants
// ============================================================================

/** Operator name → SQL operator string. Shared by expression and subquery WHERE handlers. */
const OP_MAP: Record<string, string> = {
	eq: '=',
	neq: '!=',
	gt: '>',
	gte: '>=',
	lt: '<',
	lte: '<=',
	'=': '=',
	'!=': '!=',
	'>': '>',
	'>=': '>=',
	'<': '<',
	'<=': '<=',
};

// ============================================================================
// Public: WhereCompilerCtx
// ============================================================================

/**
 * Context for the unified WHERE compiler.
 * Maps to CompilerContext + CompilerState from the handler system.
 */
export type WhereCompilerCtx = {
	/** Current root table name (or alias) */
	readonly rootTable: string;
	/** Alias map: alias → real table name */
	readonly aliases: Map<string, string>;
	/** Shared mutable parameter state (parameters array + current index) */
	readonly paramState: CompilerState;
	/** Schema model for FK resolution and type-aware casting */
	readonly model?: ModelIR;
	/** Schema name for table qualification */
	readonly schemaName?: string;
	/** Naming convention plugin */
	readonly naming: NamingPlugin;
	/**
	 * Callback to compile a QueryIntent subquery into an AST node.
	 * Used by EXISTS/NOT EXISTS handlers that need correlated subqueries.
	 * Returns the compiled AST node, the count of parameters consumed, and
	 * the actual parameter values so the caller can push them to the outer state.
	 */
	readonly compileSubquery: (
		intent: QueryIntent,
		paramOffset: number,
	) => { sql: Node; paramCount: number; parameters?: unknown[] };
	/**
	 * Optional callback to compile an ExpressionIntent to a Node.
	 * Used by the 'expression' WHERE kind.
	 */
	readonly compileExpression?: (intent: ExpressionIntent) => Node;
	/**
	 * Outer table alias for outerRef() resolution in EXISTS subqueries.
	 * When set, FieldRef with scope:'outer' resolves to this alias.
	 */
	readonly outerTable?: string;
	/**
	 * Override for the current alias (scope:'inner' FieldRef resolution).
	 * Defaults to `rootTable` when not set.
	 * Used for JOIN ON conditions where the alias differs from the root table.
	 */
	readonly currentAlias?: string;
};

// ============================================================================
// Private: bridge WhereCompilerCtx → CompilerContext
// ============================================================================

function toHandlerContext(ctx: WhereCompilerCtx): CompilerContext {
	return {
		naming: ctx.naming,
		rootTable: ctx.rootTable,
		currentAlias: ctx.currentAlias ?? ctx.rootTable,
		maxRecursiveDepth: 100,
		...(ctx.schemaName !== undefined && { schema: ctx.schemaName }),
		...(ctx.model !== undefined && { model: ctx.model }),
		...(ctx.outerTable !== undefined && { outerAlias: ctx.outerTable }),
	};
}

// ============================================================================
// Public: buildSubqueryFromIntent
// ============================================================================

/**
 * Build a minimal SELECT AST node from a QueryIntent.
 *
 * Used as the `compileSubquery` callback in WhereCompilerCtx so that
 * WhereSubqueryIntent (kind: 'subquery') can compile to:
 *   field OP (SELECT col FROM table [WHERE ...])
 *
 * @param intent      - The inner QueryIntent describing the subquery
 * @param paramOffset - Current outer $N offset; inner WHERE params start at offset+1
 * @param naming      - Naming plugin (optional, defaults to identityNaming)
 * @returns The compiled SelectStmt node and the count of parameters consumed
 */
export function buildSubqueryFromIntent(
	intent: QueryIntent,
	paramOffset: number,
	naming: NamingPlugin = identityNaming,
	schemaName?: string,
): { sql: Node; paramCount: number; parameters?: unknown[] } {
	const targetTable = intent.from;
	const innerAlias = `${targetTable}_sq`;

	// Build target list: SELECT col or SELECT agg(col)... or SELECT 1
	const select = intent.select as
		| {
				fields?: string[];
				type?: string;
				aggregates?: { function: string; field?: string }[];
		  }
		| undefined;

	let targetList: SelectStmt['targetList'];
	if (
		select?.type === 'aggregate' &&
		select.aggregates &&
		select.aggregates.length > 0
	) {
		// Build a ResTarget for EACH aggregate so multi-aggregate subqueries compile correctly.
		targetList = select.aggregates.map((agg) => {
			let aggNode: Node;
			if (!agg.field || agg.field === '*') {
				aggNode = {
					FuncCall: {
						funcname: [{ String: { sval: agg.function.toLowerCase() } }],
						agg_star: true,
					},
				};
			} else {
				const aggArg = columnRef(agg.field, innerAlias, undefined, naming);
				aggNode = {
					FuncCall: {
						funcname: [{ String: { sval: agg.function.toLowerCase() } }],
						args: [aggArg],
					},
				};
			}
			return { ResTarget: { val: aggNode } };
		});
	} else if (select?.fields?.[0]) {
		targetList = [
			{
				ResTarget: {
					val: columnRef(select.fields[0], innerAlias, undefined, naming),
				},
			},
		];
	} else {
		targetList = [{ ResTarget: { val: { A_Const: { ival: { ival: 1 } } } } }];
	}

	const stmt: SelectStmt = {
		targetList,
		// Bug 3 fix: propagate schema name from outer context so schema-scoped
		// queries generate "schema"."table" AS alias instead of bare "table" AS alias.
		fromClause: [rangeVar(targetTable, innerAlias, schemaName, naming)],
	};

	let paramCount = 0;
	let innerParameters: unknown[] = [];

	// Compile inner WHERE if present, using a nested WhereCompilerCtx
	if (intent.where) {
		const innerState = createCompilerState();
		// Seed inner param index from outer offset so params are contiguous ($offset+1, $offset+2, ...)
		innerState.paramIndex = paramOffset;
		const innerCtx: WhereCompilerCtx = {
			// Bug 2 fix: use the alias name as rootTable so WHERE handlers emit
			// "posts_sq"."col" = $N instead of "posts"."col" = $N (table is aliased).
			rootTable: innerAlias,
			aliases: new Map(),
			paramState: innerState,
			naming,
			compileSubquery: (_nestedIntent, _nestedOffset) => {
				throw new Error(
					'buildSubqueryFromIntent: nested subquery not supported',
				);
			},
		};
		stmt.whereClause = compileWhereIntent(
			intent.where as WhereIntent,
			innerCtx,
		);
		// Expose inner parameters so callers (P2-3 fix) can push them to the outer state.
		paramCount = innerState.paramIndex - paramOffset;
		innerParameters = innerState.parameters;
	}

	return { sql: { SelectStmt: stmt }, paramCount, parameters: innerParameters };
}

// ============================================================================
// Public: compileWhereIntent
// ============================================================================

/**
 * Compile a WhereIntent directly to a PostgreSQL AST Node.
 *
 * Handles all 16 WhereIntent kinds:
 * - comparison, like, in, any, null, range
 * - and, or, not
 * - exists, notExists, relationFilter
 * - subquery, jsonContains, jsonExists, expression
 *
 * Uses the existing handler dispatch system under the hood:
 *   WhereIntent → normalizeToDecision (inside createWhereDispatcher) → handler → Node
 *
 * This avoids duplicating 16 handler implementations while providing a
 * clean WhereIntent → Node API that bypasses the PlanDecision layer.
 *
 * @param intent - The WhereIntent to compile
 * @param ctx    - Compiler context with table info, params, model, etc.
 * @returns PostgreSQL AST node representing the WHERE condition
 */

// ============================================================================
// Private: per-kind handlers extracted from compileWhereIntent
// Each function handles exactly one intent.kind case.
// ============================================================================

/**
 * Handle the 'range' kind: overlaps (&&), contains (@>), containedBy (<@), between.
 * Resolves the range data type from the model when available.
 */
function handleRangeIntent(
	intent: WhereIntent,
	ctx: WhereCompilerCtx,
	dispatcher: ReturnType<typeof createWhereDispatcher>,
	handlerCtx: CompilerContext,
): Node {
	const { field, operator, value } = intent as {
		field: string;
		operator: string;
		value: unknown;
	};

	let rangeDataType: string | undefined;
	if (ctx.model && operator !== 'between') {
		const table = ctx.model.getTable(ctx.rootTable);
		if (table) {
			const col = table.columns.find((c) => c.name === field);
			if (col?.type.endsWith('range')) {
				rangeDataType = col.type;
			}
		}
	}

	if (operator === 'between') {
		const rv = value as { lower: unknown; upper: unknown };
		return dispatcher(
			{
				type: 'where',
				column: field,
				operator: 'between',
				value: [rv.lower, rv.upper],
			} as Decision,
			handlerCtx,
			ctx.paramState,
		);
	}

	return dispatcher(
		{
			type: 'where',
			column: field,
			operator,
			value,
			...(rangeDataType !== undefined && { dataType: rangeDataType }),
		} as Decision,
		handlerCtx,
		ctx.paramState,
	);
}

/**
 * Handle the 'like' kind when an `escape` character is present.
 * The generic dispatcher loses the escape field via normalizeToDecision,
 * so we handle it directly to preserve LIKE $1 ESCAPE $2 semantics.
 */
function handleLikeWithEscape(
	intent: WhereLikeIntent,
	ctx: WhereCompilerCtx,
	dispatcher: ReturnType<typeof createWhereDispatcher>,
	handlerCtx: CompilerContext,
): Node {
	const operator = intent.caseInsensitive ? 'ilike' : 'like';
	return dispatcher(
		{
			type: 'where',
			column: intent.field,
			operator,
			value: intent.pattern,
			escape: intent.escape,
		} as Decision,
		handlerCtx,
		ctx.paramState,
	);
}

/**
 * Handle the 'expression' kind: left-side ExpressionIntent with comparison or standalone.
 * The generic dispatcher would mis-dispatch via the comparison handler (which expects column).
 */
function handleExpressionIntent(
	intent: WhereIntent,
	ctx: WhereCompilerCtx,
	handlerCtx: CompilerContext,
): Node {
	const exprIntent = intent as {
		expr: ExpressionIntent;
		value?: unknown;
		operator: string;
	};

	const leftNode = compileExpressionIntent(
		exprIntent.expr,
		handlerCtx,
		ctx.paramState,
	);

	if (exprIntent.value === undefined) {
		return leftNode;
	}

	const idx = ++ctx.paramState.paramIndex;
	ctx.paramState.parameters.push(exprIntent.value);
	const rightNode = createParamRef(idx);
	const sqlOp = OP_MAP[exprIntent.operator] ?? '=';
	return binaryExpr(sqlOp, leftNode, rightNode);
}

/**
 * Handle the 'subquery' kind: field OP (SELECT ... FROM ...).
 * The generic dispatcher would fall through to the comparison handler — wrong.
 */
function handleSubqueryIntent(
	intent: WhereIntent,
	ctx: WhereCompilerCtx,
	_handlerCtx: CompilerContext,
): Node {
	const { field, operator, subquery } = intent as {
		field: string;
		operator: string;
		subquery: Parameters<WhereCompilerCtx['compileSubquery']>[0];
	};

	const {
		sql: subqueryNode,
		paramCount,
		parameters: innerParams,
	} = ctx.compileSubquery(subquery, ctx.paramState.paramIndex);

	if (innerParams) {
		for (const p of innerParams) {
			ctx.paramState.parameters.push(p);
		}
	}
	ctx.paramState.paramIndex += paramCount;

	const leftOperand = columnRef(field, ctx.rootTable, undefined, ctx.naming);
	const sqlOp = OP_MAP[operator] ?? '=';

	const subLink: SubLink = {
		subLinkType: 'EXPR_SUBLINK',
		subselect: subqueryNode,
	};
	return binaryExpr(sqlOp, leftOperand, { SubLink: subLink });
}

/**
 * Handle the 'relationFilter' kind by converting to exists/notExists and recursing.
 * The generic dispatcher would fall through to '=' handler — wrong.
 */
function handleRelationFilterIntent(
	intent: WhereIntent,
	ctx: WhereCompilerCtx,
): Node {
	const rf = intent as WhereRelationFilterIntent;
	const relation = Array.isArray(rf.relation)
		? (rf.relation[0] as string)
		: (rf.relation as string);

	// mode:'some'  → EXISTS         (at least one matches)
	// mode:'none'  → NOT EXISTS     (none match)
	// mode:'every' → NOT EXISTS WHERE NOT condition (all match)
	const existsKind =
		rf.mode === 'none' || rf.mode === 'every' ? 'notExists' : 'exists';
	const innerWhere: WhereIntent =
		rf.mode === 'every'
			? ({ kind: 'not', condition: rf.where } as WhereIntent)
			: rf.where;

	const resolvedRelation = ctx.model?.getRelation(
		`${ctx.rootTable}.${relation}`,
	);
	const targetTable = resolvedRelation?.target ?? relation;

	return compileWhereIntent(
		{
			kind: existsKind,
			relation,
			targetTable,
			where: innerWhere,
		} as unknown as WhereIntent,
		ctx,
	);
}

/**
 * Handle the 'rawExists' and 'rawNotExists' kinds: EXISTS / NOT EXISTS wrappers
 * around a QueryIntent subquery. No Decision equivalent — compiled directly via
 * compileSubquery callback then wrapped in a SubLink node.
 */
function handleRawExistsIntent(
	intent: WhereIntent,
	ctx: WhereCompilerCtx,
): Node {
	const subIntent = (intent as WhereRawExistsIntent | WhereRawNotExistsIntent)
		.subquery;
	const {
		sql: subNode,
		paramCount,
		parameters: innerParams,
	} = ctx.compileSubquery(subIntent, ctx.paramState.paramIndex);

	if (innerParams) {
		for (const p of innerParams) ctx.paramState.parameters.push(p);
	}
	ctx.paramState.paramIndex += paramCount;

	const subLink = {
		SubLink: { subLinkType: 'EXISTS_SUBLINK', subselect: subNode },
	};
	return intent.kind === 'rawNotExists'
		? notExpr(subLink as unknown as Node)
		: (subLink as unknown as Node);
}

/**
 * Handle the 'and', 'or', 'not' kinds recursively via compileWhereIntent.
 * If delegated to the dispatcher, nested 'expression' conditions would mis-dispatch.
 * Returns null when the kind is not handled here (caller falls through).
 */
function handleLogicalIntent(
	intent: WhereIntent,
	ctx: WhereCompilerCtx,
): Node | null {
	if (intent.kind === 'and') {
		const conditions = (intent as WhereAndIntent).conditions;
		const nodes = conditions.map((c) => compileWhereIntent(c, ctx));
		if (nodes.length === 0) {
			return {
				TypeCast: {
					arg: { Integer: { ival: 1 } },
					typeName: {
						TypeName: { names: [{ String: { sval: 'bool' } }], typemod: -1 },
					},
				},
			} as unknown as Node;
		}
		if (nodes.length === 1) return nodes[0]!;
		return andExpr(...nodes);
	}
	if (intent.kind === 'or') {
		const conditions = (intent as WhereOrIntent).conditions;
		const nodes = conditions.map((c) => compileWhereIntent(c, ctx));
		if (nodes.length === 0) {
			return {
				TypeCast: {
					arg: { Integer: { ival: 0 } },
					typeName: {
						TypeName: { names: [{ String: { sval: 'bool' } }], typemod: -1 },
					},
				},
			} as unknown as Node;
		}
		if (nodes.length === 1) return nodes[0]!;
		return orExpr(...nodes);
	}
	if (intent.kind === 'not') {
		return notExpr(
			compileWhereIntent((intent as WhereNotIntent).condition, ctx),
		);
	}
	return null;
}

/**
 * Handle the 'comparison' kind when the right-hand value is an ExpressionRef.
 * The generic comparison handler expects a scalar value and would call buildParamRef — wrong.
 * Returns null when value is not an ExpressionRef (caller falls through to dispatcher).
 */
function handleComparisonWithExprRef(
	intent: WhereIntent,
	ctx: WhereCompilerCtx,
	handlerCtx: CompilerContext,
): Node | null {
	const cmpIntent = intent as WhereComparisonIntent;
	const v = cmpIntent.value;
	const isExprRef =
		v !== null &&
		typeof v === 'object' &&
		(v as Record<string, unknown>).__expr === true;

	if (!isExprRef) return null;

	const exprRef = v as { intent: ExpressionIntent };
	const leftNode = columnRef(
		cmpIntent.field,
		ctx.rootTable,
		undefined,
		ctx.naming,
	);
	const rightNode = compileExpressionIntent(
		exprRef.intent,
		handlerCtx,
		ctx.paramState,
	);
	const sqlOp = OP_MAP[cmpIntent.operator] ?? '=';
	return binaryExpr(sqlOp, leftNode, rightNode);
}

export function compileWhereIntent(
	intent: WhereIntent,
	ctx: WhereCompilerCtx,
): Node {
	const dispatcher = createWhereDispatcher();
	const handlerCtx = toHandlerContext(ctx);

	if (intent.kind === 'range') {
		return handleRangeIntent(intent, ctx, dispatcher, handlerCtx);
	}
	if (
		intent.kind === 'like' &&
		(intent as WhereLikeIntent).escape !== undefined
	) {
		return handleLikeWithEscape(
			intent as WhereLikeIntent,
			ctx,
			dispatcher,
			handlerCtx,
		);
	}
	if (intent.kind === 'expression') {
		return handleExpressionIntent(intent, ctx, handlerCtx);
	}
	if (intent.kind === 'subquery') {
		return handleSubqueryIntent(intent, ctx, handlerCtx);
	}
	if (intent.kind === 'relationFilter') {
		return handleRelationFilterIntent(intent, ctx);
	}
	if (intent.kind === 'rawExists' || intent.kind === 'rawNotExists') {
		return handleRawExistsIntent(intent, ctx);
	}

	const logicalResult = handleLogicalIntent(intent, ctx);
	if (logicalResult !== null) return logicalResult;

	if (intent.kind === 'comparison') {
		const exprRefResult = handleComparisonWithExprRef(intent, ctx, handlerCtx);
		if (exprRefResult !== null) return exprRefResult;
	}

	// Fallback to dispatcher: comparison, like, in, any, null, exists, notExists,
	// jsonContains, jsonExists — plus pass-through for unknown kinds.
	const needsColumn = intent.kind === 'comparison' || intent.kind === 'null';
	const bridged = needsColumn
		? ({
				...intent,
				column: (intent as unknown as Record<string, unknown>).field,
			} as unknown as Decision)
		: (intent as unknown as Decision);
	return dispatcher(bridged, handlerCtx, ctx.paramState);
}
