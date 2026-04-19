/**
 * Subquery Operators Handler
 *
 * Handles scalar subquery comparisons like:
 * - WHERE price > (SELECT AVG(price) FROM products)
 * - WHERE id IN (SELECT user_id FROM active_users)
 */

import type {
	A_Expr,
	A_Expr_Kind,
	Node,
	SelectStmt,
	SubLink,
} from '@pgsql/types';
import { columnRef, integerNode, rangeVar, sortBy } from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereDispatcher,
	WhereHandler,
} from '../types.js';

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
			// Alias is query-scoped, not schema-qualified
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
		// SELECT column — alias is query-scoped, not schema-qualified
		targetVal = columnRef(selectColumn, targetAlias, undefined, ctx.naming);
	}

	// Build WHERE clause if conditions exist
	let whereClause: Node | undefined;
	if (decision.conditions && decision.conditions.length > 0) {
		// Strip schema — nested conditions reference the aliased table
		const { schema: _schema, ...ctxWithoutSchema } = ctx;
		const subCtx: CompilerContext = {
			...ctxWithoutSchema,
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
		const leftOperand = columnRef(column, sourceAlias, undefined, ctx.naming);
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
		const leftOperand = columnRef(column, sourceAlias, undefined, ctx.naming);
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
