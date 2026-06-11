/**
 * Arithmetic Expression Handler
 *
 * Handles arithmetic expressions like: price * quantity, a + b, -amount
 * Produces A_Expr AST nodes with AEXPR_OP kind.
 */

import type { Node } from '@pgsql/types';
import { columnRef } from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	ExpressionHandler,
} from '../types.js';
import { bindParameter } from './param-value.js';

/**
 * Resolve an operand to an AST node.
 * - string → column reference
 * - number → parameterized value ($N)
 */
function resolveOperand(
	operand: unknown,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	if (typeof operand === 'string') {
		const alias = ctx.currentAlias ?? ctx.rootTable;
		return columnRef(operand, alias, undefined, ctx.naming);
	}
	// Numeric or other literal → parametrize
	return bindParameter(operand, state);
}

/**
 * Arithmetic expression handler.
 * Compiles: left operator right → A_Expr(AEXPR_OP, op, left, right)
 */
export const arithmeticHandler: ExpressionHandler = {
	types: ['arithmetic', 'math', 'calc'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
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
