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
	RefExpressionIntent,
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
import { buildColumnRef } from './handlers/where/utils.js';
// DEFECT-2 FIX: import the modifier guard so the direct compileWhereIntent path
// (used by compileBatchUpdate and other mutation callers) enforces the same
// rawExists modifier restrictions as the decisions path (convertWhereCondition).
import {
	assertNoUnsupportedSubqueryModifiers,
	containsOuterRef,
} from './intent-to-decisions.js';
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
	// CHOKEPOINT GUARD: buildSubqueryFromIntent emits ONLY SELECT/FROM/WHERE —
	// it never emits LIMIT, ORDER BY, OFFSET, GROUP BY, HAVING, DISTINCT, DISTINCT ON,
	// JOINs, or relation hydration (include). Any caller passing an intent with those
	// modifiers would get silently-wrong SQL (broader or semantically-different matches).
	//
	// This guard fires regardless of which call path reaches this function:
	//   • rawExistsHandler.compile  (handlers/where/raw-exists.ts) — no prior guard
	//   • handleRawExistsIntent     (compile-where.ts)             — also guards there
	//   • handleSubqueryIntent      (compile-where.ts)             — also guards there
	//   • adapter-compiler-mutations compileSubquery callback       — no prior guard
	//
	// The call-site guards in handleRawExistsIntent/handleSubqueryIntent are retained
	// for defense-in-depth (earlier, more specific error messages). This chokepoint
	// guarantees any future caller without a call-site guard is still protected.
	assertNoUnsupportedSubqueryModifiers(intent, 'rawExists');
	// Correlated subqueries (outerRef inside the inner WHERE) are not supported:
	// buildSubqueryFromIntent builds a fresh inner WhereCompilerCtx with no outer alias,
	// so SubqueryRefIntent values fall back to being serialized as object $N parameters,
	// producing invalid SQL at best and a runtime panic at worst.
	if (intent.where && containsOuterRef(intent.where)) {
		throw new Error(
			'buildSubqueryFromIntent: correlated subqueries (outerRef inside the inner WHERE) are not yet supported. ' +
				'Workaround: use exists("relation", { where: ... }) when a schema relation exists, or wait for the rawExists correlation pipeline.',
		);
	}
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

	// Guard: reject scalar subqueries with modifiers that buildSubqueryFromIntent
	// silently drops.  The decisions path (convertSubquery in intent-to-decisions.ts)
	// uses 'scalar' which allows limit/orderBy because that path faithfully emits them.
	// This direct path uses buildSubqueryFromIntent which emits ONLY SELECT/FROM/WHERE
	// — limit, orderBy, groupBy, having, offset, distinct, joins, include are all
	// dropped. Use 'scalar-direct' to reject the full dropped set, including limit and
	// orderBy that 'scalar' allows.
	assertNoUnsupportedSubqueryModifiers(
		subquery as QueryIntent,
		'scalar-direct',
	);

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
	// DEFECT-2 FIX: enforce the same modifier guard as the decisions path
	// (convertWhereCondition in intent-to-decisions.ts).  Without this guard,
	// rawExists(subquery.limit(0)) on the direct compile-where path (used by
	// compileBatchUpdate) silently compiles as an unrestricted EXISTS — always
	// true — broadening the mutation guard contrary to the caller's intent.
	assertNoUnsupportedSubqueryModifiers(subIntent as QueryIntent, 'rawExists');
	// DEFECT-3 FIX: reject correlated subqueries (outerRef inside inner WHERE) on
	// the direct compile-where path, matching the decisions-path guard in
	// convertWhereCondition (intent-to-decisions.ts).  Without this guard,
	// rawExists(subquery(... outerRef(...))) on the direct path (used by
	// compileBatchUpdate) silently serialises the outerRef object as a $N
	// parameter (an object literal!) — producing wrong SQL or a runtime error.
	const subIntentTyped = subIntent as QueryIntent;
	if (subIntentTyped.where && containsOuterRef(subIntentTyped.where)) {
		const kindLabel =
			(intent as { kind?: string }).kind === 'rawNotExists'
				? 'rawNotExists'
				: 'rawExists';
		throw new Error(
			`${kindLabel}: correlated subqueries (outerRef inside the inner WHERE) are not yet supported. ` +
				'Workaround: use exists("relation", { where: ... }) when a schema relation exists, or wait for the rawExists correlation pipeline (tracked in TODO).',
		);
	}
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
 * Handle the 'comparison' kind when the right-hand value is an ExpressionRef
 * or a RefDefinition (schema `ref()`).
 *
 * Two distinct right-hand types arrive here:
 *  - ExpressionRef  (`__expr === true`)  — from `exprRef()` / expressions-layer ref
 *  - RefDefinition  (`__brand === 'ref'`) — from the public `ref()` exported by @dbsp/core
 *
 * Both represent a column reference (not a literal value). The generic comparison
 * handler would call buildParamRef and parameterise the object — wrong.
 *
 * ExpressionRef is a column reference: ExpressionRef → compileExpressionIntent.
 * RefDefinition carries `target` (e.g. 'filter.id') and must be compiled to
 * the column-ref path so it produces "filter"."id" in SQL.
 * Note: when a `RefDefinition` is used as a column reference here, any FK options
 * carried in `RefDefinition.options` are intentionally ignored — those only apply
 * at schema declaration time. Only `target` is consulted.
 *
 * buildColumnRef is used for the left side so that dotted field names like
 * 'users.id' are split correctly into table='users', column='id'.
 *
 * Returns null when value is neither type (caller falls through to dispatcher).
 */
function handleComparisonWithExprRef(
	intent: WhereIntent,
	ctx: WhereCompilerCtx,
	handlerCtx: CompilerContext,
): Node | null {
	const cmpIntent = intent as WhereComparisonIntent;
	const v = cmpIntent.value;

	if (v === null || typeof v !== 'object') return null;

	const rec = v as Record<string, unknown>;

	// ExpressionRef path: already has a compiled ExpressionIntent — delegate directly.
	// ExpressionRef implements the `ExpressionSpec` duck type: __expr === true.
	if (rec.__expr === true) {
		const exprRef = v as { intent: ExpressionIntent };
		// buildColumnRef handles dotted field names like 'table.col' by splitting them.
		const leftNode = buildColumnRef(cmpIntent.field, handlerCtx);
		const rightNode = compileExpressionIntent(
			exprRef.intent,
			handlerCtx,
			ctx.paramState,
		);
		const sqlOp = OP_MAP[cmpIntent.operator] ?? '=';
		return binaryExpr(sqlOp, leftNode, rightNode);
	}

	// RefDefinition path: the public ref() from @dbsp/core (schema DSL) returns
	// { __brand: 'ref', target: 'alias.col', options: {} }. When used in an ON
	// clause like eq('table.col', ref('alias.col')), `target` is a dotted column
	// reference (table.column or just column) — compile it via RefExpressionIntent
	// so it produces "alias"."col" instead of being parameterised as a literal.
	if (rec.__brand === 'ref' && typeof rec.target === 'string') {
		// buildColumnRef handles dotted field names like 'table.col' by splitting them.
		const leftNode = buildColumnRef(cmpIntent.field, handlerCtx);
		// Reuse the existing 'ref' kind handler via RefExpressionIntent.
		// compileExpressionIntent splits 'table.col' into qualifier + column correctly.
		const rightNode = compileExpressionIntent(
			{ kind: 'ref', column: rec.target } satisfies RefExpressionIntent,
			handlerCtx,
			ctx.paramState,
		);
		const sqlOp = OP_MAP[cmpIntent.operator] ?? '=';
		return binaryExpr(sqlOp, leftNode, rightNode);
	}

	return null;
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
