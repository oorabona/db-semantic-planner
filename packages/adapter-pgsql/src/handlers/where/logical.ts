/**
 * Logical Operators Handler
 *
 * Handles: and, or, not
 */

import type { Node } from '@pgsql/types';
import {
	andExpr,
	booleanConstNode,
	notExpr,
	orExpr,
} from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereDispatcher,
	WhereHandler,
} from '../types.js';
import { LOGICAL_OPERATORS } from '../types.js';

/**
 * AND operator handler
 */
export const andHandler: WhereHandler = {
	operators: [LOGICAL_OPERATORS.AND],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
		dispatch: WhereDispatcher,
	): Node {
		const conditions = decision.conditions;

		if (!conditions || !Array.isArray(conditions)) {
			throw new Error('AND handler requires conditions array');
		}

		// Empty AND is always true
		if (conditions.length === 0) {
			return booleanConstNode(true);
		}

		// Single condition doesn't need AND
		if (conditions.length === 1) {
			return dispatch(conditions[0]!, ctx, state);
		}

		// Compile all conditions recursively
		const compiledConditions = conditions.map((condition) =>
			dispatch(condition, ctx, state),
		);

		return andExpr(...compiledConditions);
	},
};

/**
 * OR operator handler
 */
export const orHandler: WhereHandler = {
	operators: [LOGICAL_OPERATORS.OR],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
		dispatch: WhereDispatcher,
	): Node {
		const conditions = decision.conditions;

		if (!conditions || !Array.isArray(conditions)) {
			throw new Error('OR handler requires conditions array');
		}

		// Empty OR is always false
		if (conditions.length === 0) {
			return booleanConstNode(false);
		}

		// Single condition doesn't need OR
		if (conditions.length === 1) {
			return dispatch(conditions[0]!, ctx, state);
		}

		// Compile all conditions recursively
		const compiledConditions = conditions.map((condition) =>
			dispatch(condition, ctx, state),
		);

		return orExpr(...compiledConditions);
	},
};

/**
 * NOT operator handler
 *
 * Note: NOT takes a single condition in `conditions[0]`
 */
export const notHandler: WhereHandler = {
	operators: [LOGICAL_OPERATORS.NOT],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
		dispatch: WhereDispatcher,
	): Node {
		const conditions = decision.conditions;

		if (!conditions || conditions.length === 0) {
			throw new Error('NOT handler requires a condition in conditions[0]');
		}

		// NOT wraps the first condition
		const compiledCondition = dispatch(conditions[0]!, ctx, state);

		return notExpr(compiledCondition);
	},
};
