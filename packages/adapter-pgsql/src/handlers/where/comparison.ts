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
import { escapeDiagnosticText } from '../../validate.js';

/** The result type of an aggregate over an argument of the given type, when known. */
export function aggregateResultPgType(
	functionName: string,
	argumentType: string | undefined,
): string | undefined {
	const aggregate = functionName.toLowerCase();
	if (aggregate === 'count') return 'bigint';
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

/** Typed AST primitive shared by legacy and resolved comparison callers. */
export function compileComparison(
	operator: string,
	left: Node,
	right: Node,
): Node {
	switch (operator) {
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
}
