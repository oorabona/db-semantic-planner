/**
 * Custom Expression WHERE Handler
 *
 * Handles WHERE conditions using custom expressions (ExpressionIntent).
 * Operator: 'expression'
 * Pattern: <expr> <op> $N
 */

import type { ExpressionIntent } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import { binaryExpr } from '../../ast-helpers.js';
import { createParamRef } from '../../param-ref.js';
import { compileExpressionIntent } from '../expression/custom.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereDispatcher,
	WhereHandler,
} from '../types.js';

/**
 * Maps comparison operator names to SQL operators.
 */
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

		// Left side: compile the custom expression
		const leftNode = compileExpressionIntent(exprIntent, ctx, state);

		// Right side: bind the comparison value as a parameter
		const idx = ++state.paramIndex;
		state.parameters.push(decision.value);
		const rightNode = createParamRef(idx);

		// Map comparison operator
		const rawOp = decision.subqueryOperator ?? decision.operator ?? '=';
		const sqlOp = OP_MAP[rawOp];
		if (!sqlOp) {
			throw new Error(
				`customExpressionWhereHandler: unsupported comparison operator: ${rawOp}`,
			);
		}

		return binaryExpr(sqlOp, leftNode, rightNode);
	},
};
