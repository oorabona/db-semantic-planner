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
import { compileLiteralNullComparison } from './literal-null.js';
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
		const nullComparison = compileLiteralNullComparison(operator, left, value);
		if (nullComparison) return nullComparison;
		const right = buildParamRef(value, state);

		return compileLike(
			left,
			right,
			operator === PATTERN_OPERATORS.ILIKE || operator === 'ilike',
			decision.escape === undefined
				? undefined
				: buildParamRef(decision.escape, state),
		);
	},
};

/** Typed AST primitive; callers allocate pattern and escape parameters in order. */
export function compileLike(
	left: Node,
	right: Node,
	caseInsensitive: boolean,
	escapeNode?: Node,
): Node {
	const node = caseInsensitive ? ilikeExpr(left, right) : likeExpr(left, right);
	if (escapeNode !== undefined)
		(node as A_ExprWithEscape).A_Expr.escape = escapeNode;
	return node;
}
