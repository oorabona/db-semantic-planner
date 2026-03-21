/**
 * Custom Expression Handler
 *
 * Handles generic expression intents: customOp, customFn, ref, param, cast, literal, unary.
 * Core function: compileExpressionIntent — recursive dispatcher used by SELECT, WHERE, ORDER BY.
 */

import type {
	ArrayExpressionIntent,
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
			// Note: FILTER (WHERE ...) on customFn is applied at the compiler level
			// (selectCustomExpression branch in compiler.ts) to avoid circular deps.
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
			const nae = intent as NamedArgExpressionIntent;
			const argNode = compileExpressionIntent(nae.value, ctx, state);
			// NamedArgExpr is a valid PostgreSQL AST node but not included in @pgsql/types Node union.
			// The internal deparser handles it correctly. Cast through unknown is safe here.
			return {
				NamedArgExpr: {
					arg: argNode,
					name: nae.name,
					argnumber: -1,
				},
			} as unknown as Node;
		}

		case 'star':
			// ColumnRef with A_Star field — deparseColumnRef renders it as *
			// When passed to fn(), funcCall() puts it in args → count(*) etc.
			return {
				ColumnRef: { fields: [{ A_Star: {} }] },
			} as unknown as Node;

		case 'array': {
			const ae = intent as ArrayExpressionIntent;
			const elements = ae.elements.map((el) =>
				compileExpressionIntent(el, ctx, state),
			);
			return { A_ArrayExpr: { elements } } as unknown as Node;
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

/**
 * Compile a WhereIntent FILTER clause to an AST Node for use in customFn expressions.
 *
 * Uses require() for createWhereDispatcher and convertWhereCondition to avoid circular
 * dependencies (compiler.ts → custom.ts). The PlanDecision from convertWhereCondition
 * is structurally compatible with Decision for simple filter conditions.
 */
/**
 * Compile a WhereIntent FILTER clause to an AST Node for use in customFn expressions.
 *
 * Uses direct imports (not require()) — both are safe:
 * - handlers/index.ts does not import custom.ts (no circular dep)
 * - intent-to-decisions.ts imports PlanDecision from compiler.ts as `import type` only
 *   (type-only imports have no runtime circular dep in ESM)
 */
/**
 * Compile a WhereIntent FILTER clause to an AST Node for use in customFn expressions.
 *
 * Uses direct import for convertWhereCondition (safe: intent-to-decisions.ts only has
 * `import type` from compiler.ts, no runtime circular dep).
 *
 * Uses require() for createWhereDispatcher to avoid circular initialization:
 *   handlers/index.ts → where/index.ts → custom-expression.ts → custom.ts
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
