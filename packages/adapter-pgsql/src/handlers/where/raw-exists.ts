/**
 * Raw EXISTS / NOT EXISTS WHERE Handler
 *
 * Handles WHERE conditions using rawExists() and rawNotExists() —
 * EXISTS / NOT EXISTS wrappers around a QueryIntent subquery.
 *
 * Operators: 'rawExists', 'rawNotExists'
 * Pattern: [NOT] EXISTS (SELECT ... FROM ...)
 *
 * The inner QueryIntent is carried in decision.expressionIntent (operator
 * discriminates the kind so there is no collision with the 'expression' handler).
 *
 * Subquery compilation uses buildSubqueryFromIntent() directly — mirrors
 * handleRawExistsIntent in compile-where.ts but via the handler path.
 */

import type { QueryIntent } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import { notExpr } from '../../ast-helpers.js';
import { buildSubqueryFromIntent } from '../../compile-where.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereDispatcher,
	WhereHandler,
} from '../types.js';

/**
 * WHERE handler for EXISTS / NOT EXISTS subquery predicates.
 *
 * Reads the inner QueryIntent from decision.expressionIntent, compiles it
 * via buildSubqueryFromIntent, wraps in a SubLink EXISTS node, and optionally
 * negates for 'rawNotExists'.
 */
export const rawExistsHandler: WhereHandler = {
	operators: ['rawExists', 'rawNotExists'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
		_dispatch: WhereDispatcher,
	): Node {
		const subIntent = decision.expressionIntent as QueryIntent;

		const {
			sql: subNode,
			paramCount,
			parameters: innerParams,
		} = buildSubqueryFromIntent(
			subIntent,
			state.paramIndex,
			ctx.naming,
			ctx.schema,
		);

		if (innerParams) {
			for (const p of innerParams) {
				state.parameters.push(p);
			}
		}
		state.paramIndex += paramCount;

		const subLink = {
			SubLink: { subLinkType: 'EXISTS_SUBLINK', subselect: subNode },
		} as unknown as Node;

		return decision.operator === 'rawNotExists'
			? notExpr(subLink)
			: subLink;
	},
};
