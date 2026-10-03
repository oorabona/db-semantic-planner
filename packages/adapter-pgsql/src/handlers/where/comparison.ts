/**
 * Comparison Operators Handler
 *
 * Handles: =, !=, <, <=, >, >=
 */

import type { Node } from '@pgsql/types';
import {
	distinctExpr,
	eqExpr,
	funcCall,
	gtExpr,
	gteExpr,
	ltExpr,
	lteExpr,
	neExpr,
} from '../../ast-helpers.js';
import { normalizeParamIntent } from '../../param-intent.js';
import { escapeDiagnosticText } from '../../validate.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereHandler,
} from '../types.js';
import { COMPARISON_OPERATORS } from '../types.js';
import { compileLiteralNullComparison } from './literal-null.js';
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
		const value = normalizeParamIntent(decision.value);

		if (!column) {
			throw new Error('Comparison handler requires a column');
		}

		const left =
			decision.type === 'having' && decision.function
				? funcCall(
						decision.function,
						column === '*' ? [] : [buildColumnRef(column, ctx)],
						{
							...(column === '*' && { star: true }),
							...(decision.distinct !== undefined && {
								distinct: decision.distinct,
							}),
						},
					)
				: buildColumnRef(column, ctx);
		const nullComparison = compileLiteralNullComparison(operator, left, value);
		if (nullComparison) return nullComparison;
		const columnType =
			decision.type === 'having' && decision.function
				? resolveHavingAggregatePgType(decision.function, column, ctx)
				: resolveColumnPgType(column, ctx);
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
					`No WHERE handler registered for operator: ${escapeDiagnosticText(String(operator))}`,
				);
		}
	},
};

/**
 * Resolve a HAVING parameter cast from the aggregate result, not its argument.
 * Unknown aggregate result types deliberately remain uncast so PostgreSQL can
 * infer them from the expression.
 */
function resolveHavingAggregatePgType(
	functionName: string,
	column: string,
	ctx: CompilerContext,
): string | undefined {
	const aggregate = functionName.toLowerCase();
	if (aggregate === 'count') return 'bigint';
	const argumentType = resolveColumnPgType(column, ctx);
	if (aggregate === 'min' || aggregate === 'max') return argumentType;
	if (argumentType === undefined) return undefined;
	const normalized = argumentType.toLowerCase().replace(/\s+/g, ' ').trim();
	if (aggregate === 'sum') {
		if (/^(smallint|int2|integer|int|int4)$/.test(normalized)) return 'bigint';
		if (/^(bigint|int8|numeric|decimal)$/.test(normalized)) return 'numeric';
		if (/^(real|float4)$/.test(normalized)) return 'real';
		if (/^(double precision|float8)$/.test(normalized)) {
			return 'double precision';
		}
		if (normalized === 'money') return 'money';
		return undefined;
	}
	if (aggregate === 'avg') {
		if (
			/^(smallint|int2|integer|int|int4|bigint|int8|numeric|decimal)$/.test(
				normalized,
			)
		) {
			return 'numeric';
		}
		if (/^(real|float4|double precision|float8)$/.test(normalized)) {
			return 'double precision';
		}
		if (normalized === 'interval') return 'interval';
	}
	return undefined;
}
