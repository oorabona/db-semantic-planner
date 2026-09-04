/**
 * Subquery Operators Handler
 *
 * Handles scalar subquery comparisons like:
 * - WHERE price > (SELECT AVG(price) FROM products)
 * - WHERE id IN (SELECT user_id FROM active_users)
 *
 * SQL emission is delegated to `buildPredicateSubquerySelect` (subquery-emission.ts),
 * the single chokepoint that validates the original QueryIntent (via
 * `decision.subqueryIntent` provenance) before building the SelectStmt.
 */

import type { A_Expr, A_Expr_Kind, Node, SubLink } from '@pgsql/types';
import { columnRef, distinctExpr } from '../../ast-helpers.js';
import { buildPredicateSubquerySelect } from '../../subquery-emission.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereDispatcher,
	WhereHandler,
} from '../types.js';
import { resolveWhereOperator } from './operator-resolver.js';

// ============================================================================
// Map comparison operators to their PostgreSQL equivalents
// ============================================================================

const PG_OPERATOR_MAP: Record<string, string> = {
	'=': '=',
	'!=': '<>',
	'<': '<',
	'<=': '<=',
	'>': '>',
	'>=': '>=',
	isDistinctFrom: '=',
};

// ============================================================================
// Scalar SubLink builder
// ============================================================================

/**
 * Create an A_Expr node for scalar subquery comparison.
 * Uses A_Expr with AEXPR_OP instead of SubLink.testexpr because
 * pgsql-deparser doesn't deparse EXPR_SUBLINK.testexpr/operName correctly.
 *
 * Result: lexpr OP (SELECT ... FROM ...)
 */
function createScalarSubLink(
	subquery: Node,
	operator: string,
	leftOperand: Node,
	sqlOp: string = resolveWhereOperator(operator, PG_OPERATOR_MAP),
): Node {
	// Wrap subquery in SubLink node for EXPR_SUBLINK
	const subLink: SubLink = {
		subLinkType: 'EXPR_SUBLINK',
		subselect: subquery,
	};

	// Build A_Expr: column OP (subquery)
	if (operator === 'isDistinctFrom') {
		return distinctExpr(leftOperand, { SubLink: subLink });
	}

	const expr: A_Expr = {
		kind: 'AEXPR_OP' as A_Expr_Kind,
		name: [{ String: { sval: sqlOp } }],
		lexpr: leftOperand,
		rexpr: { SubLink: subLink },
	};

	return { A_Expr: expr };
}

// ============================================================================
// Helper: detect lowered outerRef in decision conditions
// ============================================================================

/**
 * Recursively walk Decision conditions looking for a FieldRef with scope:'outer'.
 *
 * When `convertSubquery` lowered a `subquery` WhereIntent to a Decision, any
 * `outerRef()` node in the inner WHERE was converted to
 * `{ kind: 'fieldRef', scope: 'outer', column }` by `convertComparison`.
 * `buildPredicateSubquerySelect` builds its inner subCtx with no `outerAlias`, so
 * a scope:'outer' FieldRef would bind to the inner alias — producing wrong SQL.
 *
 * This check covers the case where `decision.subqueryIntent` is absent (a
 * directly-constructed handler decision) so `buildPredicateSubquerySelect`'s
 * `containsOuterRef(sourceIntent.where)` check cannot see the correlation.
 *
 * @internal
 */
function conditionsContainOuterFieldRef(
	conditions: readonly unknown[],
): boolean {
	for (const cond of conditions) {
		if (!cond || typeof cond !== 'object') continue;
		const c = cond as Record<string, unknown>;
		// Check this Decision's value for a fieldRef with scope:'outer'
		const val = c.value;
		if (val && typeof val === 'object') {
			const v = val as Record<string, unknown>;
			if (v.kind === 'fieldRef' && v.scope === 'outer') return true;
		}
		// Recurse into nested conditions (and/or/not groups)
		if (Array.isArray(c.conditions)) {
			if (conditionsContainOuterFieldRef(c.conditions as unknown[]))
				return true;
		}
	}
	return false;
}

// ============================================================================
// Thin wrapper — delegates to buildPredicateSubquerySelect (chokepoint)
// ============================================================================

/**
 * Build a SELECT subquery AST node from a lowered Decision.
 *
 * Thin wrapper over `buildPredicateSubquerySelect` — uses `decision.subqueryIntent`
 * (the original QueryIntent set during lowering) as provenance for validation.
 *
 * The `use` parameter is derived from the calling handler's operator:
 * - inSubquery / notInSubquery → 'IN'
 * - scalarSubquery / subqueryEq / … → 'scalar'
 *
 * Validation runs at two levels:
 * 1. `buildPredicateSubquerySelect` validates `sourceIntent` modifiers and
 *    checks `sourceIntent.where` for `outerRef()` nodes.
 * 2. This wrapper also checks the LOWERED `decision.conditions` for a
 *    `fieldRef(scope:'outer')` — covering the case where `subqueryIntent` is
 *    absent (directly-constructed decision) and the correlation is only visible
 *    in the post-lowering conditions, not in `sourceIntent.where`.
 *
 * DEFENSE-IN-DEPTH: when `decision.subqueryIntent` is absent (directly-constructed
 * Decision without provenance), we synthesize a minimal QueryIntent from the lowered
 * fields so the chokepoint can still validate structural modifier violations.
 */
function buildScalarSubquery(
	decision: Decision,
	use: 'IN' | 'scalar',
	ctx: CompilerContext,
	state: CompilerState,
	dispatch: WhereDispatcher,
): Node {
	// DEFECT 2 FIX (defense-in-depth, decisions handler path):
	// Check the LOWERED decision.conditions for a fieldRef with scope:'outer'.
	// This fires when convertSubquery (decisions path entry) already threw for
	// outerRef() in the intent; this guard catches manually-constructed Decisions
	// that bypass the entry point (directly-constructed handler decisions whose
	// subqueryIntent is absent).
	if (
		decision.conditions &&
		conditionsContainOuterFieldRef(decision.conditions as unknown[])
	) {
		throw new Error(
			'scalar subquery with correlated outerRef() is not yet supported — ' +
				'use exists("relation", { where: ... }) when a schema relation exists, ' +
				'or restructure the query to avoid the correlation.',
		);
	}

	// Resolve source intent: prefer the carried provenance; synthesize from
	// lowered fields as fallback for directly-constructed decisions.
	const sourceIntent: import('@dbsp/types').QueryIntent =
		decision.subqueryIntent ??
		(decision.selectColumn
			? ({
					from: decision.targetTable ?? decision.relation ?? '',
					select: {
						type: 'fields',
						fields: [decision.selectColumn],
					} as import('@dbsp/types').SelectIntent,
				} as import('@dbsp/types').QueryIntent)
			: ({
					from: decision.targetTable ?? decision.relation ?? '',
				} as import('@dbsp/types').QueryIntent));

	return buildPredicateSubquerySelect(
		use,
		sourceIntent,
		decision,
		ctx,
		state,
		dispatch,
	);
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * Scalar subquery comparison handler
 *
 * Handles: column OP (SELECT ... FROM ...)
 * Where OP is =, !=, <, <=, >, >=
 */
export const scalarSubqueryHandler: WhereHandler = {
	operators: [
		'scalarSubquery',
		'subqueryEq',
		'subqueryNeq',
		'subqueryLt',
		'subqueryLte',
		'subqueryGt',
		'subqueryGte',
	],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
		dispatch: WhereDispatcher,
	): Node {
		const column = decision.column;
		const operator = decision.subqueryOperator ?? '=';
		const sqlOp = resolveWhereOperator(operator, PG_OPERATOR_MAP);

		if (!column) {
			throw new Error('Scalar subquery requires column');
		}

		const sourceAlias = ctx.currentAlias ?? ctx.rootTable;
		const leftOperand = columnRef(column, sourceAlias, undefined, ctx.naming);
		const subquery = buildScalarSubquery(
			decision,
			'scalar',
			ctx,
			state,
			dispatch,
		);

		return createScalarSubLink(subquery, operator, leftOperand, sqlOp);
	},
};

/**
 * IN subquery handler
 *
 * Handles: column IN (SELECT ... FROM ...)
 */
export const inSubqueryHandler: WhereHandler = {
	operators: ['inSubquery'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
		dispatch: WhereDispatcher,
	): Node {
		const column = decision.column;

		if (!column) {
			throw new Error('IN subquery requires column');
		}

		const sourceAlias = ctx.currentAlias ?? ctx.rootTable;
		const leftOperand = columnRef(column, sourceAlias, undefined, ctx.naming);
		const subquery = buildScalarSubquery(decision, 'IN', ctx, state, dispatch);

		const subLink: SubLink = {
			subLinkType: 'ANY_SUBLINK',
			subselect: subquery,
			testexpr: leftOperand,
			operName: [{ String: { sval: '=' } }],
		};

		return { SubLink: subLink };
	},
};

/**
 * NOT IN subquery handler
 *
 * Handles: column NOT IN (SELECT ... FROM ...)
 */
export const notInSubqueryHandler: WhereHandler = {
	operators: ['notInSubquery'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
		dispatch: WhereDispatcher,
	): Node {
		const column = decision.column;

		if (!column) {
			throw new Error('NOT IN subquery requires column');
		}

		const sourceAlias = ctx.currentAlias ?? ctx.rootTable;
		const leftOperand = columnRef(column, sourceAlias, undefined, ctx.naming);
		const subquery = buildScalarSubquery(decision, 'IN', ctx, state, dispatch);

		const subLink: SubLink = {
			subLinkType: 'ALL_SUBLINK',
			subselect: subquery,
			testexpr: leftOperand,
			operName: [{ String: { sval: '<>' } }],
		};

		return { SubLink: subLink };
	},
};
