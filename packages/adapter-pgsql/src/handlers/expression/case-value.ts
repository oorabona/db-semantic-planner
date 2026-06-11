/**
 * Shared CASE value resolver.
 *
 * Resolves THEN/ELSE values in CASE expressions to AST nodes.
 * Used by both the compiler (compileCaseValue) and the DX handler (resolveCaseValue).
 */

import type { Node } from '@pgsql/types';
import {
	booleanConstNode,
	columnRef,
	floatNode,
	integerNode,
	nullConstNode,
} from '../../ast-helpers.js';
import type { NamingPlugin } from '../../naming-plugin.js';
import type { CompilerState } from '../types.js';
import { bindParameter } from './param-value.js';

/**
 * Optional handler for nested CASE expressions.
 * The compiler provides this to delegate back to compileCaseExpression;
 * the DX handler omits it (nested CASE falls through to default parameterization).
 */
type NestedCaseHandler = (expr: Record<string, unknown>) => Node;

/**
 * Resolve a CASE THEN/ELSE value to an AST node.
 *
 * Handles ExpressionIntent objects (column, literal, arithmetic, nested case)
 * and plain scalars (string → column ref, number/boolean → literal or param).
 */
export function resolveCaseValue(
	value: unknown,
	alias: string,
	schema: string | undefined,
	naming: NamingPlugin | undefined,
	state: CompilerState,
	nestedCaseHandler?: NestedCaseHandler,
): Node {
	if (value === null || value === undefined) {
		return nullConstNode();
	}

	if (typeof value === 'string') {
		return columnRef(value, alias, schema, naming);
	}

	if (typeof value !== 'object') {
		return bindParameter(value, state);
	}

	const expr = value as Record<string, unknown>;
	switch (expr.kind) {
		case 'param':
			return bindParameter(expr.value, state);

		case 'literal':
			if (expr.value === null || expr.value === undefined)
				return nullConstNode();
			if (typeof expr.value === 'boolean')
				return booleanConstNode(expr.value as boolean);
			if (typeof expr.value === 'number') {
				if (Number.isInteger(expr.value))
					return integerNode(expr.value as number);
				return floatNode(String(expr.value));
			}
			return bindParameter(expr.value, state);

		case 'column':
			return columnRef(expr.column as string, alias, schema, naming);

		case 'arithmetic': {
			const left = resolveCaseValue(
				expr.left,
				alias,
				schema,
				naming,
				state,
				nestedCaseHandler,
			);
			const right = resolveCaseValue(
				expr.right,
				alias,
				schema,
				naming,
				state,
				nestedCaseHandler,
			);
			return {
				A_Expr: {
					kind: 'AEXPR_OP',
					name: [{ String: { sval: expr.operator as string } }],
					lexpr: left,
					rexpr: right,
				},
			};
		}

		// biome-ignore lint/suspicious/noFallthroughSwitchClause: intentional — no nested handler → parameterize via default
		case 'case':
			if (nestedCaseHandler) {
				return nestedCaseHandler(expr);
			}
		// falls through
		default: {
			return bindParameter(value, state);
		}
	}
}
