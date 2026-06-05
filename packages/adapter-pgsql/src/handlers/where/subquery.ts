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
import { columnRef } from '../../ast-helpers.js';
import { buildPredicateSubquerySelect } from '../../subquery-emission.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereDispatcher,
	WhereHandler,
} from '../types.js';

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
): Node {
	// Wrap subquery in SubLink node for EXPR_SUBLINK
	const subLink: SubLink = {
		subLinkType: 'EXPR_SUBLINK',
		subselect: subquery,
	};

	// Build A_Expr: column OP (subquery)
	const expr: A_Expr = {
		kind: 'AEXPR_OP' as A_Expr_Kind,
		name: [{ String: { sval: PG_OPERATOR_MAP[operator] ?? operator } }],
		lexpr: leftOperand,
		rexpr: { SubLink: subLink },
	};

	return { A_Expr: expr };
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
 * Validation (assertNoUnsupportedSubqueryModifiers + outerRef check) is performed
 * inside `buildPredicateSubquerySelect` against `sourceIntent` — NOT against the
 * stripped lowered decision fields.
 *
 * DEFENSE-IN-DEPTH: when `decision.subqueryIntent` is absent (directly-constructed
 * Decision without provenance), we synthesize a minimal QueryIntent from the lowered
 * fields so the chokepoint can still validate.  This is intentionally less precise
 * than the full original intent but still catches structural modifier violations
 * (GROUP BY / HAVING / OFFSET / DISTINCT / joins / include).  The remapping +
 * backstop guards at other sites remain in place as defense-in-depth.
 */
function buildScalarSubquery(
	decision: Decision,
	use: 'IN' | 'scalar',
	ctx: CompilerContext,
	state: CompilerState,
	dispatch: WhereDispatcher,
): Node {
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

		return createScalarSubLink(subquery, operator, leftOperand);
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
