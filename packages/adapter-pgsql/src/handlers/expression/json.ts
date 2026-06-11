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
 * JSON path extract: col#>ARRAY['a','b'] or col#>>ARRAY['a','b}'
 * Produces: "col" #> $1 or "col" #>> $1
 */
function normalizeJsonPathArgs(args: readonly unknown[] | undefined): string[] {
	if (!args || args.length === 0) return [];
	if (args.length === 1) {
		const first = args[0];
		if (Array.isArray(first)) {
			return first.map((item) => String(item));
		}
		if (
			typeof first === 'string' &&
			first.startsWith('{') &&
			first.endsWith('}')
		) {
			const inner = first.slice(1, -1);
			return inner.length === 0 ? [] : inner.split(',');
		}
	}
	return args.map((item) => String(item));
}

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
		const path = normalizeJsonPathArgs(decision.args);

		const alias = ctx.currentAlias ?? ctx.rootTable;
		const left: Node = columnRef(column, alias, undefined, ctx.naming);
		const right = compileValue(path, state);
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
