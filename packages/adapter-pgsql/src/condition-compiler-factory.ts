import { EXPRESSION_BRAND, REF_BRAND } from '@dbsp/types';
/**
 * Unified WHERE compiler: compiles WhereIntent directly to PostgreSQL AST nodes.
 *
 * Root WHERE, FILTER and recursive anchors enter this compiler and bypass PlanDecision. Relation predicates
 * and predicate subqueries still lower through handler decisions during migration.
 * Each caller retains its own current SQL and parameter behavior.
 *
 * @internal
 */

import type {
	ColumnListInput,
	ExpressionIntent,
	QueryIntent,
	RefExpressionIntent,
	WhereAndIntent,
	WhereComparisonIntent,
	WhereExpressionIntent,
	WhereIntent,
	WhereLikeIntent,
	WhereNotIntent,
	WhereOrIntent,
	WhereRawExistsIntent,
	WhereRawNotExistsIntent,
	WhereRelationFilterIntent,
} from '@dbsp/types';
import { toColumnList } from '@dbsp/types';
import {
	getTrustedNqlRelationFilterFields,
	isFieldRef,
	resolveDeclaredRelationPath,
} from '@dbsp/types/internal';
import type { Node, SubLink } from '@pgsql/types';
import { DEFAULT_PK_COLUMN, defaultFkDerivation } from './assert-field.js';
import {
	andExpr,
	binaryExpr,
	booleanConstNode,
	distinctExpr,
	notExpr,
	orExpr,
} from './ast-helpers.js';
import { queryScope, relationBinding } from './binding-registry.js';
import type {
	ConditionCompilerCtx,
	WhereCompilerCtx,
} from './condition-context.js';
import { createSubqueryBuilder } from './condition-subquery.js';
import {
	type buildCustomFnFilter as FilterCompiler,
	mapToHandlerDecision,
} from './custom-fn-filter.js';
import { compileExpressionIntent } from './handlers/expression/custom.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereDispatcher,
} from './handlers/types.js';
import { compileLiteralNullComparison } from './handlers/where/literal-null.js';
import { resolveWhereOperator } from './handlers/where/operator-resolver.js';
import {
	buildColumnRef,
	compileValue,
	compileValueOrFieldRef,
	resolveWhereModelColumn,
} from './handlers/where/utils.js';
// Modifier guard and outerRef check used by buildSubqueryFromIntent (direct-path
// chokepoint for rawExists / scalar-direct predicate subqueries).
import {
	assertNoUnsupportedSubqueryModifiers,
	containsOuterRef,
	convertWhereCondition,
	isOuterRef,
} from './intent-to-decisions.js';
import { unwrapParamIntent } from './param-intent.js';
import { createParamRef } from './param-ref.js';
import { MAX_DEPTH_LIMIT } from './recursive/cte-compiler.js';
import { resolveRelationKeys } from './relation-keys.js';
import { queryLocal } from './sql-identifier.js';

/** Resolve logical names and the unique target aliases exposed by orm.tables. */
function resolveConditionRelation(
	model: NonNullable<WhereCompilerCtx['model']>,
	source: string,
	name: string,
) {
	const declared = resolveDeclaredRelationPath(model, source, [name]);
	if (declared.ok) return declared.relations[0];
	const targets = model
		.getRelationsFrom(source)
		.filter((rel) => rel.target === name);
	return targets.length === 1 ? targets[0] : undefined;
}

/** Validate every condition position before lowering can discard recursive options. */
function assertNoRecursiveAnchorRelations(intent: WhereIntent): void {
	const seen = new WeakSet<object>();
	function visit(value: unknown): void {
		if (!value || typeof value !== 'object' || seen.has(value)) return;
		seen.add(value);
		const node = value as WhereIntent;
		if (
			node.kind === 'exists' ||
			node.kind === 'notExists' ||
			node.kind === 'relationFilter'
		) {
			const trusted =
				node.kind === 'relationFilter'
					? getTrustedNqlRelationFilterFields(node)
					: undefined;
			if (
				('recursive' in node && node.recursive !== undefined) ||
				trusted?.recursive !== undefined
			) {
				const relation = trusted?.relation ?? node.relation;
				throw new Error(
					`start.where ${node.kind}('${Array.isArray(relation) ? relation.join('.') : relation}'): recursive relation predicates are not supported in a recursive anchor.`,
				);
			}
		}
		// Expression containers (including CASE), subqueries and logical groups
		// all retain their raw descendants here, before handler normalization.
		for (const [key, child] of Object.entries(value)) {
			// Bound values are data, even when they resemble condition intents.
			if (
				(key === 'value' && (value as { kind?: string }).kind !== 'namedArg') ||
				key === 'values' ||
				key === 'pattern'
			)
				continue;
			visit(child);
		}
	}
	visit(intent);
}

/** Refuse junction-less model relation predicates before either root lowering. */
export function assertNoManyToManyRootRelations(
	intent: WhereIntent,
	source: string,
	model: WhereCompilerCtx['model'],
	position = 'WHERE',
): void {
	if (!model) return;
	const visit = (node: WhereIntent, table: string): void => {
		if (node.kind === 'and' || node.kind === 'or') {
			for (const child of node.conditions) visit(child, table);
		} else if (node.kind === 'not') {
			visit(node.condition, table);
		} else if (
			node.kind === 'exists' ||
			node.kind === 'notExists' ||
			node.kind === 'relationFilter'
		) {
			const path =
				typeof node.relation === 'string'
					? node.relation.split('.')
					: node.relation;
			let target = table;
			for (const hop of path) {
				const relation = resolveConditionRelation(model, target, hop);
				if (!relation) return;
				if (relation.type === 'belongsToMany') {
					throw new Error(
						`${position} ${node.kind}('${path.join('.')}'): many-to-many traversal is not supported yet (#787).`,
					);
				}
				target = relation.target;
			}
			if (node.where) visit(node.where, target);
		}
	};
	visit(intent, source);
}

/** Refuse root relation recursion before routing or lowering can discard it. */
export function assertNoRecursiveRootRelations(
	intent: WhereIntent,
	position = 'WHERE',
): void {
	const seen = new WeakSet<object>();
	function visit(value: unknown, position: string): void {
		if (!value || typeof value !== 'object' || seen.has(value)) return;
		seen.add(value);
		const node = value as WhereIntent;
		if (
			node.kind === 'exists' ||
			node.kind === 'notExists' ||
			node.kind === 'relationFilter'
		) {
			const trusted =
				node.kind === 'relationFilter'
					? getTrustedNqlRelationFilterFields(node)
					: undefined;
			if (
				('recursive' in node && node.recursive !== undefined) ||
				trusted?.recursive !== undefined
			) {
				const relation = trusted?.relation ?? node.relation;
				throw new Error(
					`${position} ${node.kind}('${Array.isArray(relation) ? relation.join('.') : relation}'): recursive relation predicates are not supported inside ${position}.`,
				);
			}
		}
		for (const [key, child] of Object.entries(value)) {
			if (
				(key === 'value' && (value as { kind?: string }).kind !== 'namedArg') ||
				key === 'values' ||
				key === 'pattern' ||
				key === 'subquery' ||
				key === 'query'
			)
				continue;
			visit(child, key === 'filter' ? 'FILTER' : position);
		}
	}
	visit(intent, position);
}

/** Private recursion state, created by the top-level entry and shared by descendants. */
type InternalConditionCtx = WhereCompilerCtx & {
	readonly compileCondition: (
		intent: WhereIntent,
		ctx: WhereCompilerCtx,
	) => Node;
};
export function createConditionCompiler(
	createWhereDispatcher: (
		compiler: import('./condition-subquery.js').SubqueryConditionCompiler,
	) => WhereDispatcher,
	buildCustomFnFilter: typeof FilterCompiler,
) {
	// ============================================================================
	// Module-level constants
	// ============================================================================

	/** Operator name → SQL operator string. Shared by expression and subquery WHERE handlers. */
	const OP_MAP: Record<string, string> = {
		eq: '=',
		neq: '!=',
		isDistinctFrom: '=',
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

	// Private channel for relation-filter lowering; raw intent fields are not authority.
	const relationHints = new WeakMap<WhereIntent, Partial<Decision>>();
	function internalRelationIntent(intent: WhereIntent): WhereIntent {
		relationHints.set(intent, intent as unknown as Partial<Decision>);
		return intent;
	}

	function compileMappedComparison(
		operator: string | undefined,
	): (left: Node, right: Node) => Node {
		const sqlOp = resolveWhereOperator(operator, OP_MAP);
		return operator === 'isDistinctFrom'
			? distinctExpr
			: (left, right) => binaryExpr(sqlOp, left, right);
	}

	// ============================================================================
	// Private: bridge WhereCompilerCtx → CompilerContext
	// ============================================================================

	function toHandlerContext(
		ctx: InternalConditionCtx,
		dispatcher: WhereDispatcher,
	): CompilerContext {
		return {
			...(ctx.directRootWhere && {
				compileCaseCondition: (
					intent: WhereIntent,
					child: CompilerContext,
					state: CompilerState,
				) =>
					compileCondition(intent, {
						...ctx,
						logicalSourceTable: child.rootTable,
						emittedAlias: child.currentAlias ?? child.rootTable,
						visibleAliases: new Map(child.aliases),
						position: 'case-when',
						paramState: state,
					}),
			}),
			compileSubqueryCondition: (intent, child, state) => {
				return compileCondition(intent, {
					...ctx,
					logicalSourceTable: child.rootTable,
					emittedAlias: child.currentAlias ?? child.rootTable,
					visibleAliases: new Map(),
					position: 'subquery',
					queryRanges: child.currentBinding ? [child.currentBinding] : [],
					enclosingRanges: [
						ctx.queryRanges ?? Array.from(ctx.scope?.bindings.values() ?? []),
						...(ctx.enclosingRanges ?? []),
					],
					outerTable: ctx.currentAlias ?? ctx.rootTable,
					...(child.currentBinding !== undefined && {
						currentBinding: child.currentBinding,
					}),
					...(child.scope !== undefined && { scope: child.scope }),
					paramState: state,
				});
			},
			rootTable: ctx.rootTable,
			enclosingRanges: ctx.enclosingRanges,
			queryRanges: ctx.queryRanges,
			position: ctx.position,
			...(ctx.directRootWhere !== undefined && {
				directRootWhere: ctx.directRootWhere,
			}),
			currentAlias: ctx.currentAlias ?? ctx.rootTable,
			maxRecursiveDepth: MAX_DEPTH_LIMIT,
			defaultPkColumnName: ctx.defaultPkColumnName,
			deriveFkColumnName: ctx.deriveFkColumnName,
			compileSubquery: ctx.compileExpressionSubquery,
			...(ctx.schemaName !== undefined && { schema: ctx.schemaName }),
			...(ctx.dialectCapabilities !== undefined && {
				dialectCapabilities: ctx.dialectCapabilities,
			}),
			...(ctx.scope !== undefined && { scope: ctx.scope }),
			...(ctx.currentBinding !== undefined && {
				currentBinding: ctx.currentBinding,
			}),
			...(ctx.declaredNames !== undefined && {
				declaredNames: ctx.declaredNames,
			}),
			dbCasing: ctx.dbCasing,
			...(ctx.relationTargetProjections !== undefined && {
				relationTargetProjections: ctx.relationTargetProjections,
			}),
			...(ctx.aliasColumnAuthorities !== undefined && {
				aliasColumnAuthorities: ctx.aliasColumnAuthorities,
			}),
			...(ctx.model !== undefined && { model: ctx.model }),
			...(ctx.outerTable !== undefined && { outerAlias: ctx.outerTable }),
			compileCustomFnFilter: (intent, handlerCtx, state) =>
				buildCustomFnFilter(
					intent,
					{ ...handlerCtx, aliases: ctx.aliases },
					state,
					compileCondition,
				),
			createWhereDispatcher: () => dispatcher,
		} as CompilerContext;
	}

	// ============================================================================
	// Public: compileWhereIntent
	// ============================================================================

	/**
	 * Compile a WhereIntent directly to a PostgreSQL AST Node.
	 *
	 * Handles all 18 WhereIntent kinds:
	 * - comparison, like, in, any, null, range
	 * - and, or, not
	 * - exists, notExists, relationFilter
	 * - subquery, jsonContains, jsonExists, expression, rawExists, rawNotExists
	 *
	 * Uses the existing handler dispatch system under the hood:
	 *   WhereIntent → normalizeToDecision (inside createWhereDispatcher) → handler → Node
	 *
	 * This avoids duplicating 18 handler implementations while providing a
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
		ctx: InternalConditionCtx,
		dispatcher: WhereDispatcher,
		handlerCtx: CompilerContext,
	): Node {
		const { field, operator, value } = intent as {
			field: string;
			operator: string;
			value: unknown;
		};

		let rangeDataType: string | undefined;
		if (ctx.model && operator !== 'between') {
			const col =
				ctx.position === 'recursive-anchor'
					? resolveWhereModelColumn(field, handlerCtx)
					: ctx.model
							.getTable(ctx.rootTable)
							?.columns.find((column) => column.name === field);
			if (col?.type.endsWith('range')) rangeDataType = col.type;
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
		ctx: InternalConditionCtx,
		dispatcher: WhereDispatcher,
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
		ctx: InternalConditionCtx,
		handlerCtx: CompilerContext,
	): Node {
		const exprIntent = intent as WhereExpressionIntent;
		if (!Object.hasOwn(exprIntent, 'operator')) {
			return compileExpressionIntent(
				exprIntent.expr,
				handlerCtx,
				ctx.paramState,
			);
		}

		const compileComparison = compileMappedComparison(exprIntent.operator);

		const leftNode = compileExpressionIntent(
			exprIntent.expr,
			handlerCtx,
			ctx.paramState,
		);

		const nullComparison = compileLiteralNullComparison(
			exprIntent.operator,
			leftNode,
			exprIntent.value,
		);
		if (nullComparison) return nullComparison;

		const idx = ++ctx.paramState.paramIndex;
		ctx.paramState.parameters.push(unwrapParamIntent(exprIntent.value));
		const rightNode = createParamRef(idx);
		return compileComparison(leftNode, rightNode);
	}

	/**
	 * Handle the 'subquery' kind: field OP (SELECT ... FROM ...).
	 * The generic dispatcher would fall through to the comparison handler — wrong.
	 */
	function handleSubqueryIntent(
		intent: WhereIntent,
		ctx: InternalConditionCtx,
		_handlerCtx: CompilerContext,
	): Node {
		const { field, operator, subquery } = intent as {
			field: string;
			operator: string;
			subquery: Parameters<WhereCompilerCtx['compileSubquery']>[0];
		};
		const compileComparison = compileMappedComparison(operator);

		// Guard: reject scalar subqueries with modifiers that the direct path does not
		// faithfully emit (LIMIT, ORDER BY, GROUP BY, etc.). This runs BEFORE the
		// ctx.compileSubquery callback so the modifier error fires first, regardless
		// of which callback is injected (e.g. the JOIN ON override that throws a
		// different error).
		assertNoUnsupportedSubqueryModifiers(
			subquery as QueryIntent,
			'scalar-direct',
		);

		// Route through ctx.compileSubquery so caller-injected overrides are honoured.
		// Specifically, JOIN ON compilation injects a throw-callback so a scalar subquery
		// in a JOIN ON condition is correctly rejected (not silently compiled).
		// This was the original design intent (point 6 of the spec).
		const {
			sql: subqueryNode,
			paramCount,
			parameters: innerParams,
		} = ctx.compileSubquery(subquery, ctx.paramState.paramIndex, ctx);

		if (innerParams) {
			for (const p of innerParams) {
				ctx.paramState.parameters.push(p);
			}
		}
		ctx.paramState.paramIndex += paramCount;

		const leftOperand = buildColumnRef(field, _handlerCtx);

		const subLink: SubLink = {
			subLinkType: 'EXPR_SUBLINK',
			subselect: subqueryNode,
		};
		return compileComparison(leftOperand, { SubLink: subLink });
	}

	/**
	 * Handle the 'relationFilter' kind by converting to exists/notExists and recursing.
	 * The generic dispatcher would fall through to '=' handler — wrong.
	 */
	function handleRelationFilterIntent(
		intent: WhereIntent,
		ctx: InternalConditionCtx,
	): Node {
		const rf = intent as WhereRelationFilterIntent;
		const preResolved = getTrustedNqlRelationFilterFields(rf);
		if (
			ctx.position === 'where' &&
			ctx.directRootWhere &&
			(('recursive' in rf && rf.recursive !== undefined) ||
				preResolved?.recursive !== undefined)
		)
			throw new Error(
				`WHERE relationFilter('${rf.relation}'): recursive relation predicates are not supported inside WHERE.`,
			);
		const relationPath = preResolved?.relation ?? rf.relation;

		const hops: string[] = Array.isArray(relationPath)
			? [...relationPath]
			: [relationPath];

		// mode:'some'  → EXISTS         (at least one matches)
		// mode:'none'  → NOT EXISTS     (none match)
		// mode:'every' → NOT EXISTS WHERE NOT condition (all match)
		const existsKind =
			rf.mode === 'none' || rf.mode === 'every' ? 'notExists' : 'exists';

		// DEFECT 2 FIX: mode:'every' with no/undefined where OR an empty logical
		// group (and() with zero conditions) is vacuously true.
		// every(TRUE) over any path is trivially satisfied for all rows.
		// NOT EXISTS(path WHERE NOT TRUE) = NOT EXISTS(path WHERE FALSE) = TRUE.
		// Building `{ kind: 'not', condition: undefined }` and recursing would crash
		// on the undefined path; the empty-and path produces the right answer but
		// emits an unnecessary NOT EXISTS subquery — short-circuit here instead.
		const rfWhere = rf.where as unknown as Record<string, unknown> | undefined;
		const isVacuousEvery =
			rf.mode === 'every' &&
			(!rfWhere ||
				(typeof rfWhere === 'object' &&
					rfWhere.kind === 'and' &&
					Array.isArray(rfWhere.conditions) &&
					(rfWhere.conditions as unknown[]).length === 0));
		if (isVacuousEvery) {
			if (preResolved) {
				return { A_Const: { boolval: { boolval: true } } };
			}
			// Validate the relation/path BEFORE returning vacuous-true.
			// Without this, a typoed/undeclared relation short-circuits to all-rows TRUE
			// (fail-open security regression) instead of throwing fail-closed.
			// The invariant: vacuous TRUE is only correct when the relation is VALID.
			if (hops.length <= 1) {
				const relation = hops[0] ?? (rf.relation as string);
				// DEFECT 3 FIX: a vacuous every with NO model must fail closed — the adapter
				// cannot validate the relation at all, so returning TRUE would match ALL rows
				// regardless of whether the relation exists.  Throw to protect mutation guards.
				if (!ctx.model) {
					throw new Error(
						`every relation filter requires a model to validate the relation '${relation}'. ` +
							'Provide a model via WhereCompilerCtx or use the decisions path.',
					);
				}
				const resolved = resolveConditionRelation(
					ctx.model,
					ctx.rootTable,
					relation,
				);
				if (!resolved) {
					throw new Error(
						`relationFilter('${relation}'): no relation '${relation}' declared on table '${ctx.rootTable}'. ` +
							'Use rawExists(subquery(...)) for an uncorrelated or undeclared subquery.',
					);
				}
			} else {
				// Multi-hop: validate ALL hops upfront (same guard as the non-vacuous path).
				if (!ctx.model) {
					throw new Error(
						`relationFilter(${JSON.stringify(hops)}): multi-hop relation paths require a model on the direct compile path. ` +
							'Provide a model via WhereCompilerCtx or use the decisions path.',
					);
				}
				let currentSource = ctx.rootTable;
				for (const hop of hops) {
					const rel = resolveConditionRelation(ctx.model, currentSource, hop);
					if (!rel) {
						throw new Error(
							`relationFilter(${JSON.stringify(hops)}): no relation '${hop}' declared on table '${currentSource}'. ` +
								'Use rawExists(subquery(...)) for an uncorrelated or undeclared subquery.',
						);
					}
					currentSource = rel.target;
				}
			}
			// DEFECT 2 FIX: return the identical TRUE literal that everyHandler (handlers/where/exists.ts)
			// emits for its empty-conditions vacuous-true branch — { A_Const: { boolval: { boolval: true } } }.
			// The previous TypeCast node had a mis-nested typeName (TypeName wrapped inside { TypeName: ... })
			// which caused deparseTypeName() to emit "CAST(1 AS )" — invalid SQL.
			return { A_Const: { boolval: { boolval: true } } };
		}

		const innermostWhere: WhereIntent | undefined =
			rf.mode === 'every'
				? ({ kind: 'not', condition: rf.where } as WhereIntent)
				: rf.where;

		if (hops.length <= 1) {
			// Single-hop: resolve FK metadata from the model so the EXISTS handler
			// uses the declared FK columns instead of the convention fallback.
			// (DEFECT 1 FIX: before this fix, single-hop always fell back to convention,
			//  so e.g. posts.author_id was correlated as posts.user_id — wrong.)
			const relation = hops[0] ?? (rf.relation as string);
			if (
				ctx.directRootWhere &&
				rf.mode === 'some' &&
				innermostWhere &&
				ctx.rootWhereJoinRelations?.has(`${ctx.rootTable}.${relation}`)
			) {
				const target =
					preResolved?.targetTable ??
					(ctx.model
						? resolveConditionRelation(ctx.model, ctx.rootTable, relation)
								?.target
						: undefined);
				const alias = ctx.aliases?.get(relation);
				if (target && alias)
					return ctx.compileCondition(innermostWhere, {
						...ctx,
						rootTable: target,
						currentAlias: alias,
						outerTable: ctx.currentAlias ?? ctx.rootTable,
					});
			}
			if (preResolved) {
				return ctx.compileCondition(
					internalRelationIntent({
						kind: existsKind,
						relation,
						targetTable: preResolved.targetTable,
						sourceColumn: preResolved.sourceColumn,
						targetColumn: preResolved.targetColumn,
						where: innermostWhere,
					} as unknown as WhereIntent),
					ctx,
				);
			}
			const resolvedRelation = ctx.model
				? resolveConditionRelation(ctx.model, ctx.rootTable, relation)
				: undefined;

			// DEFECT 1 FIX (new): when a model IS present but the relation is NOT declared,
			// fail closed — consistent with the multi-hop path and the vacuous-every path.
			// Without this guard, a typoed relation name compiled against the convention-derived
			// FK columns of an unintended table instead of throwing.
			// KEEP the no-model path unchanged: no model → cannot validate → convention fallback.
			if (ctx.model && !resolvedRelation) {
				throw new Error(
					`relationFilter('${relation}'): no relation '${relation}' declared on table '${ctx.rootTable}'. ` +
						'Use rawExists(subquery(...)) for an uncorrelated or undeclared subquery.',
				);
			}

			const targetTable = resolvedRelation?.target ?? relation;

			// Thread FK metadata when the model is available and the relation is declared.
			// When the model is absent we keep the current convention-fallback path
			// (no model = no FK resolution possible, the exists handler will fall back too).
			let singleHopSourceColumn: ColumnListInput;
			let singleHopTargetColumn: ColumnListInput;
			if (resolvedRelation) {
				if (
					((ctx.position === 'where' || ctx.position === 'subquery') &&
						ctx.directRootWhere) ||
					ctx.position === 'filter' ||
					ctx.position === 'having' ||
					ctx.position === 'case-when' ||
					ctx.position === 'recursive-anchor'
				) {
					const keys = resolveRelationKeys(
						ctx.rootTable,
						resolvedRelation,
						ctx,
					);
					singleHopSourceColumn = keys.sourceColumn;
					singleHopTargetColumn = keys.targetColumn;
				} else {
					// Preserve historical non-FILTER direct lowering until its migration.
					const rel = resolvedRelation;
					const fk = toColumnList(rel.foreignKey);
					const defaultPk = DEFAULT_PK_COLUMN;
					if (rel.type === 'belongsTo') {
						// FK is on the source side: sourceTable.fkCol → targetTable.pk
						singleHopSourceColumn =
							fk.length > 0 ? fk : [defaultFkDerivation(rel.target, defaultPk)];
						const targetKey = toColumnList(rel.targetKey);
						singleHopTargetColumn =
							targetKey.length > 0 ? targetKey : [defaultPk];
					} else {
						// hasMany / hasOne: FK is on the target side: targetTable.fkCol → sourceTable.pk
						const sourceKey = toColumnList(rel.sourceKey);
						singleHopSourceColumn =
							sourceKey.length > 0 ? sourceKey : [defaultPk];
						singleHopTargetColumn =
							fk.length > 0
								? fk
								: [defaultFkDerivation(ctx.rootTable, defaultPk)];
					}
				}
			}

			return ctx.compileCondition(
				internalRelationIntent({
					kind: existsKind,
					relation,
					targetTable,
					...(singleHopSourceColumn !== undefined && {
						sourceColumn: singleHopSourceColumn,
					}),
					...(singleHopTargetColumn !== undefined && {
						targetColumn: singleHopTargetColumn,
					}),
					where: innermostWhere,
				} as unknown as WhereIntent),
				ctx,
			);
		}

		// Multi-hop: build a nested EXISTS chain from outermost to innermost.
		// Each hop must be declared in the model; fail-closed on undeclared hops.
		if (!ctx.model) {
			throw new Error(
				`relationFilter(${JSON.stringify(hops)}): multi-hop relation paths require a model on the direct compile path. ` +
					'Provide a model via WhereCompilerCtx or use the decisions path.',
			);
		}
		const model = ctx.model;

		// Validate all hops upfront and collect resolved targets + FK metadata.
		let currentSource = ctx.rootTable;
		const hopTargets: string[] = [];
		// Per-hop FK columns so the EXISTS handler uses model-declared FKs instead
		// of convention fallback (fixes the DEFECT-2 wrong-correlation bug).
		const hopSourceColumns: ColumnListInput[] = [];
		const hopTargetColumns: ColumnListInput[] = [];
		for (const hop of hops) {
			const rel = resolveConditionRelation(model, currentSource, hop);
			if (!rel) {
				throw new Error(
					`relationFilter(${JSON.stringify(hops)}): no relation '${hop}' declared on table '${currentSource}'. ` +
						'Use rawExists(subquery(...)) for an uncorrelated or undeclared subquery.',
				);
			}
			hopTargets.push(rel.target);
			// Resolve explicit FK columns using the same direction logic as deriveFkColumns.
			// For belongsTo: FK is on the source side (sourceTable.fkCol → targetTable.pk)
			// For hasMany/hasOne: FK is on the target side (targetTable.fkCol → sourceTable.pk)
			if (
				((ctx.position === 'where' || ctx.position === 'subquery') &&
					ctx.directRootWhere) ||
				ctx.position === 'filter' ||
				ctx.position === 'having' ||
				ctx.position === 'case-when' ||
				ctx.position === 'recursive-anchor'
			) {
				const keys = resolveRelationKeys(currentSource, rel, ctx);
				hopSourceColumns.push(keys.sourceColumn);
				hopTargetColumns.push(keys.targetColumn);
			} else {
				const fk = toColumnList(rel.foreignKey);
				const defaultPk = DEFAULT_PK_COLUMN;
				if (rel.type === 'belongsTo') {
					hopSourceColumns.push(
						fk.length > 0 ? fk : [defaultFkDerivation(rel.target, defaultPk)],
					);
					const targetKey = toColumnList(rel.targetKey);
					hopTargetColumns.push(targetKey.length > 0 ? targetKey : [defaultPk]);
				} else {
					// hasMany / hasOne: FK lives on the target table
					const sourceKey = toColumnList(rel.sourceKey);
					hopSourceColumns.push(sourceKey.length > 0 ? sourceKey : [defaultPk]);
					hopTargetColumns.push(
						fk.length > 0
							? fk
							: [defaultFkDerivation(currentSource, defaultPk)],
					);
				}
			}
			currentSource = rel.target;
		}

		// Build the nested WhereIntent chain from innermost to outermost.
		// innermost hop: carries the user's where clause.
		// Each outer hop wraps the previous as its where clause.
		// Per-hop FK columns are threaded in so the EXISTS handler emits the correct
		// correlation predicate (e.g. users.id = posts.author_id, not posts.user_id).
		let innerIntent: WhereIntent | undefined = innermostWhere;
		for (let i = hops.length - 1; i >= 0; i--) {
			const hop = hops[i] ?? '';
			const targetTable = hopTargets[i] ?? hop;
			// All inner hops use 'exists'; outermost uses existsKind.
			const hopKind = i === 0 ? existsKind : 'exists';
			innerIntent = internalRelationIntent({
				kind: hopKind,
				relation: hop,
				targetTable,
				sourceColumn: hopSourceColumns[i],
				targetColumn: hopTargetColumns[i],
				where: innerIntent,
			} as unknown as WhereIntent);
		}

		// Compile the outermost intent in the chain.
		return ctx.compileCondition(innerIntent as WhereIntent, ctx);
	}

	/**
	 * Handle the 'rawExists' and 'rawNotExists' kinds: EXISTS / NOT EXISTS wrappers
	 * around a QueryIntent subquery. No Decision equivalent — compiled directly via
	 * compileSubquery callback then wrapped in a SubLink node.
	 */
	function handleRawExistsIntent(
		intent: WhereIntent,
		ctx: InternalConditionCtx,
	): Node {
		const subIntent = (intent as WhereRawExistsIntent | WhereRawNotExistsIntent)
			.subquery;
		// Guard fires here before ctx.compileSubquery so that the modifier check
		// fires on the direct compileWhereIntent path (used by compileBatchUpdate)
		// regardless of which compileSubquery callback is injected.
		// This is defense-in-depth: buildSubqueryFromIntent also validates when used
		// as the compileSubquery callback, but tests that inject a sentinel callback
		// need the guard to fire here first.
		assertNoUnsupportedSubqueryModifiers(subIntent as QueryIntent, 'rawExists');
		if (
			!ctx.directRootWhere &&
			(subIntent as QueryIntent).where &&
			containsOuterRef((subIntent as QueryIntent).where!)
		) {
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
		} = ctx.compileSubquery(subIntent, ctx.paramState.paramIndex, ctx);

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
		ctx: InternalConditionCtx,
	): Node | null {
		if (intent.kind === 'and') {
			const conditions = (intent as WhereAndIntent).conditions;
			const nodes = conditions.map((c) => ctx.compileCondition(c, ctx));
			if (nodes.length === 0) {
				return booleanConstNode(true);
			}
			if (nodes.length === 1) return nodes[0]!;
			return andExpr(...nodes);
		}
		if (intent.kind === 'or') {
			const conditions = (intent as WhereOrIntent).conditions;
			const nodes = conditions.map((c) => ctx.compileCondition(c, ctx));
			if (nodes.length === 0) {
				return booleanConstNode(false);
			}
			if (nodes.length === 1) return nodes[0]!;
			return orExpr(...nodes);
		}
		if (intent.kind === 'not') {
			return notExpr(
				ctx.compileCondition((intent as WhereNotIntent).condition, ctx),
			);
		}
		return null;
	}

	/**
	 * Handle the 'comparison' kind when the right-hand value is an ExpressionRef
	 * or a RefDefinition (schema `ref()`).
	 *
	 * Two distinct right-hand types arrive here:
	 *  - ExpressionRef  (expression symbol brand)  — from `exprRef()` / expressions-layer ref
	 *  - RefDefinition  (reference symbol brand) — from the public `ref()` exported by @dbsp/core
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
		ctx: InternalConditionCtx,
		handlerCtx: CompilerContext,
	): Node | null {
		const cmpIntent = intent as WhereComparisonIntent;
		// JSON extraction belongs to the JSON handler, including param expressions.
		if (ctx.directRootWhere && cmpIntent.jsonPath !== undefined) return null;
		const v = cmpIntent.value;

		if (v === null || typeof v !== 'object') return null;

		const rec = v as Record<string, unknown>;
		if (isOuterRef(v)) {
			return compileMappedComparison(cmpIntent.operator)(
				buildColumnRef(cmpIntent.field, handlerCtx),
				compileValueOrFieldRef(
					{ kind: 'fieldRef', scope: 'outer', column: rec.column },
					handlerCtx,
					ctx.paramState,
				),
			);
		}

		// ExpressionRef path: already has a compiled ExpressionIntent — delegate directly.
		// ExpressionRef implements the `ExpressionSpec` shared expression symbol brand.
		if (EXPRESSION_BRAND in v && v[EXPRESSION_BRAND] === true) {
			const compileComparison = compileMappedComparison(cmpIntent.operator);
			const exprRef = v as unknown as { intent: ExpressionIntent };
			// buildColumnRef handles dotted field names like 'table.col' by splitting them.
			const leftNode = buildColumnRef(cmpIntent.field, handlerCtx);
			const rightNode = compileExpressionIntent(
				exprRef.intent,
				handlerCtx,
				ctx.paramState,
			);
			return compileComparison(leftNode, rightNode);
		}

		// RefDefinition path: the public ref() from @dbsp/core (schema DSL) returns
		// a symbol-branded reference with target 'alias.col'. When used in an ON
		// clause like eq('table.col', ref('alias.col')), `target` is a dotted column
		// reference (table.column or just column) — compile it via RefExpressionIntent
		// so it produces "alias"."col" instead of being parameterised as a literal.
		if (
			REF_BRAND in v &&
			v[REF_BRAND] === 'ref' &&
			typeof rec.target === 'string'
		) {
			const compileComparison = compileMappedComparison(cmpIntent.operator);
			// buildColumnRef handles dotted field names like 'table.col' by splitting them.
			const leftNode = buildColumnRef(cmpIntent.field, handlerCtx);
			// Reuse the existing 'ref' kind handler via RefExpressionIntent.
			// compileExpressionIntent splits 'table.col' into qualifier + column correctly.
			const rightNode = compileExpressionIntent(
				{ kind: 'ref', column: rec.target } satisfies RefExpressionIntent,
				handlerCtx,
				ctx.paramState,
			);
			return compileComparison(leftNode, rightNode);
		}

		return null;
	}

	function compileConditionWithLegacyContext(
		intent: WhereIntent,
		ctx: InternalConditionCtx,
		dispatcher: WhereDispatcher,
		handlerCtx: CompilerContext,
	): Node {
		if (
			(((ctx.position === 'where' || ctx.position === 'subquery') &&
				ctx.directRootWhere) ||
				ctx.position === 'recursive-anchor') &&
			![
				'comparison',
				'like',
				'in',
				'any',
				'null',
				'range',
				'and',
				'or',
				'not',
				'exists',
				'notExists',
				'rawExists',
				'rawNotExists',
				'relationFilter',
				'subquery',
				'jsonContains',
				'jsonExists',
				'expression',
			].includes(intent.kind)
		) {
			throw new Error(
				`Unsupported ${(ctx.position === 'where' || ctx.position === 'subquery') && ctx.directRootWhere ? 'root WHERE' : 'recursive start.where'} predicate kind '${String(intent.kind)}'.`,
			);
		}
		if (
			(((ctx.position === 'where' || ctx.position === 'subquery') &&
				ctx.directRootWhere) ||
				ctx.position === 'filter' ||
				ctx.position === 'having' ||
				ctx.position === 'case-when' ||
				ctx.position === 'recursive-anchor') &&
			(intent.kind === 'exists' || intent.kind === 'notExists')
		) {
			if (
				(ctx.position === 'filter' ||
					ctx.position === 'having' ||
					ctx.position === 'case-when' ||
					((ctx.position === 'where' || ctx.position === 'subquery') &&
						ctx.directRootWhere)) &&
				intent.recursive !== undefined
			)
				throw new Error(
					`${(ctx.position === 'where' || ctx.position === 'subquery') && ctx.directRootWhere ? 'WHERE' : 'FILTER'} ${intent.kind}('${intent.relation}'): recursive relation predicates are not supported inside ${(ctx.position === 'where' || ctx.position === 'subquery') && ctx.directRootWhere ? 'WHERE' : 'FILTER'}.`,
				);
			// Internal hints come from validated relation paths or frozen NQL proofs.
			// Projected NQL bindings need not exist in the physical model.
			const hints = relationHints.get(intent);
			if (ctx.directRootWhere && !ctx.model && !hints)
				throw new Error(
					`${intent.kind}('${intent.relation}'): cannot resolve relation '${intent.relation}' — no model configured. Use rawExists(subquery(...)) for an uncorrelated or undeclared subquery.`,
				);
			const resolved = ctx.model
				? resolveConditionRelation(ctx.model, ctx.rootTable, intent.relation)
				: undefined;
			if (ctx.model && !resolved && !(ctx.directRootWhere && hints))
				throw new Error(
					`${intent.kind}('${intent.relation}'): no relation '${intent.relation}' is declared on table '${ctx.rootTable}'. Use rawExists(subquery(...)) for an EXISTS over an undeclared or uncorrelated subquery.`,
				);
			// Resolve raw intents here. Planner decisions never enter this branch.
			const keys =
				hints?.sourceColumn !== undefined && hints.targetColumn !== undefined
					? {
							sourceColumn: hints.sourceColumn,
							targetColumn: hints.targetColumn,
						}
					: resolveRelationKeys(
							ctx.rootTable,
							resolved ?? { type: 'hasMany', target: intent.relation },
							ctx,
						);
			const targetTable = resolved?.target ?? intent.relation;
			const supplied = intent as unknown as Partial<Decision>;
			if (
				!hints &&
				((supplied.targetTable !== undefined &&
					supplied.targetTable !== targetTable) ||
					(supplied.sourceColumn !== undefined &&
						JSON.stringify(toColumnList(supplied.sourceColumn)) !==
							JSON.stringify(keys.sourceColumn)) ||
					(supplied.targetColumn !== undefined &&
						JSON.stringify(toColumnList(supplied.targetColumn)) !==
							JSON.stringify(keys.targetColumn)))
			)
				throw new Error(
					`${intent.kind}('${intent.relation}'): supplied relation target or keys differ from the model.`,
				);
			const joinRelation = resolved?.name ?? intent.relation;
			const joinedAlias = ctx.aliases?.get(joinRelation);
			if (
				ctx.directRootWhere &&
				intent.kind === 'exists' &&
				(!intent.include || Object.keys(intent.include).length === 0) &&
				joinedAlias &&
				ctx.rootWhereJoinRelations?.has(`${ctx.rootTable}.${joinRelation}`)
			) {
				return intent.where
					? ctx.compileCondition(intent.where, {
							...ctx,
							rootTable: hints?.targetTable ?? targetTable,
							currentAlias: joinedAlias,
							outerTable: ctx.currentAlias ?? ctx.rootTable,
						})
					: booleanConstNode(true);
			}
			return dispatcher(
				{
					type: 'exists',
					operator: intent.kind,
					relation: intent.relation,
					targetTable: hints?.targetTable ?? targetTable,
					sourceColumn: keys.sourceColumn,
					targetColumn: keys.targetColumn,
					conditions: intent.where ? [intent.where as unknown as Decision] : [],
					include: intent.include
						? Object.entries(intent.include).map(([relation, options]) => ({
								type: 'existsInclude',
								relation,
								joinType: options.join ?? 'inner',
							}))
						: undefined,
				} as Decision,
				handlerCtx,
				ctx.paramState,
			);
		}
		if (
			(((ctx.position === 'where' || ctx.position === 'subquery') &&
				ctx.directRootWhere) ||
				ctx.position === 'filter' ||
				ctx.position === 'having' ||
				ctx.position === 'case-when' ||
				ctx.position === 'recursive-anchor') &&
			(intent.kind === 'subquery' || (intent.kind === 'in' && intent.subquery))
		) {
			// Lower only the projection and comparison. The original body is compiled
			// once below, with its own scope and the shared parameter state.
			const query = intent.subquery;
			if (!query)
				throw new Error(
					'fn().filter(): the FILTER (WHERE ...) condition could not be compiled (kind: subquery).',
				);
			const { where: body, ...projection } = query;
			const decision = convertWhereCondition(
				{ ...intent, subquery: projection },
				ctx.rootTable,
			);

			if (!decision)
				throw new Error(
					'fn().filter(): the FILTER (WHERE ...) condition could not be compiled (kind: subquery).',
				);
			return dispatcher(
				mapToHandlerDecision(
					{ ...decision, subqueryIntent: body ? query : projection },
					ctx.rootTable,
					ctx.defaultPkColumnName ?? DEFAULT_PK_COLUMN,
					ctx.deriveFkColumnName ?? defaultFkDerivation,
				),
				handlerCtx,
				ctx.paramState,
			);
		}
		// Include predicates share a SELECT with the root. Preserve the existing
		// condition lowering's parameter and subquery spelling while binding its
		// field references through the resolved current and enclosing ranges.
		if (
			ctx.position === 'include-where' &&
			intent.kind !== 'and' &&
			intent.kind !== 'or' &&
			intent.kind !== 'not'
		) {
			const decision = convertWhereCondition(
				intent,
				ctx.currentAlias ?? ctx.rootTable,
			);
			if (!decision)
				throw new Error(`Unsupported include predicate '${intent.kind}'`);
			return dispatcher(
				mapToHandlerDecision(
					decision,
					ctx.rootTable,
					ctx.defaultPkColumnName ?? DEFAULT_PK_COLUMN,
					ctx.deriveFkColumnName ?? defaultFkDerivation,
				),
				handlerCtx,
				ctx.paramState,
			);
		}

		const havingOperand = ctx.resolveHavingOperand?.(intent);
		if (havingOperand)
			return dispatcher(havingOperand, handlerCtx, ctx.paramState);
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
			const exprRefResult = handleComparisonWithExprRef(
				intent,
				ctx,
				handlerCtx,
			);
			if (exprRefResult !== null) return exprRefResult;
			if (
				ctx.position === 'recursive-anchor' &&
				intent.jsonPath === undefined &&
				!isFieldRef(intent.value)
			) {
				const left = buildColumnRef(intent.field, handlerCtx);
				const nullComparison = compileLiteralNullComparison(
					intent.operator,
					left,
					intent.value,
				);
				if (nullComparison) return nullComparison;
				return compileMappedComparison(intent.operator)(
					left,
					compileValue(intent.value, ctx.paramState, undefined, true),
				);
			}
		}

		// Fallback to dispatcher: comparison, like, in, any, null, exists, notExists,
		// jsonContains, jsonExists — plus pass-through for unknown kinds.
		const needsColumn = intent.kind === 'comparison' || intent.kind === 'null';
		const rawIntent = intent as unknown as Record<string, unknown>;
		const bridged = needsColumn
			? ({
					...intent,
					...((((ctx.position === 'where' || ctx.position === 'subquery') &&
						ctx.directRootWhere) ||
						ctx.position === 'filter' ||
						ctx.position === 'having' ||
						ctx.position === 'case-when' ||
						ctx.position === 'recursive-anchor') && { type: 'where' }),
					column: rawIntent.field,
					...('value' in rawIntent && {
						value: rawIntent.value,
					}),
				} as unknown as Decision)
			: ({
					...intent,
					...((((ctx.position === 'where' || ctx.position === 'subquery') &&
						ctx.directRootWhere) ||
						ctx.position === 'filter' ||
						ctx.position === 'having' ||
						ctx.position === 'case-when' ||
						ctx.position === 'recursive-anchor') && { type: 'where' }),
				} as unknown as Decision);
		return dispatcher(bridged, handlerCtx, ctx.paramState);
	}

	/** Normalize once; descendants retain position, and subquery bodies select subquery. */
	function compileCondition(
		intent: WhereIntent,
		ctx: ConditionCompilerCtx,
	): Node {
		const position =
			ctx.position === 'having'
				? 'HAVING'
				: ctx.position === 'case-when'
					? 'CASE WHEN'
					: 'WHERE';
		if (['subquery', 'having', 'case-when'].includes(ctx.position))
			assertNoRecursiveRootRelations(intent, position);
		assertNoManyToManyRootRelations(
			intent,
			ctx.logicalSourceTable,
			ctx.model,
			position,
		);
		return compileTopLevel(intent, ctx);
	}

	/** Legacy top-level callers alone default to where. One dispatcher per compilation. */
	function compileWhereIntent(
		intent: WhereIntent,
		ctx: WhereCompilerCtx,
	): Node {
		return compileTopLevel(intent, ctx);
	}
	function compileTopLevel(
		intent: WhereIntent,
		ctx: WhereCompilerCtx | ConditionCompilerCtx,
	): Node {
		if (ctx.position === 'recursive-anchor')
			assertNoRecursiveAnchorRelations(intent);
		const contexts = new WeakMap<InternalConditionCtx, CompilerContext>();
		const compile = (child: WhereIntent, inner: InternalConditionCtx): Node => {
			let handlerCtx = contexts.get(inner);
			if (!handlerCtx) {
				handlerCtx = toHandlerContext(inner, dispatcher);
				contexts.set(inner, handlerCtx);
			}
			try {
				return compileConditionWithLegacyContext(
					child,
					inner,
					dispatcher,
					handlerCtx,
				);
			} catch (error) {
				if (
					error instanceof Error &&
					error.message.startsWith('No WHERE handler') &&
					(inner.position === 'having' ||
						inner.position === 'case-when' ||
						inner.position === 'filter')
				) {
					const position =
						inner.position === 'having'
							? 'HAVING'
							: inner.position === 'case-when'
								? 'CASE WHEN'
								: 'FILTER';
					throw new Error(
						error.message.replace('No WHERE handler', `No ${position} handler`),
						{ cause: error },
					);
				}
				throw error;
			}
		};
		const recurse = (child: WhereIntent, inner: WhereCompilerCtx): Node =>
			compile(
				child,
				(inner as Partial<InternalConditionCtx>).compileCondition === recurse
					? (inner as InternalConditionCtx)
					: {
							...inner,
							position: inner.position ?? 'where',
							compileCondition: recurse,
						},
			);
		const dispatcher = createWhereDispatcher((child, inner) => {
			if (inner.position !== 'recursive-anchor' && !inner.directRootWhere)
				return recurse(child, inner);
			// EXISTS changes the table and alias but inherits its parent's binding.
			// Rebuild the child authority before compiling any raw descendant.
			const binding = relationBinding({
				kind: 'declared-table',
				logicalTable: inner.rootTable,
				qualifier: queryLocal(inner.currentAlias ?? inner.rootTable),
			});
			return recurse(child, {
				...inner,
				currentBinding: binding,
				scope: queryScope([
					...Array.from(inner.scope?.bindings.values() ?? []).filter(
						(visible) => visible.qualifier !== binding.qualifier,
					),
					binding,
				]),
			});
		});
		const normalized: InternalConditionCtx =
			'logicalSourceTable' in ctx
				? {
						...ctx,
						rootTable: ctx.logicalSourceTable,
						directRootWhere: [
							'where',
							'subquery',
							'having',
							'case-when',
						].includes(ctx.position),
						currentAlias: ctx.emittedAlias,
						aliases: ctx.visibleAliases,
						compileCondition: recurse,
					}
				: {
						...ctx,
						position: ctx.position ?? 'where',
						compileCondition: recurse,
					};

		return recurse(intent, normalized);
	}
	const buildSubqueryFromIntent = createSubqueryBuilder(
		compileWhereIntent,
		compileCondition,
	);
	return {
		compileCondition,
		compileWhereIntent,
		buildSubqueryFromIntent,
	};
}
