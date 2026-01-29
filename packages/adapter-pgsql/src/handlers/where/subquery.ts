/**
 * Subquery Operators Handler
 *
 * Handles scalar subquery comparisons like:
 * - WHERE price > (SELECT AVG(price) FROM products)
 * - WHERE id IN (SELECT user_id FROM active_users)
 */

import type { Node, SelectStmt, SubLink, SubLinkType } from '@pgsql/types';
import { columnRef, rangeVar } from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereDispatcher,
	WhereHandler,
} from '../types.js';

/**
 * Map decision operators to SubLinkType
 */
const SUBLINK_TYPE_MAP: Record<string, SubLinkType> = {
	in: 'ANY_SUBLINK',
	notIn: 'ALL_SUBLINK',
	'=': 'EXPR_SUBLINK',
	'!=': 'EXPR_SUBLINK',
	'<': 'EXPR_SUBLINK',
	'<=': 'EXPR_SUBLINK',
	'>': 'EXPR_SUBLINK',
	'>=': 'EXPR_SUBLINK',
};

/**
 * Map comparison operators to their PostgreSQL equivalents
 */
const PG_OPERATOR_MAP: Record<string, string> = {
	'=': '=',
	'!=': '<>',
	'<': '<',
	'<=': '<=',
	'>': '>',
	'>=': '>=',
};

/**
 * Create a SubLink node for scalar subquery comparison
 */
function createScalarSubLink(
	subquery: Node,
	operator: string,
	leftOperand: Node,
): Node {
	const subLinkType = SUBLINK_TYPE_MAP[operator] ?? 'EXPR_SUBLINK';

	const subLink: SubLink = {
		subLinkType,
		subselect: subquery,
		testexpr: leftOperand,
		operName: [{ String: { sval: PG_OPERATOR_MAP[operator] ?? operator } }],
	};

	return { SubLink: subLink };
}

/**
 * Build a simple SELECT subquery from a table
 *
 * SELECT aggregate(column) FROM table [WHERE conditions]
 */
function buildScalarSubquery(
	decision: Decision,
	ctx: CompilerContext,
	state: CompilerState,
	dispatch: WhereDispatcher,
): Node {
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
		// SELECT COUNT(*), AVG(column), etc.
		if (selectColumn === '*') {
			// Aggregate with star (e.g., COUNT(*))
			targetVal = {
				FuncCall: {
					funcname: [{ String: { sval: aggregate.toLowerCase() } }],
					agg_star: true,
				},
			};
		} else {
			// Aggregate with column (e.g., AVG(price))
			const aggArg = columnRef(
				selectColumn,
				targetAlias,
				ctx.schema,
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
		// SELECT column
		targetVal = columnRef(selectColumn, targetAlias, ctx.schema, ctx.naming);
	}

	// Build WHERE clause if conditions exist
	let whereClause: Node | undefined;
	if (decision.conditions && decision.conditions.length > 0) {
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

	return { SelectStmt: stmt };
}

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
		const leftOperand = columnRef(column, sourceAlias, ctx.schema, ctx.naming);
		const subquery = buildScalarSubquery(decision, ctx, state, dispatch);

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
		const leftOperand = columnRef(column, sourceAlias, ctx.schema, ctx.naming);
		const subquery = buildScalarSubquery(decision, ctx, state, dispatch);

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
		const leftOperand = columnRef(column, sourceAlias, ctx.schema, ctx.naming);
		const subquery = buildScalarSubquery(decision, ctx, state, dispatch);

		const subLink: SubLink = {
			subLinkType: 'ALL_SUBLINK',
			subselect: subquery,
			testexpr: leftOperand,
			operName: [{ String: { sval: '<>' } }],
		};

		return { SubLink: subLink };
	},
};
