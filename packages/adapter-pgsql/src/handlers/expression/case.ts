/**
 * CASE Expression Handler
 *
 * Handles: CASE WHEN ... THEN ... ELSE ... END
 *
 * Produces CaseExpr nodes.
 */

import type { CaseExpr, CaseWhen, Node } from '@pgsql/types';
import { unwrapParamIntent } from '../../param-intent.js';
import type {
	CompilerState,
	Decision,
	ExpressionCompilerContext,
	ExpressionHandler,
} from '../types.js';
import { expressionColumnRef } from '../types.js';
import { bindParameter } from './param-value.js';

/**
 * Case condition structure
 */
interface CaseCondition {
	when: Decision;
	then: unknown;
}

/**
 * Simple CASE expression handler
 *
 * CASE expr WHEN value1 THEN result1 ... END
 */
export const simpleCaseHandler: ExpressionHandler = {
	types: ['simpleCase', 'simpleCaseWhen'],

	compile(
		decision: Decision,
		ctx: ExpressionCompilerContext,
		state: CompilerState,
	): Node {
		const column = decision.column;
		// CASE decisions carry tuples in `conditions`, structurally different from Decision[].
		const conditions = decision.conditions as
			| readonly CaseCondition[]
			| undefined;
		const elseValue = decision.value;

		if (!column) {
			throw new Error('Simple CASE requires a column');
		}

		if (!conditions || conditions.length === 0) {
			throw new Error('Simple CASE requires at least one WHEN condition');
		}

		const testExpr = expressionColumnRef(column, ctx);

		const args: Node[] = conditions.map((cond) => {
			// Build the comparison value — `when` may be a Decision with .value
			// or a primitive; extract the raw value for parameterization.
			const whenDecision = cond.when as Decision & { value?: unknown };
			const whenExpr = bindParameter(
				unwrapParamIntent(whenDecision.value ?? cond.when),
				state,
			);

			// Build the THEN result
			const thenResult = bindParameter(unwrapParamIntent(cond.then), state);

			const caseWhen: CaseWhen = {
				expr: whenExpr,
				result: thenResult,
			};

			return { CaseWhen: caseWhen };
		});

		// Build ELSE clause if present
		let defresult: Node | undefined;
		if (elseValue !== undefined) {
			defresult = bindParameter(unwrapParamIntent(elseValue), state);
		}

		const caseExpr: CaseExpr = {
			arg: testExpr,
			args,
			...(defresult && { defresult }),
		};

		return { CaseExpr: caseExpr };
	},
};
