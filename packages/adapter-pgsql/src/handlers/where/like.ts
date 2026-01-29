/**
 * Pattern Operators Handler
 *
 * Handles: like, ilike
 */

import type { Node } from '@pgsql/types';
import { columnRef, ilikeExpr, likeExpr } from '../../ast-helpers.js';
import { createParamRef } from '../../param-ref.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereHandler,
} from '../types.js';
import { PATTERN_OPERATORS } from '../types.js';

/**
 * Build column reference from decision column
 */
function buildColumnRef(column: string, ctx: CompilerContext): Node {
	const alias = ctx.currentAlias ?? ctx.rootTable;
	return columnRef(column, alias, ctx.schema, ctx.naming);
}

/**
 * Build parameter reference and register value
 */
function buildParamRef(value: unknown, state: CompilerState): Node {
	state.paramIndex++;
	state.parameters.push(value);
	return createParamRef(state.paramIndex);
}

/**
 * Pattern operators handler (LIKE, ILIKE)
 */
export const likeHandler: WhereHandler = {
	operators: [PATTERN_OPERATORS.LIKE, PATTERN_OPERATORS.ILIKE],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const operator = decision.operator ?? 'like';
		const column = decision.column;
		const value = decision.value;

		if (!column) {
			throw new Error('Like handler requires a column');
		}

		const left = buildColumnRef(column, ctx);
		const right = buildParamRef(value, state);

		if (operator === PATTERN_OPERATORS.ILIKE || operator === 'ilike') {
			return ilikeExpr(left, right);
		}

		return likeExpr(left, right);
	},
};
