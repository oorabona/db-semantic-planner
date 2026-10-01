/**
 * Column Expression Handlers
 *
 * Handles: column references, column aliases
 *
 * Produces ColumnRef and ResTarget nodes for SELECT lists.
 */

import type { Node } from '@pgsql/types';
import { sqlResTarget } from '../../ast-helpers.js';
import { queryLocal } from '../../sql-identifier.js';
import type {
	CompilerState,
	Decision,
	ExpressionCompilerContext,
	ExpressionHandler,
} from '../types.js';
import { expressionColumnRef, expressionColumnRefStar } from '../types.js';

/**
 * Column reference handler
 *
 * Produces: table.column or alias.column
 */
export const columnHandler: ExpressionHandler = {
	types: ['column', 'col', 'field'],

	compile(
		decision: Decision,
		ctx: ExpressionCompilerContext,
		_state: CompilerState,
	): Node {
		const column = decision.column;
		if (!column) {
			throw new Error('Column handler requires column');
		}

		return expressionColumnRef(column, ctx);
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
		ctx: ExpressionCompilerContext,
		_state: CompilerState,
	): Node {
		const column = decision.column;
		const outputAlias = decision.alias;

		if (!column) {
			throw new Error('Column alias handler requires column');
		}

		const colRef = expressionColumnRef(column, ctx);

		// If no alias specified, return just the column reference
		if (!outputAlias) {
			return colRef;
		}

		// Wrap in ResTarget with alias for SELECT list
		return sqlResTarget(colRef, queryLocal(outputAlias));
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
		ctx: ExpressionCompilerContext,
		_state: CompilerState,
	): Node {
		return expressionColumnRefStar(ctx);
	},
};
