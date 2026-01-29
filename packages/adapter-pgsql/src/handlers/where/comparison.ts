/**
 * Comparison Operators Handler
 *
 * Handles: =, !=, <, <=, >, >=
 */

import type { Node } from '@pgsql/types';
import {
	columnRef,
	eqExpr,
	gtExpr,
	gteExpr,
	ltExpr,
	lteExpr,
	neExpr,
} from '../../ast-helpers.js';
import { createParamRef } from '../../param-ref.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereHandler,
} from '../types.js';
import { COMPARISON_OPERATORS } from '../types.js';

/**
 * Build column reference from decision column
 */
function buildColumnRef(column: string, ctx: CompilerContext): Node {
	const alias = ctx.currentAlias ?? ctx.rootTable;
	return columnRef(column, alias, ctx.schema, ctx.naming);
}

/**
 * Build parameter reference and register value
 */
function buildParamRef(value: unknown, state: CompilerState): Node {
	state.paramIndex++;
	state.parameters.push(value);
	return createParamRef(state.paramIndex);
}

/**
 * Comparison operators handler
 */
export const comparisonHandler: WhereHandler = {
	operators: [
		COMPARISON_OPERATORS.EQ,
		COMPARISON_OPERATORS.NEQ,
		COMPARISON_OPERATORS.LT,
		COMPARISON_OPERATORS.LTE,
		COMPARISON_OPERATORS.GT,
		COMPARISON_OPERATORS.GTE,
	],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const operator = decision.operator ?? '=';
		const column = decision.column;
		const value = decision.value;

		if (!column) {
			throw new Error('Comparison handler requires a column');
		}

		const left = buildColumnRef(column, ctx);
		const right = buildParamRef(value, state);

		switch (operator) {
			case COMPARISON_OPERATORS.EQ:
			case '=':
				return eqExpr(left, right);

			case COMPARISON_OPERATORS.NEQ:
			case '!=':
			case '<>':
				return neExpr(left, right);

			case COMPARISON_OPERATORS.LT:
			case '<':
				return ltExpr(left, right);

			case COMPARISON_OPERATORS.LTE:
			case '<=':
				return lteExpr(left, right);

			case COMPARISON_OPERATORS.GT:
			case '>':
				return gtExpr(left, right);

			case COMPARISON_OPERATORS.GTE:
			case '>=':
				return gteExpr(left, right);

			default:
				throw new Error(`Unknown comparison operator: ${operator}`);
		}
	},
};
