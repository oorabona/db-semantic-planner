/**
 * Predicate Subquery Emission — single chokepoint for IN/scalar/rawExists subqueries.
 *
 * All predicate-subquery SQL emission on the HANDLER path routes through
 * `buildPredicateSubquerySelect`, which validates the ORIGINAL QueryIntent
 * (`assertNoUnsupportedSubqueryModifiers(sourceIntent, use)`) preserved as
 * `Decision.subqueryIntent` during lowering.
 *
 * PROVENANCE CONTRACT
 * -------------------
 * Lowering (convertIn / convertSubquery / normalizeToDecision) strips modifiers
 * from the source QueryIntent before producing a Decision. `sourceIntent` is the
 * ORIGINAL QueryIntent carried on `Decision.subqueryIntent` (set at each lowering
 * site), so validation always runs against the caller's intent, including:
 *   - whereNot with multiple children
 *   - UPDATE/DELETE mutation path
 *   - nested-logical incl. whereNot-multi-child
 *
 * The direct compile-where path (rawExists / scalar-direct via
 * `buildSubqueryFromIntent`) has a SEPARATE internal builder that also calls
 * `assertNoUnsupportedSubqueryModifiers` directly, because it uses a different
 * parameter-seeding mechanism (inner WhereCompilerCtx).
 *
 * @internal
 */

import {
	isParamIntent,
	NotYetSupportedError,
	type QueryIntent,
} from '@dbsp/types';
import type { Node, SelectStmt } from '@pgsql/types';
import {
	integerNode,
	sortBy,
	sqlColumnRef,
	sqlRangeVar,
} from './ast-helpers.js';
import {
	queryScope,
	relationBinding,
	relationBindingFor,
} from './binding-registry.js';
import { truncateIdentifier } from './column-metadata.js';
import {
	assertNoManyToManyRootRelations,
	assertNoRecursiveRootRelations,
} from './condition-compiler-factory.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereDispatcher,
} from './handlers/types.js';
import { expressionColumnIdentifier } from './handlers/types.js';
import {
	assertNoUnsupportedSubqueryModifiers,
	containsOuterRef,
} from './intent-to-decisions.js';
import { unwrapParamIntent } from './param-intent.js';
import { queryScopeForBindingProjections } from './relation-target-projection.js';
import { queryLocal, resolveDeclaredIdentifier } from './sql-identifier.js';

// ============================================================================
// Predicate use discriminant
// ============================================================================

/**
 * The context in which a subquery is used as a predicate.
 *
 * Used by `assertNoUnsupportedSubqueryModifiers` to apply use-specific rules:
 * - 'IN'           — col = ANY (SELECT ...) — exactly one column, no limit/orderBy
 * - 'scalar'       — col OP (SELECT ...) via decisions path — limit/orderBy allowed
 * - 'scalar-direct'— col OP (SELECT ...) via direct compile-where — limit/orderBy rejected
 * - 'rawExists'    — EXISTS (SELECT ...) — no limit/orderBy
 */
export type SubqueryPredicateUse =
	| 'IN'
	| 'scalar'
	| 'scalar-direct'
	| 'rawExists';

function isColumnOrderBy(
	orderBy: Decision['orderBy'],
): orderBy is readonly { column: string; direction?: 'ASC' | 'DESC' }[] {
	return (
		Array.isArray(orderBy) &&
		orderBy.every(
			(item) =>
				typeof item === 'object' &&
				item !== null &&
				'column' in item &&
				typeof item.column === 'string',
		)
	);
}

// ============================================================================
// Core builder — handler path chokepoint
// ============================================================================

/**
 * Build a SELECT AST node for use as a predicate subquery.
 *
 * This is the SINGLE CHOKEPOINT for all predicate-subquery SQL emission on
 * the handler path (IN subquery, scalar subquery, inSubquery/notInSubquery
 * handlers).
 *
 * Validation: `assertNoUnsupportedSubqueryModifiers(sourceIntent, use)` checks
 * the ORIGINAL QueryIntent (provenance from lowering).
 * The canonical body is compiled through the one condition compiler, with
 * decision dispatch retained for legacy callers.
 *
 * Called by:
 *   - `buildScalarSubquery`  (handlers/where/subquery.ts) — scalar + IN handlers
 *
 * The direct compile-where path (buildSubqueryFromIntent in compile-where.ts)
 * also validates `sourceIntent` via the same `assertNoUnsupportedSubqueryModifiers`
 * call, but builds differently (it has its own inner WhereCompilerCtx for
 * parameter seeding).
 *
 * @param use           - How the subquery is used (drives modifier validation rules)
 * @param sourceIntent  - The ORIGINAL QueryIntent before lowering (provenance).
 * @param decision      - The lowered Decision (targetTable, selectColumn, conditions…)
 * @param ctx           - Immutable compiler context
 * @param state         - Mutable compiler state (params array, aliases, paramIndex)
 * @param dispatch      - WHERE dispatcher for compiling inner conditions
 * @returns PostgreSQL SelectStmt AST node wrapped in { SelectStmt: ... }
 */
export function buildPredicateSubquerySelect(
	use: SubqueryPredicateUse,
	sourceIntent: QueryIntent,
	decision: Decision,
	ctx: CompilerContext,
	state: CompilerState,
	dispatch: WhereDispatcher,
): Node {
	// ---- VALIDATION (chokepoint for the handler path) -------------------------
	// Validate the ORIGINAL QueryIntent (provenance) against the body use.
	assertNoUnsupportedSubqueryModifiers(sourceIntent, use);

	// Correlation is refused only on the route without the condition callback.
	// The subquery builder without a parent returns values for the caller to
	// append; with a parent it shares parameter state and returns no values.
	if (
		!ctx.compileSubqueryCondition &&
		sourceIntent.where &&
		containsOuterRef(sourceIntent.where)
	) {
		const label =
			use === 'rawExists' ? 'rawExists' : use === 'IN' ? 'IN' : 'scalar';
		throw new NotYetSupportedError(
			`a correlated ${label} subquery body`,
			'condition compiled outside the planner',
			891,
		);
	}
	// ---------------------------------------------------------------------------

	const targetTable = decision.targetTable ?? decision.relation;
	const selectColumn = decision.selectColumn ?? '*';
	const aggregate = decision.aggregate;

	if (!targetTable) {
		throw new Error('Subquery handler requires targetTable');
	}

	// Generate unique alias
	let aliasIndex = state.aliases.size;
	const aliasFor = (index: number) => {
		const suffix = `_subq_${index}`;
		return `${truncateIdentifier(targetTable, 63 - suffix.length)}${suffix}`;
	};
	const reserved = new Set(
		[
			...state.aliases.values(),
			...(ctx.bindingNames ?? []),
			...Array.from(ctx.scope?.bindings.keys() ?? []),
			ctx.currentAlias ?? ctx.rootTable,
		].map((name) => truncateIdentifier(name, 63)),
	);
	let targetAlias = aliasFor(aliasIndex);
	while (reserved.has(targetAlias)) {
		targetAlias = aliasFor(++aliasIndex);
	}
	state.aliases.set(`subquery_${targetAlias}`, targetAlias);
	// A mutation may carry an outer scope and a newer CTE binding registry. Merge
	// both at this boundary: the CTE entered before this subquery, so it remains a
	// local relation even when the inherited scope predates that binding.
	const legacyScope = queryScopeForBindingProjections(
		ctx.bindingNames,
		ctx.relationTargetProjections,
	);
	const visibleScope = queryScope([
		...(ctx.scope?.bindings.values() ?? []),
		...Array.from(legacyScope?.bindings.values() ?? []).filter(
			(binding) =>
				relationBindingFor(ctx.scope, binding.qualifier) === undefined,
		),
	]);
	const sourceBinding =
		relationBindingFor(visibleScope, queryLocal(targetTable)) ??
		relationBinding({
			qualifier: resolveDeclaredIdentifier(
				ctx.declaredNames,
				ctx.dbCasing ?? 'preserve',
				{ kind: 'table', table: targetTable },
			),
			kind: 'declared-table',
			logicalTable: targetTable,
		});
	const targetBinding = relationBinding(
		sourceBinding.kind === 'declared-table'
			? {
					qualifier: queryLocal(targetAlias),
					kind: 'declared-table',
					logicalTable: sourceBinding.logicalTable ?? targetTable,
				}
			: {
					qualifier: queryLocal(targetAlias),
					kind: 'join-alias',
					...(sourceBinding.outputs !== undefined && {
						outputs: sourceBinding.outputs,
					}),
				},
	);

	// Build target list (what to select)
	let targetVal: Node;
	if (aggregate) {
		if (selectColumn === '*') {
			// PostgreSQL does not support DISTINCT on a star aggregate — fail clearly
			// rather than silently dropping DISTINCT (the #247 class of bug).
			if (decision.aggregateDistinct === true) {
				throw new Error(
					`${aggregate}(DISTINCT *) is not valid SQL — PostgreSQL does not support ` +
						'DISTINCT on a star aggregate; provide a specific column.',
				);
			}
			// Aggregate with star — e.g. COUNT(*)
			targetVal = {
				FuncCall: {
					funcname: [{ String: { sval: aggregate.toLowerCase() } }],
					agg_star: true,
				},
			};
		} else {
			// Aggregate with column — e.g. AVG(price)
			const aggArg = sqlColumnRef(
				expressionColumnIdentifier(
					selectColumn,
					targetBinding,
					ctx.declaredNames,
				),
				targetBinding.qualifier,
			);
			targetVal = {
				FuncCall: {
					funcname: [{ String: { sval: aggregate.toLowerCase() } }],
					args: [aggArg],
					...(decision.aggregateDistinct === true && { agg_distinct: true }),
				},
			};
		}
	} else {
		targetVal = sqlColumnRef(
			expressionColumnIdentifier(
				selectColumn,
				targetBinding,
				ctx.declaredNames,
			),
			targetBinding.qualifier,
		);
	}

	if (sourceIntent.where && !ctx.compileSubqueryCondition) {
		assertNoRecursiveRootRelations(sourceIntent.where);
		assertNoManyToManyRootRelations(sourceIntent.where, targetTable, ctx.model);
	}
	// Build WHERE clause if conditions exist
	let whereClause: Node | undefined;
	if (
		sourceIntent.where ||
		(decision.conditions && decision.conditions.length > 0)
	) {
		// NOTE: schema is intentionally KEPT in subCtx so any nested EXISTS or
		// subquery conditions can qualify their FROM tables with the schema name.
		// Column references are alias-prefixed (not schema-qualified) regardless.
		const subCtx: CompilerContext = {
			...ctx,
			rootTable: targetTable,
			currentAlias: targetAlias,
			scope: queryScope([
				...(visibleScope?.bindings.values() ?? []),
				targetBinding,
			]),
			currentBinding: targetBinding,
		};

		if (sourceIntent.where && ctx.compileSubqueryCondition) {
			whereClause = ctx.compileSubqueryCondition(
				sourceIntent.where,
				subCtx,
				state,
			);
		} else if (decision.conditions?.length === 1) {
			whereClause = dispatch(decision.conditions[0]!, subCtx, state);
		} else {
			const compiledConditions = (decision.conditions ?? []).map((cond) =>
				dispatch(cond, subCtx, state),
			);
			whereClause = {
				BoolExpr: {
					boolop: 'AND_EXPR',
					args: compiledConditions,
				},
			};
		}
	}

	const stmt: SelectStmt = {
		targetList: [{ ResTarget: { val: targetVal } }],
		fromClause: [
			sqlRangeVar(
				sourceBinding.qualifier,
				targetBinding.qualifier,
				sourceBinding.kind === 'cte-bind' || ctx.schema === undefined
					? undefined
					: queryLocal(ctx.schema),
			),
		],
		...(whereClause && { whereClause }),
	};

	// Add ORDER BY if present
	const orderBy = isColumnOrderBy(decision.orderBy)
		? decision.orderBy
		: undefined;
	if (orderBy && orderBy.length > 0) {
		stmt.sortClause = orderBy.map((o) =>
			sortBy(
				sqlColumnRef(
					expressionColumnIdentifier(
						o.column,
						targetBinding,
						ctx.declaredNames,
					),
					targetBinding.qualifier,
				),
				o.direction ?? 'ASC',
				'DEFAULT',
			),
		);
	}

	// Add LIMIT if present
	if (decision.limit != null) {
		if (typeof decision.limit === 'number') {
			stmt.limitCount = integerNode(decision.limit);
		} else if (isParamIntent(decision.limit)) {
			state.parameters.push(unwrapParamIntent(decision.limit));
			state.paramIndex++;
			stmt.limitCount = {
				ParamRef: { number: state.paramIndex },
			} as unknown as Node;
		} else {
			const limitObj = decision.limit as Record<string, unknown>;
			if (typeof limitObj.paramIndex !== 'number') {
				throw new Error('limit.paramIndex must be a number');
			}
			// Emit a parameter reference ($N) not the literal index integer
			stmt.limitCount = {
				ParamRef: { number: limitObj.paramIndex },
			} as unknown as Node;
		}
	}

	return { SelectStmt: stmt };
}
