/**
 * Range Operators Handler
 *
 * Handles: contains (@>), containedBy (<@), overlaps (&&)
 */

import type { Node } from '@pgsql/types';
import { createParamRef, createTypeCastParamRef } from '../../param-ref.js';
import type { CompilerState } from '../types.js';

/** Parameter emission after the caller has resolved range/element cast policy. */
export function compileRangeParameter(
	columnNode: Node,
	pgOp: string,
	value: unknown,
	state: CompilerState,
	castType?: string,
): Node {
	const paramIdx = ++state.paramIndex;
	state.parameters.push(value);
	const rexpr = castType
		? createTypeCastParamRef(paramIdx, castType)
		: createParamRef(paramIdx);

	return {
		A_Expr: {
			kind: 'AEXPR_OP',
			name: [{ String: { sval: pgOp } }],
			lexpr: columnNode,
			rexpr,
		},
	};
}
