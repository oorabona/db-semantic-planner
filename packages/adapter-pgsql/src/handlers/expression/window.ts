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
	Decision,
	ExpressionHandler,
} from '../types.js';

/**
 * Build a SortBy node for ORDER BY clause
 */
function buildSortBy(
	column: string,
	direction: 'ASC' | 'DESC' | undefined,
	ctx: CompilerContext,
): Node {
	const tableAlias = ctx.currentAlias ?? ctx.rootTable;
	const colRef = columnRef(column, tableAlias, ctx.schema, ctx.naming);

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
function buildWindowDef(decision: Decision, ctx: CompilerContext): WindowDef {
	const partition = decision.partition;
	const orderBy = decision.orderBy;
	const frame = decision.frame;

	const tableAlias = ctx.currentAlias ?? ctx.rootTable;

	const windowDef: WindowDef = {};

	// PARTITION BY
	if (partition && partition.length > 0) {
		windowDef.partitionClause = partition.map((col) =>
			columnRef(col, tableAlias, ctx.schema, ctx.naming),
		);
	}

	// ORDER BY
	if (orderBy && orderBy.length > 0) {
		windowDef.orderClause = orderBy.map((item) =>
			buildSortBy(item.column, item.direction, ctx),
		);
	}

	// Frame clause (ROWS/RANGE BETWEEN ... AND ...)
	// For simplicity, we use a predefined frame or default
	if (frame) {
		// Parse frame string like "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW"
		// This would need more complex parsing - for now, we skip it
		// and let PostgreSQL use defaults
	}

	return windowDef;
}

/**
 * Build a window function call
 */
function buildWindowFunction(
	funcName: string,
	args: Node[],
	decision: Decision,
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
 * ROW_NUMBER() handler
 *
 * ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)
 */
export const rowNumberHandler: ExpressionHandler = {
	types: ['rowNumber', 'ROW_NUMBER', 'row_number'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		return buildWindowFunction('row_number', [], decision, ctx);
	},
};

/**
 * RANK() handler
 */
export const rankHandler: ExpressionHandler = {
	types: ['rank', 'RANK'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		return buildWindowFunction('rank', [], decision, ctx);
	},
};

/**
 * DENSE_RANK() handler
 */
export const denseRankHandler: ExpressionHandler = {
	types: ['denseRank', 'DENSE_RANK', 'dense_rank'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		return buildWindowFunction('dense_rank', [], decision, ctx);
	},
};

/**
 * NTILE(n) handler
 */
export const ntileHandler: ExpressionHandler = {
	types: ['ntile', 'NTILE'],

	compile(
		decision: Decision,
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
 * LAG(column, offset, default) handler
 */
export const lagHandler: ExpressionHandler = {
	types: ['lag', 'LAG'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const column = decision.column;
		if (!column) {
			throw new Error('LAG requires a column');
		}

		const tableAlias = ctx.currentAlias ?? ctx.rootTable;
		const colRef = columnRef(column, tableAlias, ctx.schema, ctx.naming);

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

		return buildWindowFunction('lag', args, decision, ctx);
	},
};

/**
 * LEAD(column, offset, default) handler
 */
export const leadHandler: ExpressionHandler = {
	types: ['lead', 'LEAD'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const column = decision.column;
		if (!column) {
			throw new Error('LEAD requires a column');
		}

		const tableAlias = ctx.currentAlias ?? ctx.rootTable;
		const colRef = columnRef(column, tableAlias, ctx.schema, ctx.naming);

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

		return buildWindowFunction('lead', args, decision, ctx);
	},
};

/**
 * FIRST_VALUE(column) handler
 */
export const firstValueHandler: ExpressionHandler = {
	types: ['firstValue', 'FIRST_VALUE', 'first_value'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		const column = decision.column;
		if (!column) {
			throw new Error('FIRST_VALUE requires a column');
		}

		const tableAlias = ctx.currentAlias ?? ctx.rootTable;
		const colRef = columnRef(column, tableAlias, ctx.schema, ctx.naming);

		return buildWindowFunction('first_value', [colRef], decision, ctx);
	},
};

/**
 * LAST_VALUE(column) handler
 */
export const lastValueHandler: ExpressionHandler = {
	types: ['lastValue', 'LAST_VALUE', 'last_value'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		const column = decision.column;
		if (!column) {
			throw new Error('LAST_VALUE requires a column');
		}

		const tableAlias = ctx.currentAlias ?? ctx.rootTable;
		const colRef = columnRef(column, tableAlias, ctx.schema, ctx.naming);

		return buildWindowFunction('last_value', [colRef], decision, ctx);
	},
};

/**
 * Generic window function handler
 */
export const genericWindowHandler: ExpressionHandler = {
	types: ['window', 'windowFunc'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const funcName = decision.function;
		if (!funcName) {
			throw new Error('Window function requires function name');
		}

		const args: Node[] = [];

		// Add column if specified
		if (decision.column) {
			const tableAlias = ctx.currentAlias ?? ctx.rootTable;
			args.push(columnRef(decision.column, tableAlias, ctx.schema, ctx.naming));
		}

		// Add other args
		if (decision.args && Array.isArray(decision.args)) {
			for (const arg of decision.args) {
				const paramNumber = ++state.paramIndex;
				state.parameters.push(arg);
				args.push(createParamRef(paramNumber));
			}
		}

		return buildWindowFunction(funcName, args, decision, ctx);
	},
};
