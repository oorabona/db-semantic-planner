/**
 * COALESCE Expression Handler
 *
 * Handles: COALESCE(val1, val2, ...) - returns first non-NULL value
 *
 * Produces CoalesceExpr nodes.
 */

import type { CoalesceExpr, Node } from '@pgsql/types';
import { columnRef } from '../../ast-helpers.js';
import { createParamRef } from '../../param-ref.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	ExpressionHandler,
} from '../types.js';

/**
 * Build a value node from a decision argument
 */
function buildValueNode(
	value: unknown,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	// If it's a column reference
	if (typeof value === 'string' && !value.includes(' ')) {
		const tableAlias = ctx.currentAlias ?? ctx.rootTable;
		return columnRef(value, tableAlias, ctx.schema, ctx.naming);
	}

	// If it's a decision with type 'column'
	if (typeof value === 'object' && value !== null && 'type' in value) {
		const decision = value as Decision;
		if (decision.type === 'column' && decision.column) {
			const tableAlias = ctx.currentAlias ?? ctx.rootTable;
			return columnRef(decision.column, tableAlias, ctx.schema, ctx.naming);
		}
	}

	// Otherwise, parameterize it
	const paramNumber = ++state.paramIndex;
	state.parameters.push(value);
	return createParamRef(paramNumber);
}

/**
 * COALESCE handler
 *
 * Returns the first non-NULL argument.
 * COALESCE(a, b, c) = first non-null of a, b, c
 */
export const coalesceHandler: ExpressionHandler = {
	types: ['coalesce', 'COALESCE', 'ifNull', 'nvl'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const args = decision.args;
		const column = decision.column;
		const defaultValue = decision.value;

		// Build argument list
		const argNodes: Node[] = [];

		// If column is specified, add it first
		if (column) {
			const tableAlias = ctx.currentAlias ?? ctx.rootTable;
			argNodes.push(columnRef(column, tableAlias, ctx.schema, ctx.naming));
		}

		// Add args array if present
		if (args && Array.isArray(args)) {
			for (const arg of args) {
				argNodes.push(buildValueNode(arg, ctx, state));
			}
		}

		// Add default value if present
		if (defaultValue !== undefined) {
			argNodes.push(buildValueNode(defaultValue, ctx, state));
		}

		if (argNodes.length === 0) {
			throw new Error('COALESCE requires at least one argument');
		}

		const coalesceExpr: CoalesceExpr = {
			args: argNodes,
		};

		return { CoalesceExpr: coalesceExpr };
	},
};

/**
 * NULLIF handler
 *
 * Returns NULL if the two arguments are equal, otherwise returns the first.
 * NULLIF(a, b) = CASE WHEN a = b THEN NULL ELSE a END
 */
export const nullIfHandler: ExpressionHandler = {
	types: ['nullIf', 'NULLIF'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const column = decision.column;
		const value = decision.value;

		if (!column) {
			throw new Error('NULLIF requires a column');
		}

		if (value === undefined) {
			throw new Error('NULLIF requires a comparison value');
		}

		const tableAlias = ctx.currentAlias ?? ctx.rootTable;
		const colRef = columnRef(column, tableAlias, ctx.schema, ctx.naming);

		const paramNumber = ++state.paramIndex;
		state.parameters.push(value);
		const valueRef = createParamRef(paramNumber);

		return {
			NullIfExpr: {
				args: [colRef, valueRef],
			},
		};
	},
};

/**
 * GREATEST handler
 *
 * Returns the greatest value from a list.
 */
export const greatestHandler: ExpressionHandler = {
	types: ['greatest', 'GREATEST'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const args = decision.args;

		if (!args || !Array.isArray(args) || args.length === 0) {
			throw new Error('GREATEST requires at least one argument');
		}

		const argNodes: Node[] = args.map((arg) => buildValueNode(arg, ctx, state));

		return {
			MinMaxExpr: {
				op: 'IS_GREATEST',
				args: argNodes,
			},
		};
	},
};

/**
 * LEAST handler
 *
 * Returns the least value from a list.
 */
export const leastHandler: ExpressionHandler = {
	types: ['least', 'LEAST'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const args = decision.args;

		if (!args || !Array.isArray(args) || args.length === 0) {
			throw new Error('LEAST requires at least one argument');
		}

		const argNodes: Node[] = args.map((arg) => buildValueNode(arg, ctx, state));

		return {
			MinMaxExpr: {
				op: 'IS_LEAST',
				args: argNodes,
			},
		};
	},
};
