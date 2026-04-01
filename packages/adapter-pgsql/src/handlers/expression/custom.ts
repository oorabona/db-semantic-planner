/**
 * Custom Expression Handler
 *
 * Handles generic expression intents: customOp, customFn, ref, param, cast, literal, unary.
 * Core function: compileExpressionIntent — recursive dispatcher used by SELECT, WHERE, ORDER BY.
 */

import type {
	AggOrderByArg,
	ArrayExpressionIntent,
	CastExpressionIntent,
	CustomFnExpressionIntent,
	CustomOpExpressionIntent,
	ExpressionIntent,
	LiteralExpressionIntent,
	NamedArgExpressionIntent,
	ParamExpressionIntent,
	RefExpressionIntent,
	SubqueryExpressionIntent,
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
	sortBy,
	typeCast,
} from '../../ast-helpers.js';
import { createParamRef } from '../../param-ref.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	ExpressionHandler,
	WhereDispatcher,
} from '../types.js';

// ---------------------------------------------------------------------------
// Deferred WHERE compiler injection
// ---------------------------------------------------------------------------
// custom.ts is loaded early (compile-where.ts imports it). handlers/index.ts
// is loaded later and has a transitive dep back through custom.ts. To compile
// CASE WHEN conditions we need createWhereDispatcher (from handlers/index.ts)
// but cannot import it statically (circular) or via require() (ESM package).
//
// Solution: compile-where.ts (which imports BOTH custom.ts and handlers/index.ts)
// calls registerWhereDispatcherFactory() once after both modules are loaded.
// By the time any CASE expression is compiled, the factory is always set.
// ---------------------------------------------------------------------------
let _whereDispatcherFactory: (() => WhereDispatcher) | undefined;

/** Called by compile-where.ts after both modules are fully initialized. */
export function registerWhereDispatcherFactory(
	factory: () => WhereDispatcher,
): void {
	_whereDispatcherFactory = factory;
}

function _createWhereDispatcher(): WhereDispatcher {
	if (!_whereDispatcherFactory) {
		throw new Error(
			'compileExpressionIntent (case): WHERE dispatcher not initialized. ' +
				'Ensure compile-where.ts is imported before any CASE expression is compiled.',
		);
	}
	return _whereDispatcherFactory();
}

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
			// Compile aggOrderBy entries into SortBy nodes for agg_order.
			const orderByNodes =
				i.aggOrderBy && i.aggOrderBy.length > 0
					? i.aggOrderBy.map((ob: AggOrderByArg) => {
							const colNode = columnRef(
								ob.field,
								undefined,
								undefined,
								ctx.naming,
							);
							return sortBy(colNode, ob.direction === 'desc' ? 'DESC' : 'ASC');
						})
					: undefined;
			// Note: FILTER (WHERE ...) on customFn is applied at the compiler level
			// (selectCustomExpression branch in compiler.ts) to avoid circular deps.
			return funcCall(nameParts, argNodes, {
				...(orderByNodes ? { orderBy: orderByNodes } : {}),
			});
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

		case 'subquery': {
			const sq = intent as SubqueryExpressionIntent;
			if (!ctx.compileSubquery) {
				throw new Error(
					"compileExpressionIntent: 'subquery' expression kind requires ctx.compileSubquery to be set. " +
						'Use asExpr() only in .columns() context, not in standalone expressions.',
				);
			}
			const { ast: innerAst, parameters: innerParams } = ctx.compileSubquery(
				sq.query,
				state.paramIndex,
			);
			// Append inner parameters to outer state (shared array, appended in order)
			for (const p of innerParams) {
				state.parameters.push(p);
			}
			state.paramIndex += innerParams.length;
			// Wrap the inner SelectStmt in a SubLink (scalar subquery expression)
			return {
				SubLink: {
					subLinkType: 'EXPR_SUBLINK',
					subselect: innerAst,
				},
			} as unknown as Node;
		}

		case 'relationColumn': {
			// Produced by relationColumn(relation, column, as) — ORDER BY a joined relation's column.
			// Alias lookup: state.aliases may be empty for expression-scoped states;
			// fall back to the relation name itself (which is used as the SQL JOIN alias).
			const rc = intent as unknown as {
				relation: string;
				column: string;
				as: string;
			};
			const alias = state.aliases.get(rc.relation) ?? rc.relation;
			return columnRef(rc.column, alias, undefined, ctx.naming);
		}

		case 'case': {
			// CaseExpressionIntent: CASE WHEN condition THEN result [...] [ELSE default] END
			// createWhereDispatcher is imported at module top level. The circular dep with
			// handlers/index.ts is safe because ESM live bindings resolve before any function
			// is called (no top-level calls in either module).
			const dispatch = _createWhereDispatcher();

			const caseIntent = intent as import('@dbsp/types').CaseExpressionIntent;

			if (!caseIntent.when || caseIntent.when.length === 0) {
				throw new Error('CASE expression requires at least one WHEN clause');
			}

			const caseArgs: Node[] = caseIntent.when.map((branch) => {
				// dispatch accepts WhereIntent (via normalizeToDecision which handles `kind` field)
				const whenNode = dispatch(
					branch.condition as unknown as import('../types.js').Decision,
					ctx,
					state,
				);
				const thenNode = compileExpressionIntent(branch.result, ctx, state);
				return {
					CaseWhen: { expr: whenNode, result: thenNode },
				} as unknown as Node;
			});

			let defresult: Node | undefined;
			if (caseIntent.else !== undefined) {
				defresult = compileExpressionIntent(caseIntent.else, ctx, state);
			}

			return {
				CaseExpr: {
					args: caseArgs,
					...(defresult !== undefined ? { defresult } : {}),
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
