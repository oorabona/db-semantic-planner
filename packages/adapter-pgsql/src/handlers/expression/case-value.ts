/**
 * Shared CASE value resolver.
 *
 * Resolves THEN/ELSE values in CASE expressions to AST nodes.
 * Used by both the compiler (compileCaseValue) and the DX handler (resolveCaseValue).
 */

import type { Node } from '@pgsql/types';
import {
	booleanConstNode,
	nullConstNode,
	sqlColumnRef,
} from '../../ast-helpers.js';
import { queryLocal } from '../../sql-identifier.js';
import type { CompilerState } from '../types.js';
import { numericLiteralNode } from './numeric-literal.js';
import { bindParameter } from './param-value.js';

/**
 * Optional handler for nested CASE expressions.
 * The compiler provides this to delegate back to compileCaseExpression;
 * without it, nested CASE delegates to the shared expression handler.
 */
type NestedCaseHandler = (expr: Record<string, unknown>) => Node;
type CaseExpressionHandler = (expr: Record<string, unknown>) => Node;
type CaseColumnHandler = (column: string) => Node;

/**
 * Resolve a CASE THEN/ELSE value to an AST node.
 *
 * Handles ExpressionIntent objects (column, literal, arithmetic, nested case)
 * and plain scalars (string → column ref, number/boolean → literal or param).
 */
export function resolveCaseValue(
	value: unknown,
	alias: string,
	_schema: string | undefined,
	resolveColumn: CaseColumnHandler | undefined,
	state: CompilerState,
	nestedCaseHandler?: NestedCaseHandler,
	expressionHandler?: CaseExpressionHandler,
): Node {
	if (value === null || value === undefined) {
		return nullConstNode();
	}

	if (typeof value === 'string') {
		return (
			resolveColumn?.(value) ??
			sqlColumnRef(queryLocal(value), queryLocal(alias))
		);
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
				return numericLiteralNode(expr.value);
			}
			return bindParameter(expr.value, state);

		case 'column':
			return (
				resolveColumn?.(expr.column as string) ??
				sqlColumnRef(queryLocal(expr.column as string), queryLocal(alias))
			);

		case 'arithmetic': {
			const operator = expr.operator;
			if (typeof operator !== 'string') {
				throw new Error(
					`Invalid arithmetic operator: expected a string, got ${typeof operator}. Operator must be a plain string value.`,
				);
			}
			if (!['+', '-', '*', '/', '%'].includes(operator)) {
				throw new Error(
					'Invalid arithmetic operator. Only +, -, *, /, % are allowed.',
				);
			}
			const left = resolveCaseValue(
				expr.left,
				alias,
				_schema,
				resolveColumn,
				state,
				nestedCaseHandler,
				expressionHandler,
			);
			const right = resolveCaseValue(
				expr.right,
				alias,
				_schema,
				resolveColumn,
				state,
				nestedCaseHandler,
				expressionHandler,
			);
			return {
				A_Expr: {
					kind: 'AEXPR_OP',
					name: [{ String: { sval: operator } }],
					lexpr: left,
					rexpr: right,
				},
			};
		}

		// biome-ignore lint/suspicious/noFallthroughSwitchClause: nested CASE delegates to the shared compiler
		case 'case':
			if (nestedCaseHandler) {
				return nestedCaseHandler(expr);
			}
		// Fall through to the shared compiler when no nested handler is supplied.
		default: {
			if (expressionHandler) {
				return expressionHandler(expr);
			}
			throw new Error(
				`resolveCaseValue: unsupported expression kind '${String(expr.kind)}'`,
			);
		}
	}
}
