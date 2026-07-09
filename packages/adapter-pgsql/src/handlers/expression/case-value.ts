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
type CaseExpressionHandler = (expr: Record<string, unknown>) => Node;

/**
 * Expression-intent kinds that compileExpressionIntent renders and that are
 * valid as a standalone CASE branch value. Mirrors the relevant arm of the
 * switch in handlers/expression/custom.ts, excluding the kinds this file
 * handles inline (param, literal, column, arithmetic, case) AND the
 * function-call-context-only kinds (`star`, `namedArg`) that are not valid
 * standalone expressions — those must not render as a bare `*` / `name => ...`
 * inside a CASE.
 */
const EXPRESSION_HANDLER_KINDS = new Set<string>([
	'customOp',
	'customFn',
	'ref',
	'cast',
	'unary',
	'array',
	'subquery',
	'relationColumn',
]);

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
	expressionHandler?: CaseExpressionHandler,
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
				expressionHandler,
			);
			const right = resolveCaseValue(
				expr.right,
				alias,
				schema,
				naming,
				state,
				nestedCaseHandler,
				expressionHandler,
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
			// Route the expression kinds that the shared expression compiler
			// (compileExpressionIntent, handlers/expression/custom.ts) renders —
			// customFn, customOp, ref, cast, unary, namedArg, star, array,
			// subquery, relationColumn — through it, so functions, operators,
			// column refs and arrays emit as SQL instead of binding the intent
			// object as a parameter. Keep EXPRESSION_HANDLER_KINDS in sync with
			// that switch. Kinds it does NOT render (function / coalesce /
			// aggregate / json* / window) still bind as parameters here; rendering
			// the full expression surface inside CASE branches is tracked
			// separately. Scalars without a `kind` also bind as parameters.
			if (
				expressionHandler &&
				typeof expr.kind === 'string' &&
				EXPRESSION_HANDLER_KINDS.has(expr.kind)
			) {
				return expressionHandler(expr);
			}
			return bindParameter(value, state);
		}
	}
}
