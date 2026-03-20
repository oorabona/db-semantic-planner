/**
 * Custom Expression Handler
 *
 * Handles generic expression intents: customOp, customFn, ref, param, cast, literal, unary.
 * Core function: compileExpressionIntent — recursive dispatcher used by SELECT, WHERE, ORDER BY.
 */

import type {
	CastExpressionIntent,
	CustomFnExpressionIntent,
	CustomOpExpressionIntent,
	ExpressionIntent,
	LiteralExpressionIntent,
	NamedArgExpressionIntent,
	ParamExpressionIntent,
	RefExpressionIntent,
	UnaryExpressionIntent,
} from '@dbsp/types';
import type { Node } from '@pgsql/types';
import {
	booleanConstNode,
	columnRef,
	floatNode,
	funcCall,
	integerNode,
	nullConstNode,
	typeCast,
} from '../../ast-helpers.js';
import { createParamRef } from '../../param-ref.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	ExpressionHandler,
} from '../types.js';

/**
 * Recursively compile an ExpressionIntent into a PostgreSQL AST Node.
 *
 * Handles all custom expression kinds: customOp, customFn, ref, param, cast, literal, unary.
 * This function is shared by SELECT, WHERE, and ORDER BY compilation paths.
 */
export function compileExpressionIntent(
	intent: ExpressionIntent,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	const kind = intent.kind;

	switch (kind) {
		case 'customOp': {
			const i = intent as CustomOpExpressionIntent;
			const leftNode = compileExpressionIntent(i.left, ctx, state);
			const rightNode = compileExpressionIntent(i.right, ctx, state);
			return {
				A_Expr: {
					kind: 'AEXPR_OP',
					name: [{ String: { sval: i.operator } }],
					lexpr: leftNode,
					rexpr: rightNode,
				},
			};
		}

		case 'customFn': {
			const i = intent as CustomFnExpressionIntent;
			// Schema-qualified: 'schema.func' → [String(schema), String(func)]
			const nameParts = i.name.split('.');
			const argNodes = i.args.map((arg) =>
				compileExpressionIntent(arg, ctx, state),
			);
			return funcCall(nameParts, argNodes);
		}

		case 'ref': {
			const i = intent as RefExpressionIntent;
			// Support 'table.column' dotted notation
			const dotIdx = i.column.indexOf('.');
			if (dotIdx !== -1) {
				const table = i.column.slice(0, dotIdx);
				const col = i.column.slice(dotIdx + 1);
				return columnRef(col, table, undefined, ctx.naming);
			}
			return columnRef(i.column, undefined, undefined, ctx.naming);
		}

		case 'param': {
			const i = intent as ParamExpressionIntent;
			const idx = ++state.paramIndex;
			state.parameters.push(i.value);
			return createParamRef(idx);
		}

		case 'cast': {
			const i = intent as CastExpressionIntent;
			const argNode = compileExpressionIntent(i.expr, ctx, state);
			return typeCast(argNode, i.typeName);
		}

		case 'literal': {
			const i = intent as LiteralExpressionIntent;
			if (i.value === null || i.value === undefined) {
				return nullConstNode();
			}
			if (typeof i.value === 'boolean') {
				return booleanConstNode(i.value);
			}
			if (typeof i.value === 'number') {
				if (Number.isInteger(i.value)) {
					return integerNode(i.value);
				}
				return floatNode(String(i.value));
			}
			if (typeof i.value === 'string') {
				return {
					A_Const: { sval: { sval: i.value } },
				};
			}
			// Fallback: convert to string literal
			return {
				A_Const: { sval: { sval: String(i.value) } },
			};
		}

		case 'unary': {
			const i = intent as UnaryExpressionIntent;
			const operandNode = compileExpressionIntent(i.operand, ctx, state);
			return {
				A_Expr: {
					kind: 'AEXPR_OP',
					name: [{ String: { sval: i.operator } }],
					rexpr: operandNode,
				},
			};
		}

		case 'namedArg': {
			const i = intent as NamedArgExpressionIntent;
			const argNode = compileExpressionIntent(i.value, ctx, state);
			// PostgreSQL NamedArgExpr AST node
			return {
				NamedArgExpr: {
					arg: argNode,
					name: i.name,
					argnumber: -1,
				},
			} as unknown as Node;
		}

		default: {
			throw new Error(
				`compileExpressionIntent: unsupported expression kind '${kind}'`,
			);
		}
	}
}

/**
 * Expression handler for custom expression intents in SELECT.
 * Dispatches customOp, customFn, ref, param, cast, unary to compileExpressionIntent.
 */
export const customExpressionHandler: ExpressionHandler = {
	types: [
		'customOp',
		'customFn',
		'ref',
		'param',
		'cast',
		'unary',
		'customExpression',
	],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const expressionIntent = decision.expressionIntent as ExpressionIntent;
		return compileExpressionIntent(expressionIntent, ctx, state);
	},
};
