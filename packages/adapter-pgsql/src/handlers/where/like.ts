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
	CompilerDecision,
	WhereHandler,
} from '../types.js';
import { PATTERN_OPERATORS } from '../types.js';
import { buildColumnRef, buildParamRef } from './utils.js';

/** A_Expr with optional ESCAPE clause for LIKE operator */
interface A_ExprWithEscape {
	A_Expr: Record<string, unknown> & { escape?: Node };
}

/**
 * Pattern operators handler (LIKE, ILIKE)
 */
export const likeHandler: WhereHandler = {
	operators: [PATTERN_OPERATORS.LIKE, PATTERN_OPERATORS.ILIKE],

	compile(
		decision: CompilerDecision,
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
			// NOTE: escape property read by deparseAExpr() in pgsql-deparser.ts (AEXPR_LIKE case)
			const escapeRef = buildParamRef(decision.escape, state);
			(exprNode as A_ExprWithEscape).A_Expr.escape = escapeRef;
		}

		return exprNode;
	},
};
