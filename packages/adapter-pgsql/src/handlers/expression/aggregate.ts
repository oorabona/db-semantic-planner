/**
 * Aggregate Function Expression Handlers
 *
 * Handles: COUNT, SUM, AVG, MIN, MAX, and custom aggregates
 *
 * Produces FuncCall nodes with aggregate options.
 */

import type { Node } from '@pgsql/types';
import { columnRef, funcCall } from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	ExpressionHandler,
} from '../types.js';

// Aggregate handlers for COUNT, SUM, AVG, MIN, MAX

/**
 * Build an aggregate function call
 */
function buildAggregate(
	funcName: string,
	column: string | undefined,
	distinct: boolean,
	ctx: CompilerContext,
	filterNode?: Node,
): Node {
	const isCountStar = funcName === 'count' && (!column || column === '*');

	if (isCountStar) {
		return funcCall(funcName, [], {
			star: true,
			...(filterNode && { filter: filterNode }),
		});
	}

	if (!column) {
		throw new Error(`Aggregate ${funcName} requires a column`);
	}

	const tableAlias = ctx.currentAlias ?? ctx.rootTable;
	const colRef = columnRef(column, tableAlias, undefined, ctx.naming);

	return funcCall(funcName, [colRef], {
		distinct,
		...(filterNode && { filter: filterNode }),
	});
}

/**
 * COUNT handler
 *
 * Produces: COUNT(*) or COUNT(column) or COUNT(DISTINCT column)
 */
export const countHandler: ExpressionHandler = {
	types: ['count', 'COUNT'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		const column = decision.column;
		const distinct =
			decision.operator === 'countDistinct' || Boolean(decision.args?.[0]);
		return buildAggregate('count', column, distinct, ctx, decision.filterWhere);
	},
};

/**
 * COUNT DISTINCT handler
 */
export const countDistinctHandler: ExpressionHandler = {
	types: ['countDistinct', 'COUNT_DISTINCT'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		const column = decision.column;
		if (!column) {
			throw new Error('COUNT DISTINCT requires a column');
		}
		return buildAggregate('count', column, true, ctx, decision.filterWhere);
	},
};

/**
 * SUM handler
 */
export const sumHandler: ExpressionHandler = {
	types: ['sum', 'SUM'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		return buildAggregate('sum', decision.column, false, ctx, decision.filterWhere);
	},
};

/**
 * AVG handler
 */
export const avgHandler: ExpressionHandler = {
	types: ['avg', 'AVG', 'average'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		return buildAggregate('avg', decision.column, false, ctx, decision.filterWhere);
	},
};

/**
 * MIN handler
 */
export const minHandler: ExpressionHandler = {
	types: ['min', 'MIN'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		return buildAggregate('min', decision.column, false, ctx, decision.filterWhere);
	},
};

/**
 * MAX handler
 */
export const maxHandler: ExpressionHandler = {
	types: ['max', 'MAX'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		return buildAggregate('max', decision.column, false, ctx, decision.filterWhere);
	},
};

/**
 * Generic aggregate handler for custom aggregates
 */
export const genericAggregateHandler: ExpressionHandler = {
	types: ['aggregate', 'agg'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		const funcName = decision.function;
		if (!funcName) {
			throw new Error('Generic aggregate requires function name');
		}
		return buildAggregate(funcName, decision.column, false, ctx, decision.filterWhere);
	},
};
