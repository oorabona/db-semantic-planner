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
	const isStarColumn = !column || column === '*';

	// PostgreSQL does not support DISTINCT on a star aggregate (COUNT(DISTINCT *)
	// is a syntax error, and '*' has no columns to deduplicate on for any other
	// aggregate). Fail clearly rather than silently dropping DISTINCT.
	if (distinct && isStarColumn) {
		throw new Error(
			`${funcName}(DISTINCT *) is not valid SQL — PostgreSQL does not support ` +
				'DISTINCT on a star aggregate; provide a specific column.',
		);
	}

	const isCountStar = funcName === 'count' && isStarColumn;

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
	let colRef: Node;
	if (column.includes('.')) {
		const dotIdx = column.indexOf('.');
		const table = column.slice(0, dotIdx);
		const col = column.slice(dotIdx + 1);
		colRef = columnRef(col, table, undefined, ctx.naming);
	} else {
		colRef = columnRef(column, tableAlias, undefined, ctx.naming);
	}

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
		// NOTE: previously also treated any truthy decision.args?.[0] as a distinct
		// signal. No production lowering path sets `args` on a count decision for
		// that purpose (args is used by unrelated decision shapes, e.g. selectNqlFunction),
		// so that clause was an unsound heuristic — a count(*) decision that happened
		// to carry an unrelated truthy args[0] would be misidentified as DISTINCT.
		// Explicit signals only: decision.distinct or operator === 'countDistinct'.
		const distinct =
			decision.distinct === true || decision.operator === 'countDistinct';
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
 * Factory for simple aggregate handlers (no distinct, column required).
 * Produces: FUNC(column) FILTER (WHERE ...)
 */
function createSimpleAggregateHandler(
	funcName: string,
	types: string[],
): ExpressionHandler {
	return {
		types,
		compile(
			decision: Decision,
			ctx: CompilerContext,
			_state: CompilerState,
		): Node {
			return buildAggregate(
				funcName,
				decision.column,
				decision.distinct === true,
				ctx,
				decision.filterWhere,
			);
		},
	};
}

/** SUM handler */
export const sumHandler = createSimpleAggregateHandler('sum', ['sum', 'SUM']);

/** AVG handler */
export const avgHandler = createSimpleAggregateHandler('avg', [
	'avg',
	'AVG',
	'average',
]);

/** MIN handler */
export const minHandler = createSimpleAggregateHandler('min', ['min', 'MIN']);

/** MAX handler */
export const maxHandler = createSimpleAggregateHandler('max', ['max', 'MAX']);

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
		return buildAggregate(
			funcName,
			decision.column,
			decision.distinct === true,
			ctx,
			decision.filterWhere,
		);
	},
};
