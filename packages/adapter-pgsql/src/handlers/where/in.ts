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

		// Fail-closed backstop: the plain `in`/`notIn` handler ONLY accepts a
		// scalar array as `value`.  Anything else — a subquery-shaped object
		// (has `from`/`select` keys), `undefined`, `null`, or any other non-array
		// — indicates a compiler bug where an IN+subquery decision was not remapped
		// to inSubquery/notInSubquery before dispatch.  Binding such a value as
		// `ANY($n)` produces structurally wrong SQL (the object is serialized as a
		// parameter, not a subquery, or the parameter slot holds `undefined`).
		//
		// This backstop catches any current or future unguarded path that bypasses
		// the dispatchWhere / mapInSubqueryCondition / normalizeToDecision guards.
		if (!Array.isArray(value)) {
			const hint =
				value !== null &&
				typeof value === 'object' &&
				('from' in (value as object) || 'select' in (value as object))
					? 'IN+subquery decisions must be remapped to inSubquery/notInSubquery before reaching the in handler'
					: `expected a scalar array but received ${value === undefined ? 'undefined' : value === null ? 'null' : typeof value}`;
			throw new Error(
				`[in handler] Received a non-array value for operator '${operator}' on column '${column}'. ` +
					`This is a compiler bug: ${hint}. File a bug report.`,
			);
		}

		// Handle empty arrays
		const values = value;
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
