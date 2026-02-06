/**
 * Aggregate Function Expression Handlers
 *
 * Handles: COUNT, SUM, AVG, MIN, MAX, and custom aggregates
 *
 * Produces FuncCall nodes with aggregate options.
 */

import type { Node } from '@pgsql/types';
import { columnRef } from '../../ast-helpers.js';
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
): Node {
	const isCountStar = funcName === 'count' && (!column || column === '*');

	if (isCountStar) {
		// COUNT(*)
		return {
			FuncCall: {
				funcname: [{ String: { sval: 'count' } }],
				agg_star: true,
			},
		};
	}

	if (!column) {
		throw new Error(`Aggregate ${funcName} requires a column`);
	}

	const tableAlias = ctx.currentAlias ?? ctx.rootTable;
	const colRef = columnRef(column, tableAlias, undefined, ctx.naming);

	return {
		FuncCall: {
			funcname: [{ String: { sval: funcName.toLowerCase() } }],
			args: [colRef],
			...(distinct && { agg_distinct: true }),
		},
	};
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
		return buildAggregate('count', column, distinct, ctx);
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
		return buildAggregate('count', column, true, ctx);
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
		return buildAggregate('sum', decision.column, false, ctx);
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
		return buildAggregate('avg', decision.column, false, ctx);
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
		return buildAggregate('min', decision.column, false, ctx);
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
		return buildAggregate('max', decision.column, false, ctx);
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
		return buildAggregate(funcName, decision.column, false, ctx);
	},
};
