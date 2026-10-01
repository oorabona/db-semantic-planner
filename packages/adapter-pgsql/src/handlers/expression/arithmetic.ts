/**
 * Arithmetic Expression Handler
 *
 * Handles arithmetic expressions like: price * quantity, a + b, -amount
 * Produces A_Expr AST nodes with AEXPR_OP kind.
 */

import type { Node } from '@pgsql/types';
import { unwrapParamIntent } from '../../param-intent.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	ExpressionCompilerContext,
	ExpressionHandler,
} from '../types.js';
import { expressionColumnRef } from '../types.js';
import { bindParameter } from './param-value.js';

/**
 * Resolve an operand to an AST node.
 * - string → column reference
 * - number → parameterized value ($N)
 */
function resolveOperand(
	operand: unknown,
	ctx: ExpressionCompilerContext,
	state: CompilerState,
): Node {
	if (typeof operand === 'string') {
		return expressionColumnRef(operand, ctx);
	}
	if (
		typeof operand === 'object' &&
		operand !== null &&
		'kind' in operand &&
		ctx.compileNqlSelectExpression
	) {
		return ctx.compileNqlSelectExpression(
			operand,
			ctx as CompilerContext,
			state,
		);
	}
	// Numeric or other literal → parametrize
	return bindParameter(unwrapParamIntent(operand), state);
}

/**
 * Arithmetic expression handler.
 * Compiles: left operator right → A_Expr(AEXPR_OP, op, left, right)
 */
export const arithmeticHandler: ExpressionHandler = {
	types: ['arithmetic', 'math', 'calc'],

	compile(
		decision: Decision,
		ctx: ExpressionCompilerContext,
		state: CompilerState,
	): Node {
		const left = decision.args?.[0];
		const right = decision.args?.[1];
		const operator = decision.operator ?? '+';

		if (left === undefined || right === undefined) {
			throw new Error('Arithmetic handler requires left and right operands');
		}

		const leftNode = resolveOperand(left, ctx, state);
		const rightNode = resolveOperand(right, ctx, state);

		return {
			A_Expr: {
				kind: 'AEXPR_OP',
				name: [{ String: { sval: operator } }],
				lexpr: leftNode,
				rexpr: rightNode,
			},
		};
	},
};
