/**
 * CASE Expression Handler
 *
 * Handles: CASE WHEN ... THEN ... ELSE ... END
 *
 * Produces CaseExpr nodes.
 */

import type { CaseExpr, CaseWhen, Node } from '@pgsql/types';
import { columnRef, nullConstNode } from '../../ast-helpers.js';
import { createParamRef } from '../../param-ref.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	ExpressionHandler,
} from '../types.js';

/**
 * Case condition structure
 */
interface CaseCondition {
	when: Decision;
	then: unknown;
}

/**
 * Build a CASE expression
 *
 * CASE WHEN condition1 THEN result1
 *      WHEN condition2 THEN result2
 *      ELSE default
 * END
 */
/**
 * Resolve a CASE THEN/ELSE value to an AST node.
 * Handles ExpressionIntent objects (column, literal, arithmetic, null)
 * and plain scalars.
 */
function resolveCaseValue(
	value: unknown,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	if (value === null || value === undefined) {
		return nullConstNode();
	}

	if (typeof value === 'string') {
		// String operand = column reference
		const alias = ctx.currentAlias ?? ctx.rootTable;
		return columnRef(value, alias, ctx.schema, ctx.naming);
	}

	if (typeof value !== 'object') {
		// Numeric/boolean literal → parameterize
		const idx = ++state.paramIndex;
		state.parameters.push(value);
		return createParamRef(idx);
	}

	const expr = value as Record<string, unknown>;
	switch (expr.kind) {
		case 'literal':
			if (expr.value === null || expr.value === undefined)
				return nullConstNode();
			{
				const idx = ++state.paramIndex;
				state.parameters.push(expr.value);
				return createParamRef(idx);
			}

		case 'column': {
			const alias = ctx.currentAlias ?? ctx.rootTable;
			return columnRef(expr.column as string, alias, ctx.schema, ctx.naming);
		}

		case 'arithmetic': {
			const left = resolveCaseValue(expr.left, ctx, state);
			const right = resolveCaseValue(expr.right, ctx, state);
			return {
				A_Expr: {
					kind: 'AEXPR_OP',
					name: [{ String: { sval: expr.operator as string } }],
					lexpr: left,
					rexpr: right,
				},
			};
		}

		default: {
			// Unknown object → parameterize
			const idx = ++state.paramIndex;
			state.parameters.push(value);
			return createParamRef(idx);
		}
	}
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
		const testExpr = columnRef(column, tableAlias, ctx.schema, ctx.naming);

		const args: Node[] = conditions.map((cond) => {
			// Build the comparison value — `when` may be a Decision with .value
			// or a primitive; extract the raw value for parameterization.
			const whenParamNumber = ++state.paramIndex;
			const whenDecision = cond.when as Decision & { value?: unknown };
			state.parameters.push(whenDecision.value ?? cond.when);
			const whenExpr = createParamRef(whenParamNumber);

			// Build the THEN result
			const thenParamNumber = ++state.paramIndex;
			state.parameters.push(cond.then);
			const thenResult = createParamRef(thenParamNumber);

			const caseWhen: CaseWhen = {
				expr: whenExpr,
				result: thenResult,
			};

			return { CaseWhen: caseWhen };
		});

		// Build ELSE clause if present
		let defresult: Node | undefined;
		if (elseValue !== undefined) {
			const paramNumber = ++state.paramIndex;
			state.parameters.push(elseValue);
			defresult = createParamRef(paramNumber);
		}

		const caseExpr: CaseExpr = {
			arg: testExpr,
			args,
			...(defresult && { defresult }),
		};

		return { CaseExpr: caseExpr };
	},
};
