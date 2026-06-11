/**
 * Predicate Subquery Emission — single chokepoint for IN/scalar/rawExists subqueries.
 *
 * All predicate-subquery SQL emission on the HANDLER path routes through
 * `buildPredicateSubquerySelect`.  Validation runs at TWO layers:
 *
 * LAYER 1 — sourceIntent (when present):
 *   `assertNoUnsupportedSubqueryModifiers(sourceIntent, use)` validates the
 *   ORIGINAL QueryIntent preserved as `Decision.subqueryIntent` during lowering.
 *   Catches modifiers on lowered (intent-derived) decisions.
 *
 * LAYER 2 — decision fields (always):
 *   `assertNoDroppedDecisionModifiers(decision, use)` validates the Decision's own
 *   fields unconditionally.  This catches directly-constructed compilePlan decisions
 *   (no subqueryIntent) whose extra fields — groupBy, having, offset, distinct,
 *   distinctOn, include, joins — would otherwise be silently emitted or dropped.
 *   `mapToHandlerDecision` (compiler.ts) preserves `include` through the mapper, so
 *   an `include` on a directly-constructed decision WOULD reach SQL emission unless
 *   caught here.
 *
 * The combination is exhaustive: lowered decisions are caught via sourceIntent;
 * directly-constructed decisions are caught via their own fields.
 *
 * PROVENANCE CONTRACT
 * -------------------
 * Lowering (convertIn / convertSubquery / normalizeToDecision / dispatchWhere /
 * mapInSubqueryCondition) strips modifiers from the source QueryIntent before
 * producing a Decision.  `sourceIntent` is the ORIGINAL QueryIntent carried
 * on `Decision.subqueryIntent` (set at each lowering site) so that validation
 * is always run against the true caller intent, even for:
 *   - whereNot with multiple children
 *   - compilePlan direct-decision path
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

import { isParamIntent, type QueryIntent } from '@dbsp/types';
import type { Node, SelectStmt } from '@pgsql/types';
import { columnRef, integerNode, rangeVar, sortBy } from './ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereDispatcher,
} from './handlers/types.js';
import {
	assertNoUnsupportedSubqueryModifiers,
	containsOuterRef,
} from './intent-to-decisions.js';

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

// ============================================================================
// Decision-level modifier guard (Layer 2 of the dual validation)
// ============================================================================

/**
 * Guard: throw a clear error if the Decision carries query modifiers that this
 * compilation path does not faithfully emit, or a projection that would produce
 * wrong SQL (GROUP BY, HAVING, OFFSET, DISTINCT, joins, includes, malformed
 * IN projection).
 *
 * This is LAYER 2 of the dual validation in `buildPredicateSubquerySelect`.  It
 * runs unconditionally, complementing the sourceIntent (Layer 1) check:
 *
 * - Layer 1 catches modifiers on lowered (intent-derived) decisions via sourceIntent.
 * - Layer 2 catches modifiers on directly-constructed compilePlan decisions that have
 *   no `subqueryIntent` but whose own fields carry the forbidden modifiers.
 *
 * `mapToHandlerDecision` preserves `include` through the mapper (compiler.ts ~131),
 * so an `include` on a directly-constructed decision WOULD reach SQL emission unless
 * caught here.
 *
 * @internal
 */
export function assertNoDroppedDecisionModifiers(
	decision: Decision,
	use: SubqueryPredicateUse,
): void {
	// Cast through unknown to inspect extra fields not present in the typed interface
	// (directly-constructed plans may add extra properties via `as any`).
	const d = decision as unknown as Record<string, unknown>;
	const unsupported: string[] = [];

	if (Array.isArray(d.groupBy) && (d.groupBy as unknown[]).length > 0)
		unsupported.push('GROUP BY');
	if (d.having != null) unsupported.push('HAVING');
	if (d.offset != null) unsupported.push('OFFSET');
	if (d.distinct === true) unsupported.push('DISTINCT');
	if (Array.isArray(d.distinctOn) && (d.distinctOn as unknown[]).length > 0)
		unsupported.push('DISTINCT ON');
	if (Array.isArray(d.include) && (d.include as unknown[]).length > 0)
		unsupported.push('include (relation hydration)');
	if (Array.isArray(d.joins) && (d.joins as unknown[]).length > 0)
		unsupported.push('joins');

	// IN-subquery projection validation at the decision level.
	// The decision's `selectColumn` is what actually gets emitted.
	// A selectColumn of '*' (with no aggregate) is invalid inside ANY(...).
	// Also catch a selectColumn that is not a usable string (e.g. an object
	// from a malformed fields array whose element was not a string).
	if (use === 'IN') {
		const selectColumn = decision.selectColumn;
		const aggregate = decision.aggregate;
		if (!aggregate) {
			if (!selectColumn || selectColumn === '*') {
				unsupported.push(
					'missing or wildcard selectColumn (IN subquery must project exactly one named column — use .select("col") or .select(["col"]))',
				);
			} else if (typeof selectColumn !== 'string') {
				// Should not happen after normal lowering, but directly-constructed
				// decisions can carry arbitrary values.
				unsupported.push(
					`non-string selectColumn ${JSON.stringify(selectColumn)} (IN subquery must project exactly one named column)`,
				);
			}
		}
	}

	if (unsupported.length > 0) {
		const kind =
			use === 'IN' ? 'IN' : use === 'rawExists' ? 'rawExists' : 'scalar';
		throw new Error(
			`${kind} subquery with ${unsupported.join(', ')} is not supported — ` +
				'it would silently change which rows match; restructure the query or use a CTE.',
		);
	}
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
 * Dual validation:
 *  1. `assertNoUnsupportedSubqueryModifiers(sourceIntent, use)` — validates the
 *     ORIGINAL QueryIntent (provenance from lowering).  Catches modifiers on
 *     lowered intent-derived decisions.
 *  2. `assertNoDroppedDecisionModifiers(decision, use)` — validates the Decision's
 *     own fields unconditionally.  Catches directly-constructed compilePlan
 *     decisions (no subqueryIntent) that carry forbidden modifiers directly.
 *  3. Rejects correlated subqueries (outerRef() inside the inner WHERE).
 *  4. Builds the SelectStmt from the lowered `decision` fields (targetTable,
 *     selectColumn, aggregate, conditions, orderBy, limit).
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
 * @param sourceIntent  - The ORIGINAL QueryIntent before lowering (provenance) —
 *                        used for validation only; SQL is built from `decision`.
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
	// ---- VALIDATION (dual chokepoint for handler path) ------------------------
	// Layer 1: validate the ORIGINAL QueryIntent (provenance).
	// Catches modifiers on lowered intent-derived decisions.
	assertNoUnsupportedSubqueryModifiers(sourceIntent, use);

	// Layer 2: validate the Decision's own fields unconditionally.
	// Catches directly-constructed compilePlan decisions (no subqueryIntent)
	// whose own fields carry forbidden modifiers or a malformed projection.
	assertNoDroppedDecisionModifiers(decision, use);

	// Correlated subqueries (outerRef inside the inner WHERE) are not supported.
	if (sourceIntent.where && containsOuterRef(sourceIntent.where)) {
		const label =
			use === 'rawExists' ? 'rawExists' : use === 'IN' ? 'IN' : 'scalar';
		throw new Error(
			`${label} subquery with correlated outerRef() is not yet supported — ` +
				'use exists("relation", { where: ... }) when a schema relation exists, ' +
				'or restructure the query to avoid the correlation.',
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
	const existingAliases = state.aliases.size;
	const targetAlias = `${targetTable}_subq_${existingAliases}`;
	state.aliases.set(`subquery_${targetTable}`, targetAlias);

	// Build target list (what to select)
	let targetVal: Node;
	if (aggregate) {
		if (selectColumn === '*') {
			// Aggregate with star — e.g. COUNT(*)
			targetVal = {
				FuncCall: {
					funcname: [{ String: { sval: aggregate.toLowerCase() } }],
					agg_star: true,
				},
			};
		} else {
			// Aggregate with column — e.g. AVG(price)
			const aggArg = columnRef(
				selectColumn,
				targetAlias,
				undefined,
				ctx.naming,
			);
			targetVal = {
				FuncCall: {
					funcname: [{ String: { sval: aggregate.toLowerCase() } }],
					args: [aggArg],
				},
			};
		}
	} else {
		targetVal = columnRef(selectColumn, targetAlias, undefined, ctx.naming);
	}

	// Build WHERE clause if conditions exist
	let whereClause: Node | undefined;
	if (decision.conditions && decision.conditions.length > 0) {
		// NOTE: schema is intentionally KEPT in subCtx so any nested EXISTS or
		// subquery conditions can qualify their FROM tables with the schema name.
		// Column references are alias-prefixed (not schema-qualified) regardless.
		const subCtx: CompilerContext = {
			...ctx,
			rootTable: targetTable,
			currentAlias: targetAlias,
		};

		if (decision.conditions.length === 1) {
			whereClause = dispatch(decision.conditions[0]!, subCtx, state);
		} else {
			const compiledConditions = decision.conditions.map((cond) =>
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
		fromClause: [rangeVar(targetTable, targetAlias, ctx.schema, ctx.naming)],
		...(whereClause && { whereClause }),
	};

	// Add ORDER BY if present
	if (decision.orderBy && decision.orderBy.length > 0) {
		stmt.sortClause = decision.orderBy.map((o) =>
			sortBy(
				columnRef(o.column, targetAlias, undefined, ctx.naming),
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
			state.parameters.push(decision.limit.value);
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
