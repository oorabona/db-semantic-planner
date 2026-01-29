/**
 * Collection Operators Handler
 *
 * Handles: in, notIn
 */

import type { FuncCall, Node } from '@pgsql/types';
import {
	binaryExpr,
	booleanConstNode,
	columnRef,
	stringNode,
} from '../../ast-helpers.js';
import { createParamRef } from '../../param-ref.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereHandler,
} from '../types.js';
import { COLLECTION_OPERATORS } from '../types.js';

/**
 * Build column reference from decision column
 */
function buildColumnRef(column: string, ctx: CompilerContext): Node {
	const alias = ctx.currentAlias ?? ctx.rootTable;
	return columnRef(column, alias, ctx.schema, ctx.naming);
}

/**
 * Create a FuncCall node for ANY($N)
 * PostgreSQL idiom: col = ANY($1) is equivalent to col IN (...)
 */
function createAnyFuncCall(paramNumber: number): Node {
	const funcCall: FuncCall = {
		funcname: [stringNode('any')],
		args: [createParamRef(paramNumber)],
	};
	return { FuncCall: funcCall };
}

/**
 * Create IN expression using = ANY($N)
 * PostgreSQL idiom: col = ANY($1) is equivalent to col IN (...)
 */
function createInExpr(
	columnNode: Node,
	state: CompilerState,
	values: unknown[],
): Node {
	state.paramIndex++;
	state.parameters.push(values);
	const anyExpr = createAnyFuncCall(state.paramIndex);
	return binaryExpr('=', columnNode, anyExpr);
}

/**
 * Create NOT IN expression using <> ALL($N)
 * PostgreSQL idiom: col <> ALL($1) is equivalent to col NOT IN (...)
 */
function createNotInExpr(
	columnNode: Node,
	state: CompilerState,
	values: unknown[],
): Node {
	state.paramIndex++;
	state.parameters.push(values);
	// For NOT IN, we use != ALL which is equivalent
	// ALL() returns true if comparison is true for all array elements
	const allFuncCall: FuncCall = {
		funcname: [stringNode('all')],
		args: [createParamRef(state.paramIndex)],
	};
	return binaryExpr('<>', columnNode, { FuncCall: allFuncCall });
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
