/**
 * Comparison Operators Handler
 *
 * Handles: =, !=, <, <=, >, >=
 */

import type { Node } from '@pgsql/types';
import {
	distinctExpr,
	eqExpr,
	gtExpr,
	gteExpr,
	ltExpr,
	lteExpr,
	neExpr,
} from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereHandler,
} from '../types.js';
import { COMPARISON_OPERATORS } from '../types.js';
import { resolveWhereOperator } from './operator-resolver.js';
import {
	buildColumnRef,
	compileValueOrFieldRef,
	resolveColumnPgType,
} from './utils.js';

const COMPARISON_OPERATOR_MAP: Record<string, string> = {
	'=': '=',
	'!=': '!=',
	'<>': '!=',
	isDistinctFrom: 'isDistinctFrom',
	'<': '<',
	'<=': '<=',
	'>': '>',
	'>=': '>=',
};

/**
 * Comparison operators handler
 */
export const comparisonHandler: WhereHandler = {
	operators: [
		COMPARISON_OPERATORS.EQ,
		COMPARISON_OPERATORS.NEQ,
		COMPARISON_OPERATORS.IS_DISTINCT_FROM,
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
		const operator = decision.operator;
		const resolvedOperator = resolveWhereOperator(
			operator,
			COMPARISON_OPERATOR_MAP,
		);
		const column = decision.column;
		const value = decision.value;

		if (!column) {
			throw new Error('Comparison handler requires a column');
		}

		const left = buildColumnRef(column, ctx);
		const columnType = resolveColumnPgType(column, ctx);
		const right = compileValueOrFieldRef(value, ctx, state, columnType);

		switch (resolvedOperator) {
			case '=':
				return eqExpr(left, right);

			case '!=':
				return neExpr(left, right);

			case 'isDistinctFrom':
				return distinctExpr(left, right);

			case '<':
				return ltExpr(left, right);

			case '<=':
				return lteExpr(left, right);

			case '>':
				return gtExpr(left, right);

			case '>=':
				return gteExpr(left, right);

			default:
				throw new Error(
					`No WHERE handler registered for operator: ${operator}`,
				);
		}
	},
};
