/**
 * Custom Expression WHERE Handler
 *
 * Handles WHERE conditions using custom expressions (ExpressionIntent).
 * Operator: 'expression'
 * Pattern: <expr> <op> $N
 */

import type { ExpressionIntent } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import { binaryExpr, distinctExpr } from '../../ast-helpers.js';
import { unwrapParamIntent } from '../../param-intent.js';
import { createParamRef } from '../../param-ref.js';
import { compileExpressionIntent } from '../expression/custom.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereDispatcher,
	WhereHandler,
} from '../types.js';
import { resolveWhereOperator } from './operator-resolver.js';

/**
 * Maps comparison operator names to SQL operators.
 */
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

/**
 * WHERE handler for custom expression comparisons.
 * Compiles: <expression> <op> $N
 */
export const customExpressionWhereHandler: WhereHandler = {
	operators: ['expression'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
		_dispatch: WhereDispatcher,
	): Node {
		const exprIntent = decision.expressionIntent as ExpressionIntent;
		const hasSubqueryOperator = Object.hasOwn(decision, 'subqueryOperator');
		const isStandalone = decision.value === undefined && !hasSubqueryOperator;
		const rawOp = decision.subqueryOperator;
		const sqlOp = isStandalone
			? undefined
			: resolveWhereOperator(rawOp, OP_MAP);

		// Left side: compile the custom expression
		const leftNode = compileExpressionIntent(exprIntent, ctx, state);

		// Standalone boolean expression: op('!=', exprRef('a'), exprRef('b')) passed
		// directly to .where() — no right-side value or comparison operator.
		// decision.operator === 'expression' is the WHERE handler discriminant (not a SQL op).
		// A standalone expression has no subqueryOperator and no scalar value to bind.
		if (isStandalone) {
			return leftNode;
		}

		// Right side: bind the comparison value as a parameter
		const idx = ++state.paramIndex;
		state.parameters.push(unwrapParamIntent(decision.value));
		const rightNode = createParamRef(idx);

		return rawOp === 'isDistinctFrom'
			? distinctExpr(leftNode, rightNode)
			: binaryExpr(sqlOp!, leftNode, rightNode);
	},
};
