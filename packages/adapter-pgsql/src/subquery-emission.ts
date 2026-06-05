/**
 * Predicate Subquery Emission — single chokepoint for IN/scalar/rawExists subqueries.
 *
 * All predicate-subquery SQL emission on the HANDLER path routes through
 * `buildPredicateSubquerySelect`.  Validation (`assertNoUnsupportedSubqueryModifiers`)
 * lives HERE and is applied against the ORIGINAL QueryIntent (`sourceIntent`) that
 * was preserved as `Decision.subqueryIntent` during lowering.
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

import type { QueryIntent } from '@dbsp/types';
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
// Core builder — handler path chokepoint
// ============================================================================

/**
 * Build a SELECT AST node for use as a predicate subquery.
 *
 * This is the SINGLE CHOKEPOINT for all predicate-subquery SQL emission on
 * the handler path (IN subquery, scalar subquery, inSubquery/notInSubquery
 * handlers).
 *
 * It:
 *  1. Validates `sourceIntent` modifiers for `use` — throws if the original
 *     intent carries GROUP BY / HAVING / OFFSET / DISTINCT / joins / include
 *     or any use-specific prohibited modifier (e.g. LIMIT on 'IN').
 *  2. Rejects correlated subqueries (outerRef() inside the inner WHERE).
 *  3. Builds the SelectStmt from the lowered `decision` fields (targetTable,
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
	// ---- VALIDATION (single chokepoint for handler path) ----------------------
	assertNoUnsupportedSubqueryModifiers(sourceIntent, use);

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
