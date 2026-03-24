/**
 * BETWEEN Operator Handler
 *
 * Handles: between
 */

import type { Node } from '@pgsql/types';
import { createParamRef } from '../../param-ref.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereHandler,
} from '../types.js';
import { buildColumnRef } from './utils.js';

/**
 * BETWEEN operator handler
 *
 * Compiles: column BETWEEN $min AND $max
 */
export const betweenHandler: WhereHandler = {
	operators: ['between'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const column = decision.column;
		if (!column) {
			throw new Error('BETWEEN handler requires a column');
		}

		const range = decision.value as [unknown, unknown];
		if (!Array.isArray(range) || range.length !== 2) {
			throw new Error('BETWEEN condition requires [min, max] array');
		}

		const columnNode = buildColumnRef(column, ctx);

		const minIdx = ++state.paramIndex;
		state.parameters.push(range[0]);
		const minNode = createParamRef(minIdx);

		const maxIdx = ++state.paramIndex;
		state.parameters.push(range[1]);
		const maxNode = createParamRef(maxIdx);

		return {
			A_Expr: {
				kind: 'AEXPR_BETWEEN',
				name: [{ String: { sval: 'BETWEEN' } }],
				lexpr: columnNode,
				rexpr: { List: { items: [minNode, maxNode] } },
			},
		};
	},
};
