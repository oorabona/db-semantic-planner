/**
 * Collection Operators Handler
 *
 * Handles: in, notIn
 */

import type { Node } from '@pgsql/types';
import { booleanConstNode } from '../../ast-helpers.js';
import { createParamRef, createTypeCastParamRef } from '../../param-ref.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereHandler,
} from '../types.js';
import { COLLECTION_OPERATORS } from '../types.js';
import { buildColumnRef, resolveColumnPgType } from './utils.js';

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

		// Defensive: if `value` is a subquery-shaped object (has a `from` key),
		// that indicates a compiler bug — the IN+subquery path should have already
		// remapped this decision to inSubquery/notInSubquery before dispatching here.
		// Binding a subquery object as a scalar ANY($n) parameter produces structurally
		// wrong SQL (the object is serialized as a parameter, not a subquery).
		if (
			value !== null &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			'from' in (value as object)
		) {
			throw new Error(
				`[in handler] Received a subquery-shaped object in 'value' for operator '${operator}' on column '${column}'. ` +
					`This is a compiler bug: IN+subquery decisions must be remapped to inSubquery/notInSubquery ` +
					`before reaching the in handler. File a bug report.`,
			);
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
		const columnType = resolveColumnPgType(column, ctx);

		if (operator === COLLECTION_OPERATORS.NOT_IN || operator === 'notIn') {
			return createNotInExpr(columnNode, state, values, columnType);
		}

		return createInExpr(columnNode, state, values, columnType);
	},
};
