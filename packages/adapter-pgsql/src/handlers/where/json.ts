/**
 * @module handlers/where/json
 * WHERE handlers for JSONB operators (@>, <@, ?, ->, ->>).
 */

import type { Node } from '@pgsql/types';

/** Typed JSON AST primitive; capability and value checks belong to the caller. */
export function compileJsonOperator(
	left: Node,
	right: Node,
	operator: string,
): Node {
	return {
		A_Expr: {
			kind: 'AEXPR_OP',
			name: [{ String: { sval: operator } }],
			lexpr: left,
			rexpr: right,
		},
	};
}
