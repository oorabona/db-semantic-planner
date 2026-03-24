/**
 * Window Function Expression Handlers
 *
 * Handles: ROW_NUMBER, RANK, DENSE_RANK, NTILE, LEAD, LAG, FIRST_VALUE, LAST_VALUE
 *
 * Produces FuncCall nodes with WindowDef (OVER clause).
 */

import type { Node, SortBy, WindowDef } from '@pgsql/types';
import { columnRef } from '../../ast-helpers.js';
import { createParamRef } from '../../param-ref.js';
import type {
	CompilerContext,
	CompilerState,
	CompilerDecision,
	ExpressionHandler,
} from '../types.js';

/**
 * Default window frame options for bare OVER() clause.
 * Value: FRAMEOPTION_NONDEFAULT | FRAMEOPTION_RANGE | FRAMEOPTION_BETWEEN |
 *        FRAMEOPTION_START_UNBOUNDED_PRECEDING | FRAMEOPTION_END_CURRENT_ROW
 * See: src/include/nodes/parsenodes.h in PostgreSQL source
 */
const WINDOW_FRAME_DEFAULT = 1034;

/**
 * Build a SortBy node for ORDER BY clause
 */
function buildSortBy(
	column: string,
	direction: 'ASC' | 'DESC' | undefined,
	ctx: CompilerContext,
): Node {
	const tableAlias = ctx.currentAlias ?? ctx.rootTable;
	const colRef = columnRef(column, tableAlias, undefined, ctx.naming);

	const sortBy: SortBy = {
		node: colRef,
		sortby_dir: direction === 'DESC' ? 'SORTBY_DESC' : 'SORTBY_ASC',
		sortby_nulls: 'SORTBY_NULLS_DEFAULT',
	};

	return { SortBy: sortBy };
}

/**
 * Build a WindowDef (OVER clause)
 */
function buildWindowDef(decision: CompilerDecision, ctx: CompilerContext): WindowDef {
	const partition = decision.partition;
	const orderBy = decision.orderBy;
	const frame = decision.frame;

	const tableAlias = ctx.currentAlias ?? ctx.rootTable;

	// frameOptions: WINDOW_FRAME_DEFAULT is the default implicit frame (NONDEFAULT
	// bit not set → no frame clause emitted by deparser). Required for the OVER()
	// clause to be emitted correctly even when there are no PARTITION BY or ORDER BY.
	const windowDef: WindowDef = { frameOptions: WINDOW_FRAME_DEFAULT };

	// PARTITION BY
	if (partition && partition.length > 0) {
		windowDef.partitionClause = partition.map((col) =>
			columnRef(col, tableAlias, undefined, ctx.naming),
		);
	}

	// ORDER BY
	if (orderBy && orderBy.length > 0) {
		windowDef.orderClause = orderBy.map((item) =>
			buildSortBy(item.column, item.direction, ctx),
		);
	}

	// Frame clause (ROWS/RANGE BETWEEN ... AND ...): skipped for now,
	// PostgreSQL uses defaults when frame is not explicitly set.
	if (frame) {
		// Future: parse and emit frame clause
		void frame;
	}

	return windowDef;
}

/**
 * Build a window function call
 */
function buildWindowFunction(
	funcName: string,
	args: Node[],
	decision: CompilerDecision,
	ctx: CompilerContext,
): Node {
	const windowDef = buildWindowDef(decision, ctx);

	return {
		FuncCall: {
			funcname: [{ String: { sval: funcName.toLowerCase() } }],
			...(args.length > 0 && { args }),
			over: windowDef,
		},
	};
}

/**
 * Factory for no-argument window function handlers (ROW_NUMBER, RANK, DENSE_RANK, etc.).
 * Produces: FUNC() OVER (PARTITION BY ... ORDER BY ...)
 */
function createNoArgWindowHandler(
	funcName: string,
	types: string[],
): ExpressionHandler {
	return {
		types,
		compile(
			decision: CompilerDecision,
			ctx: CompilerContext,
			_state: CompilerState,
		): Node {
			return buildWindowFunction(funcName, [], decision, ctx);
		},
	};
}

/** ROW_NUMBER() OVER (...) handler */
export const rowNumberHandler = createNoArgWindowHandler('row_number', [
	'rowNumber',
	'ROW_NUMBER',
	'row_number',
]);

/** RANK() OVER (...) handler */
export const rankHandler = createNoArgWindowHandler('rank', ['rank', 'RANK']);

/** DENSE_RANK() OVER (...) handler */
export const denseRankHandler = createNoArgWindowHandler('dense_rank', [
	'denseRank',
	'DENSE_RANK',
	'dense_rank',
]);

/**
 * NTILE(n) handler
 */
export const ntileHandler: ExpressionHandler = {
	types: ['ntile', 'NTILE'],

	compile(
		decision: CompilerDecision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const n = decision.value ?? decision.args?.[0] ?? 4;
		const paramNumber = ++state.paramIndex;
		state.parameters.push(n);
		const nRef = createParamRef(paramNumber);

		return buildWindowFunction('ntile', [nRef], decision, ctx);
	},
};

/**
 * Factory for LAG/LEAD-style window handlers: FUNC(column, offset, default) OVER (...).
 */
function createLagLeadHandler(
	funcName: string,
	types: string[],
): ExpressionHandler {
	const upperName = funcName.toUpperCase();
	return {
		types,
		compile(
			decision: CompilerDecision,
			ctx: CompilerContext,
			state: CompilerState,
		): Node {
			const column = decision.column;
			if (!column) {
				throw new Error(`${upperName} requires a column`);
			}

			const tableAlias = ctx.currentAlias ?? ctx.rootTable;
			const colRef = columnRef(column, tableAlias, undefined, ctx.naming);

			const args: Node[] = [colRef];

			// Optional offset (default 1)
			const offset = decision.args?.[0] ?? 1;
			const offsetParamNumber = ++state.paramIndex;
			state.parameters.push(offset);
			args.push(createParamRef(offsetParamNumber));

			// Optional default value
			if (decision.value !== undefined) {
				const defaultParamNumber = ++state.paramIndex;
				state.parameters.push(decision.value);
				args.push(createParamRef(defaultParamNumber));
			}

			return buildWindowFunction(funcName, args, decision, ctx);
		},
	};
}

/** LAG(column, offset, default) OVER (...) handler */
export const lagHandler = createLagLeadHandler('lag', ['lag', 'LAG']);

/** LEAD(column, offset, default) OVER (...) handler */
export const leadHandler = createLagLeadHandler('lead', ['lead', 'LEAD']);

/**
 * Factory for single-column window value handlers (FIRST_VALUE, LAST_VALUE).
 * Produces: FUNC(column) OVER (...)
 */
function createColumnWindowHandler(
	funcName: string,
	types: string[],
): ExpressionHandler {
	const upperName = funcName.toUpperCase();
	return {
		types,
		compile(
			decision: CompilerDecision,
			ctx: CompilerContext,
			_state: CompilerState,
		): Node {
			const column = decision.column;
			if (!column) {
				throw new Error(`${upperName} requires a column`);
			}

			const tableAlias = ctx.currentAlias ?? ctx.rootTable;
			const colRef = columnRef(column, tableAlias, undefined, ctx.naming);

			return buildWindowFunction(funcName, [colRef], decision, ctx);
		},
	};
}

/** FIRST_VALUE(column) OVER (...) handler */
export const firstValueHandler = createColumnWindowHandler('first_value', [
	'firstValue',
	'FIRST_VALUE',
	'first_value',
]);

/** LAST_VALUE(column) OVER (...) handler */
export const lastValueHandler = createColumnWindowHandler('last_value', [
	'lastValue',
	'LAST_VALUE',
	'last_value',
]);

/**
 * Generic window function handler
 */
export const genericWindowHandler: ExpressionHandler = {
	types: ['window', 'windowFunc'],

	compile(
		decision: CompilerDecision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const funcName = decision.function;
		if (!funcName) {
			throw new Error('Window function requires function name');
		}

		// count() without a column → count(*) using agg_star
		const isCountStar =
			funcName.toLowerCase() === 'count' &&
			!decision.column &&
			(!decision.args || decision.args.length === 0);

		if (isCountStar) {
			const windowDef = buildWindowDef(decision, ctx);
			return {
				FuncCall: {
					funcname: [{ String: { sval: 'count' } }],
					agg_star: true,
					over: windowDef,
				},
			};
		}

		const args: Node[] = [];

		// Add column if specified
		if (decision.column) {
			const tableAlias = ctx.currentAlias ?? ctx.rootTable;
			args.push(columnRef(decision.column, tableAlias, undefined, ctx.naming));
		}

		// Add other args (e.g., offset for lag/lead)
		if (decision.args && Array.isArray(decision.args)) {
			for (const arg of decision.args) {
				const paramNumber = ++state.paramIndex;
				state.parameters.push(arg);
				args.push(createParamRef(paramNumber));
			}
		}

		// Add default value for lag/lead
		if (decision.value !== undefined) {
			const defaultParamNumber = ++state.paramIndex;
			state.parameters.push(decision.value);
			args.push(createParamRef(defaultParamNumber));
		}

		return buildWindowFunction(funcName, args, decision, ctx);
	},
};
