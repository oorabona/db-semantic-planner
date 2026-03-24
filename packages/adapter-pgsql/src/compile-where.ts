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
	WhereIntent,
} from '@dbsp/types';
import type { Node, SelectStmt, SubLink } from '@pgsql/types';
import { binaryExpr, columnRef, rangeVar } from './ast-helpers.js';
import { compileExpressionIntent } from './handlers/expression/custom.js';
import { createWhereDispatcher } from './handlers/index.js';
import type {
	CompilerContext,
	CompilerState,
	CompilerDecision,
} from './handlers/types.js';
import { createCompilerState } from './handlers/types.js';
import type { NamingPlugin } from './naming-plugin.js';
import { identityNaming } from './naming-plugin.js';
import { createParamRef } from './param-ref.js';

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
};

// ============================================================================
// Private: bridge WhereCompilerCtx → CompilerContext
// ============================================================================

function toHandlerContext(ctx: WhereCompilerCtx): CompilerContext {
	return {
		naming: ctx.naming,
		rootTable: ctx.rootTable,
		currentAlias: ctx.rootTable,
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
	if (select?.type === 'aggregate' && select.aggregates && select.aggregates.length > 0) {
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
		targetList = [{ ResTarget: { val: columnRef(select.fields[0], innerAlias, undefined, naming) } }];
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
export function compileWhereIntent(
	intent: WhereIntent,
	ctx: WhereCompilerCtx,
): Node {
	const dispatcher = createWhereDispatcher();
	const handlerCtx = toHandlerContext(ctx);

	// The `range` WhereIntent kind is not handled by normalizeToDecision (inside
	// createWhereDispatcher). We normalize it to a Decision here before dispatch.
	//
	// WhereRangeIntent.operator ∈ { 'overlaps', 'contains', 'containedBy', 'between' }
	// Value may be a RangeValue { lower, upper } or scalar (for contains/containedBy).
	if (intent.kind === 'range') {
		const { field, operator, value } = intent;

		// P2-5 fix: look up the column's PostgreSQL range type from the model so
		// the range handler can emit the correct CAST($N AS <type>) expression.
		// WhereRangeIntent has no dataType field — we must resolve it here from
		// the model (same logic as the allDecisions enrichment in compileSelect).
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
			// BETWEEN: value must be { lower, upper }
			const rv = value as { lower: unknown; upper: unknown };
			return dispatcher(
				{
					type: 'where',
					column: field,
					operator: 'between',
					value: [rv.lower, rv.upper],
				} as CompilerDecision,
				handlerCtx,
				ctx.paramState,
			);
		}

		// overlaps (&&), contains (@>), containedBy (<@)
		return dispatcher(
			{
				type: 'where',
				column: field,
				operator,
				value,
				...(rangeDataType !== undefined && { dataType: rangeDataType }),
			} as CompilerDecision,
			handlerCtx,
			ctx.paramState,
		);
	}

	// The `like` WhereIntent kind may carry an `escape` field.
	// normalizeToDecision for 'like' loses the escape field, so we handle it
	// directly here when escape is present to preserve LIKE $1 ESCAPE $2 semantics.
	if (
		intent.kind === 'like' &&
		(intent as { escape?: unknown }).escape !== undefined
	) {
		const likeIntent = intent as {
			field: string;
			pattern: unknown;
			caseInsensitive?: boolean;
			escape: unknown;
		};
		const operator = likeIntent.caseInsensitive ? 'ilike' : 'like';
		return dispatcher(
			{
				type: 'where',
				column: likeIntent.field,
				operator,
				value: likeIntent.pattern,
				escape: likeIntent.escape,
			} as CompilerDecision,
			handlerCtx,
			ctx.paramState,
		);
	}

	// The `expression` WhereIntent kind carries an ExpressionIntent on the left
	// side plus a comparison operator and scalar value on the right side.
	// normalizeToDecision falls through to `default` for this kind, which means
	// the dispatcher would use intent.operator (e.g. 'eq') and route to the
	// comparison handler — which expects a column name, not an expression node.
	// We handle it directly here to avoid that mis-dispatch.
	if (intent.kind === 'expression') {
		const leftNode = compileExpressionIntent(
			intent.expr,
			handlerCtx,
			ctx.paramState,
		);

		// Standalone boolean expression with no comparison value
		if (intent.value === undefined) {
			return leftNode;
		}

		const idx = ++ctx.paramState.paramIndex;
		ctx.paramState.parameters.push(intent.value);
		const rightNode = createParamRef(idx);

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
		const sqlOp = OP_MAP[intent.operator] ?? '=';
		return binaryExpr(sqlOp, leftNode, rightNode);
	}

	// The `subquery` WhereIntent kind represents: field OP (SELECT ... FROM ...)
	// normalizeToDecision falls through to `default`, then dispatcher uses
	// intent.operator (e.g. 'eq') which routes to the comparison handler — wrong.
	// We handle it directly using the compileSubquery callback.
	if (intent.kind === 'subquery') {
		const { field, operator, subquery } = intent;
		const { sql: subqueryNode, paramCount, parameters: innerParams } = ctx.compileSubquery(
			subquery,
			ctx.paramState.paramIndex,
		);
		// P2-3 fix: propagate inner subquery parameters to the outer state so
		// they are included in the final parameter array sent to PostgreSQL.
		// `parameters` is optional for backward-compat with pre-existing test stubs.
		if (innerParams) {
			for (const p of innerParams) {
				ctx.paramState.parameters.push(p);
			}
		}
		ctx.paramState.paramIndex += paramCount;

		const sourceAlias = ctx.rootTable;
		const leftOperand = columnRef(field, sourceAlias, undefined, ctx.naming);

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
		const sqlOp = OP_MAP[operator] ?? '=';

		// Build: left OP (subquery) using SubLink with EXPR_SUBLINK
		const subLink: SubLink = {
			subLinkType: 'EXPR_SUBLINK',
			subselect: subqueryNode,
		};
		return binaryExpr(sqlOp, leftOperand, { SubLink: subLink });
	}

	// The `relationFilter` WhereIntent kind is equivalent to EXISTS (mode:'some'),
	// NOT EXISTS (mode:'none'), or EXISTS with every-check (mode:'every').
	// normalizeToDecision falls through to `default`; the operator field is absent,
	// causing the dispatcher to use the fallback '=' handler — wrong.
	// We convert to exists/notExists and recurse.
	if (intent.kind === 'relationFilter') {
		const rf = intent as {
			relation: string | readonly string[];
			where: WhereIntent;
			mode: 'some' | 'every' | 'none';
		};
		// Use the first element if relation is an array (multi-hop not supported here)
		const relation = Array.isArray(rf.relation)
			? (rf.relation[0] as string)
			: (rf.relation as string);
		// Bug 4 fix: mode:'every' requires NOT EXISTS (... WHERE NOT condition)
		// i.e. "no rows fail the condition" = "all rows satisfy the condition".
		// mode:'some'  → EXISTS        (at least one matches)
		// mode:'none'  → NOT EXISTS    (none match)
		// mode:'every' → NOT EXISTS WHERE NOT condition  (all match)
		const existsKind = rf.mode === 'none' || rf.mode === 'every' ? 'notExists' : 'exists';
		const innerWhere: WhereIntent =
			rf.mode === 'every'
				? ({ kind: 'not', condition: rf.where } as WhereIntent)
				: rf.where;
		// Resolve the relation alias to its actual target table via ModelIR.
		// `relation` is a relation name (e.g. 'author'), not a table name (e.g. 'users').
		// The exists handler falls back to `decision.relation` when `targetTable` is absent,
		// which would generate EXISTS (SELECT 1 FROM "author" ...) — wrong.
		const resolvedRelation = ctx.model?.getRelation(`${ctx.rootTable}.${relation}`);
		const targetTable = resolvedRelation?.target ?? relation;
		return compileWhereIntent(
			{ kind: existsKind, relation, targetTable, where: innerWhere } as unknown as WhereIntent,
			ctx,
		);
	}

	// All other kinds: cast WhereIntent to Decision.
	// createWhereDispatcher calls normalizeToDecision internally, which handles:
	// comparison, like, in, any, null, and, or, not, exists, notExists,
	// jsonContains, jsonExists — plus pass-through for expression/subquery/etc.
	return dispatcher(intent as unknown as CompilerDecision, handlerCtx, ctx.paramState);
}
