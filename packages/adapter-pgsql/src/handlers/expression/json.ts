/**
 * @module handlers/expression/json
 * Expression handlers for JSONB extraction in SELECT.
 */

import type { Node } from '@pgsql/types';
import { columnRef } from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	ExpressionHandler,
} from '../types.js';
import { compileValue } from '../where/utils.js';

/**
 * JSON extract: col->'key' or col->>'key' chains
 * Produces: "col"->'a'->'b'->>'c'
 */
export const jsonExtractHandler: ExpressionHandler = {
	types: ['jsonExtract'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const column = decision.column;
		if (!column) {
			throw new Error('JSON extract handler requires a column');
		}

		const path = (decision.args ?? []) as string[];
		const mode = decision.jsonMode ?? 'text';

		const alias = ctx.currentAlias ?? ctx.rootTable;
		let node: Node = columnRef(column, alias, undefined, ctx.naming);

		for (let i = 0; i < path.length; i++) {
			const isLast = i === path.length - 1;
			const op = isLast && mode === 'text' ? '->>' : '->';
			const keyNode = compileValue(path[i]!, state);
			node = {
				A_Expr: {
					kind: 'AEXPR_OP',
					name: [{ String: { sval: op } }],
					lexpr: node,
					rexpr: keyNode,
				},
			};
		}

		return node;
	},
};

/**
 * JSON path extract: col#>'{a,b}' or col#>>'{a,b}'
 * Produces: "col" #> $1 or "col" #>> $1
 */
export const jsonPathExtractHandler: ExpressionHandler = {
	types: ['jsonPathExtract'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const column = decision.column;
		if (!column) {
			throw new Error('JSON path extract handler requires a column');
		}

		const mode = decision.jsonMode ?? 'text';
		// args[0] is the pre-built PostgreSQL array literal '{a,b}'
		const arrayLiteral = (decision.args?.[0] as string) ?? '{}';

		const alias = ctx.currentAlias ?? ctx.rootTable;
		const left: Node = columnRef(column, alias, undefined, ctx.naming);
		const right = compileValue(arrayLiteral, state);
		const op = mode === 'text' ? '#>>' : '#>';

		return {
			A_Expr: {
				kind: 'AEXPR_OP',
				name: [{ String: { sval: op } }],
				lexpr: left,
				rexpr: right,
			},
		};
	},
};
