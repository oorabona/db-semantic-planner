/**
 * CASE Expression Handler
 *
 * Handles: CASE WHEN ... THEN ... ELSE ... END
 *
 * Produces CaseExpr nodes.
 */

import type { ExpressionIntent } from '@dbsp/types';
import type { CaseExpr, CaseWhen, Node } from '@pgsql/types';
import { columnRef } from '../../ast-helpers.js';
import { unwrapParamIntent } from '../../param-intent.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	ExpressionHandler,
} from '../types.js';
import { resolveCaseValue as resolveCaseValueShared } from './case-value.js';
import { compileExpressionIntent } from './custom.js';
import { bindParameter } from './param-value.js';

/**
 * Case condition structure
 */
interface CaseCondition {
	when: Decision;
	then: unknown;
}

/** Adapter: route CompilerContext fields to the shared resolveCaseValue signature. */
function resolveCaseValue(
	value: unknown,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	const alias = ctx.currentAlias ?? ctx.rootTable;
	return resolveCaseValueShared(
		value,
		alias,
		undefined,
		ctx.naming,
		state,
		undefined,
		// Handler-level path: renders every expression kind via the shared
		// expression compiler. Any customFn FILTER modifier is applied when the
		// caller-provided CompilerContext supplies compileCustomFnFilter.
		(expr) =>
			compileExpressionIntent(expr as unknown as ExpressionIntent, ctx, state),
	);
}

export const caseHandler: ExpressionHandler = {
	types: ['case', 'CASE', 'caseWhen'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		// CASE decisions carry { when: Decision; then: unknown } tuples in `conditions`,
		// which is structurally different from the base Decision[]. The planner
		// guarantees this shape at runtime for expressionType === 'case'.
		const conditions = decision.conditions as
			| readonly CaseCondition[]
			| undefined;
		const elseValue = decision.value;

		if (!conditions || conditions.length === 0) {
			throw new Error('CASE requires at least one WHEN condition');
		}

		// Import WHERE dispatcher for compiling WHEN conditions
		// Note: We need to avoid circular dependencies
		const { createWhereDispatcher } = require('../index.js');
		const dispatch = createWhereDispatcher();

		const args: Node[] = conditions.map((cond) => {
			// Compile the WHEN condition
			const whenExpr = dispatch(cond.when, ctx, state);

			// Build the THEN result using expression-aware resolution
			const thenResult = resolveCaseValue(cond.then, ctx, state);

			const caseWhen: CaseWhen = {
				expr: whenExpr,
				result: thenResult,
			};

			return { CaseWhen: caseWhen };
		});

		// Build ELSE clause if present
		let defresult: Node | undefined;
		if (elseValue !== undefined) {
			defresult = resolveCaseValue(elseValue, ctx, state);
		}

		const caseExpr: CaseExpr = {
			args,
			...(defresult && { defresult }),
		};

		return { CaseExpr: caseExpr };
	},
};

/**
 * Simple CASE expression handler
 *
 * CASE expr WHEN value1 THEN result1 ... END
 */
export const simpleCaseHandler: ExpressionHandler = {
	types: ['simpleCase', 'simpleCaseWhen'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const column = decision.column;
		// Same structural override as in caseHandler — see above.
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

		const tableAlias = ctx.currentAlias ?? ctx.rootTable;
		const testExpr = columnRef(column, tableAlias, undefined, ctx.naming);

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
