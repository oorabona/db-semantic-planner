/**
 * Pattern Operators Handler
 *
 * Handles: like, ilike
 */

import type { Node } from '@pgsql/types';
import { ilikeExpr, likeExpr } from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereHandler,
} from '../types.js';
import { PATTERN_OPERATORS } from '../types.js';
import { buildColumnRef, buildParamRef } from './utils.js';

/**
 * Pattern operators handler (LIKE, ILIKE)
 */
export const likeHandler: WhereHandler = {
	operators: [PATTERN_OPERATORS.LIKE, PATTERN_OPERATORS.ILIKE],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const operator = decision.operator ?? 'like';
		const column = decision.column;
		const value = decision.value;

		if (!column) {
			throw new Error('Like handler requires a column');
		}

		const left = buildColumnRef(column, ctx);
		const right = buildParamRef(value, state);

		let exprNode: Node;

		if (operator === PATTERN_OPERATORS.ILIKE || operator === 'ilike') {
			exprNode = ilikeExpr(left, right);
		} else {
			exprNode = likeExpr(left, right);
		}

		if (decision.escape !== undefined) {
			// Attach escape param as a runtime property on the A_Expr node
			// so that deparseAExpr can render ESCAPE $N
			const escapeRef = buildParamRef(decision.escape, state);
			(
				(exprNode as unknown as Record<string, unknown>).A_Expr as Record<
					string,
					unknown
				>
			).escape = escapeRef;
		}

		return exprNode;
	},
};
