/**
 * Collection Operators Handler
 *
 * Handles: in, notIn
 */

import type { Node } from '@pgsql/types';
import { booleanConstNode } from '../../ast-helpers.js';
import { createParamRef } from '../../param-ref.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereHandler,
} from '../types.js';
import { COLLECTION_OPERATORS } from '../types.js';
import { buildColumnRef } from './utils.js';

/**
 * Create IN expression using = ANY($N)
 * Uses AEXPR_OP_ANY to avoid pg-deparse quoting "any" as an identifier
 */
function createInExpr(
	columnNode: Node,
	state: CompilerState,
	values: unknown[],
): Node {
	state.paramIndex++;
	state.parameters.push(values);
	return {
		A_Expr: {
			kind: 'AEXPR_OP_ANY',
			name: [{ String: { sval: '=' } }],
			lexpr: columnNode,
			rexpr: createParamRef(state.paramIndex),
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
): Node {
	state.paramIndex++;
	state.parameters.push(values);
	return {
		A_Expr: {
			kind: 'AEXPR_OP_ALL',
			name: [{ String: { sval: '<>' } }],
			lexpr: columnNode,
			rexpr: createParamRef(state.paramIndex),
		},
	};
}

/**
 * Collection operators handler (IN, NOT IN)
 */
export const inHandler: WhereHandler = {
	operators: [COLLECTION_OPERATORS.IN, COLLECTION_OPERATORS.NOT_IN],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const operator = decision.operator ?? 'in';
		const column = decision.column;
		const value = decision.value;

		if (!column) {
			throw new Error('In handler requires a column');
		}

		// Handle empty arrays
		const values = Array.isArray(value) ? value : [value];
		if (values.length === 0) {
			// Empty IN is always false, empty NOT IN is always true
			if (operator === COLLECTION_OPERATORS.NOT_IN || operator === 'notIn') {
				return booleanConstNode(true);
			}
			return booleanConstNode(false);
		}

		const columnNode = buildColumnRef(column, ctx);

		if (operator === COLLECTION_OPERATORS.NOT_IN || operator === 'notIn') {
			return createNotInExpr(columnNode, state, values);
		}

		return createInExpr(columnNode, state, values);
	},
};
