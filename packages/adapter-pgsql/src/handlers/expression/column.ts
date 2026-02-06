/**
 * Column Expression Handlers
 *
 * Handles: column references, column aliases
 *
 * Produces ColumnRef and ResTarget nodes for SELECT lists.
 */

import type { Node, ResTarget } from '@pgsql/types';
import { columnRef } from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	ExpressionHandler,
} from '../types.js';

/**
 * Column reference handler
 *
 * Produces: table.column or alias.column
 */
export const columnHandler: ExpressionHandler = {
	types: ['column', 'col', 'field'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		const column = decision.column;
		if (!column) {
			throw new Error('Column handler requires column');
		}

		const alias = ctx.currentAlias ?? ctx.rootTable;
		return columnRef(column, alias, undefined, ctx.naming);
	},
};

/**
 * Column alias handler
 *
 * Produces: expression AS alias (for SELECT list)
 * Returns a ResTarget node.
 */
export const columnAliasHandler: ExpressionHandler = {
	types: ['columnAlias', 'as', 'alias'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		const column = decision.column;
		const outputAlias = decision.alias;

		if (!column) {
			throw new Error('Column alias handler requires column');
		}

		const tableAlias = ctx.currentAlias ?? ctx.rootTable;
		const colRef = columnRef(column, tableAlias, undefined, ctx.naming);

		// If no alias specified, return just the column reference
		if (!outputAlias) {
			return colRef;
		}

		// Wrap in ResTarget with alias for SELECT list
		const resTarget: ResTarget = {
			val: colRef,
			name: ctx.naming.toDatabase(outputAlias),
		};

		return { ResTarget: resTarget };
	},
};

/**
 * Star (all columns) handler
 *
 * Produces: table.* or *
 */
export const starHandler: ExpressionHandler = {
	types: ['star', '*', 'all'],

	compile(
		_decision: Decision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		const tableAlias = ctx.currentAlias ?? ctx.rootTable;

		// table.* — qualified star
		return {
			ColumnRef: {
				fields: [
					{ String: { sval: ctx.naming.toDatabase(tableAlias) } },
					{ A_Star: {} },
				],
			},
		};
	},
};
