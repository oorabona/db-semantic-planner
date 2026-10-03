/** Only syntactic null is rewritten; bound parameter values stay opaque. */
import type { Node } from '@pgsql/types';
import { distinctExpr, nullConstNode } from '../../ast-helpers.js';
import { escapeDiagnosticText } from '../../validate.js';

export function compileLiteralNullComparison(
	operator: string | undefined,
	left: Node,
	value: unknown,
): Node | undefined {
	if (value === undefined) {
		throw new Error(
			'Right comparison operand is undefined; use isNull or param(...)',
		);
	}
	if (value !== null) return undefined;
	if (operator === 'isDistinctFrom') return distinctExpr(left, nullConstNode());
	if (operator === 'eq' || operator === '=') {
		return { NullTest: { arg: left, nulltesttype: 'IS_NULL' } };
	}
	if (
		operator === 'neq' ||
		operator === 'ne' ||
		operator === '!=' ||
		operator === '<>'
	) {
		return { NullTest: { arg: left, nulltesttype: 'IS_NOT_NULL' } };
	}
	throw new Error(
		`Operator ${escapeDiagnosticText(String(operator))} cannot compare with literal null; use isNull/isNotNull`,
	);
}
