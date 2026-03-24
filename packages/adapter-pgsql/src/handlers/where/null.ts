/**
 * Null Operators Handler
 *
 * Handles: isNull, isNotNull
 */

import type { Node, NullTest } from '@pgsql/types';
import type {
	CompilerContext,
	CompilerDecision,
	CompilerState,
	WhereHandler,
} from '../types.js';
import { NULL_OPERATORS } from '../types.js';
import { buildColumnRef } from './utils.js';

/**
 * Create a NullTest node
 */
function nullTestExpr(arg: Node, isNull: boolean): Node {
	const nullTest: NullTest = {
		arg,
		nulltesttype: isNull ? 'IS_NULL' : 'IS_NOT_NULL',
	};

	return { NullTest: nullTest };
}

/**
 * Null operators handler (IS NULL, IS NOT NULL)
 */
export const nullHandler: WhereHandler = {
	operators: [NULL_OPERATORS.IS_NULL, NULL_OPERATORS.IS_NOT_NULL],

	compile(
		decision: CompilerDecision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		const operator = decision.operator ?? 'isNull';
		const column = decision.column;

		if (!column) {
			throw new Error('Null handler requires a column');
		}

		const columnNode = buildColumnRef(column, ctx);

		if (operator === NULL_OPERATORS.IS_NULL || operator === 'isNull') {
			return nullTestExpr(columnNode, true);
		}

		return nullTestExpr(columnNode, false);
	},
};
