/**
 * Collection Operators Handler
 *
 * Handles: in, notIn
 */

import type { Node } from '@pgsql/types';
import { booleanConstNode } from '../../ast-helpers.js';
import { createParamRef, createTypeCastParamRef } from '../../param-ref.js';
import type { CompilerState } from '../types.js';

/**
 * Create IN expression using = ANY($N)
 * Uses AEXPR_OP_ANY to avoid pg-deparse quoting "any" as an identifier
 */
function createInExpr(
	columnNode: Node,
	state: CompilerState,
	values: unknown[],
	columnType?: string,
): Node {
	state.paramIndex++;
	state.parameters.push(values);
	const paramNode = columnType
		? createTypeCastParamRef(state.paramIndex, columnType, true)
		: createParamRef(state.paramIndex);
	return {
		A_Expr: {
			kind: 'AEXPR_OP_ANY',
			name: [{ String: { sval: '=' } }],
			lexpr: columnNode,
			rexpr: paramNode,
		},
	};
}

/**
 * Create NOT IN expression using <> ALL($N)
 * Uses AEXPR_OP_ALL to avoid pg-deparse quoting "all" as an identifier
 */
function createNotInExpr(
	columnNode: Node,
	state: CompilerState,
	values: unknown[],
	columnType?: string,
): Node {
	state.paramIndex++;
	state.parameters.push(values);
	const paramNode = columnType
		? createTypeCastParamRef(state.paramIndex, columnType, true)
		: createParamRef(state.paramIndex);
	return {
		A_Expr: {
			kind: 'AEXPR_OP_ALL',
			name: [{ String: { sval: '<>' } }],
			lexpr: columnNode,
			rexpr: paramNode,
		},
	};
}

/**
 * Create portable IN/NOT IN expression using one parameter per list item.
 * Used when the target dialect does not support native array parameters.
 */
function createLiteralInListExpr(
	columnNode: Node,
	state: CompilerState,
	values: unknown[],
	negated: boolean,
): Node {
	const paramRefs = values.map((value) => {
		state.paramIndex++;
		state.parameters.push(value);
		return createParamRef(state.paramIndex);
	});
	return {
		A_Expr: {
			kind: 'AEXPR_IN',
			name: [{ String: { sval: negated ? '<>' : '=' } }],
			lexpr: columnNode,
			rexpr: { List: { items: paramRefs } },
		},
	};
}

/** Typed collection primitive after legacy value validation and unwrapping. */
export function compileInValues(
	column: Node,
	state: CompilerState,
	values: unknown[],
	negated: boolean,
	columnType: string | undefined,
	supportsArrays: boolean,
): Node {
	if (!values.length) return booleanConstNode(negated);
	if (!supportsArrays)
		return createLiteralInListExpr(column, state, values, negated);
	return negated
		? createNotInExpr(column, state, values, columnType)
		: createInExpr(column, state, values, columnType);
}
