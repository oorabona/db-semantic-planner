/**
 * Pattern Operators Handler
 *
 * Handles: like, ilike
 */

import type { Node } from '@pgsql/types';
import { ilikeExpr, likeExpr } from '../../ast-helpers.js';

/** A_Expr with optional ESCAPE clause for LIKE operator */
interface A_ExprWithEscape {
	A_Expr: Record<string, unknown> & { escape?: Node };
}

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
