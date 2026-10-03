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
 * the direct condition compiler but via the handler path.
 */

import type { QueryIntent } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import { notExpr } from '../../ast-helpers.js';
import {
	createSubqueryBuilder,
	type SubqueryConditionCompiler,
} from '../../condition-subquery.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereHandler,
} from '../types.js';

/**
 * WHERE handler for EXISTS / NOT EXISTS subquery predicates.
 *
 * Reads the inner QueryIntent from decision.expressionIntent, compiles it
 * via buildSubqueryFromIntent, wraps in a SubLink EXISTS node, and optionally
 * negates for 'rawNotExists'.
 */
export function createRawExistsHandler(
	compiler: SubqueryConditionCompiler,
): WhereHandler {
	const buildSubqueryFromIntent = createSubqueryBuilder(compiler);
	return {
		operators: ['rawExists', 'rawNotExists'],

		compile(
			decision: Decision,
			ctx: CompilerContext,
			state: CompilerState,
		): Node {
			const subIntent = decision.expressionIntent as QueryIntent;

			// The outer parameter state changes only after the builder returns.
			const {
				sql: subNode,
				paramCount,
				parameters: innerParams,
			} = buildSubqueryFromIntent(
				subIntent,
				state.paramIndex,
				ctx.declaredNames,
				ctx.schema,
				'rawExists',
				ctx.scope,
				ctx.dialectCapabilities,
				ctx.dbCasing,
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

			return decision.operator === 'rawNotExists' ? notExpr(subLink) : subLink;
		},
	};
}

/** Registry identity; a dispatcher replaces this with its compiler-backed handler. */
export const rawExistsHandler: WhereHandler = {
	operators: ['rawExists', 'rawNotExists'],
	compile() {
		throw new Error('raw EXISTS requires a compiler-backed dispatcher');
	},
};
