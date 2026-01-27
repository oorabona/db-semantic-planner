/**
 * @module compiler/handlers/expression/case
 * Handler for CASE expressions.
 */

import type {
	CaseExpressionIntent,
	ComparisonExpressionIntent,
	ExpressionIntent,
} from '@dbsp/core';
import type { ExpressionBuilder } from 'kysely';
import { CompilationError } from '../../../errors.js';
import type { CompilerContext, ExpressionHandler } from '../../types.js';

/**
 * Compile an expression to a Kysely-compatible value.
 * Handles column references and literals.
 */
function compileExpressionValue(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely's ExpressionBuilder has complex generics
	eb: ExpressionBuilder<any, any>,
	expr: ExpressionIntent,
	tableAlias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Return type depends on input
): any {
	switch (expr.kind) {
		case 'column':
			// Column reference: table.column
			// biome-ignore lint/suspicious/noExplicitAny: Dynamic column references
			return eb.ref(`${tableAlias}.${expr.column}` as any);

		case 'literal':
			// Literal value - use val() for strings, lit() for numbers/booleans/null
			if (typeof expr.value === 'string') {
				return eb.val(expr.value);
			}
			return eb.lit(expr.value as number | boolean | null);

		default:
			// For unsupported expression types, throw
			throw new CompilationError(
				`CASE expression does not support ${expr.kind} in results yet`,
			);
	}
}

/**
 * Compile a comparison expression for CASE WHEN condition.
 * Returns [left, operator, right] tuple for Kysely's when().
 */
function compileCondition(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely's ExpressionBuilder has complex generics
	eb: ExpressionBuilder<any, any>,
	expr: ExpressionIntent,
	tableAlias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Return type is a tuple for Kysely when()
): [any, string, unknown] {
	if (expr.kind === 'comparison') {
		const cmp = expr as ComparisonExpressionIntent;
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic column references
		const left = eb.ref(`${tableAlias}.${cmp.column}` as any);
		const op = cmp.operator;
		const right = cmp.value;
		return [left, op, right];
	}
	throw new CompilationError(
		`CASE WHEN requires comparison expression, got ${expr.kind}`,
	);
}

/**
 * Compiles a CASE expression.
 * CASE WHEN condition THEN result [WHEN ...] [ELSE default] END AS alias
 */
export const caseHandler: ExpressionHandler<CaseExpressionIntent> = (
	_ctx: CompilerContext,
	query,
	intent,
	alias,
) => {
	if (intent.when.length === 0) {
		throw new CompilationError('CASE requires at least one WHEN clause');
	}

	// Build CASE expression using Kysely's native case builder
	return query.select((eb) => {
		// Start case expression
		// biome-ignore lint/suspicious/noExplicitAny: Kysely case builder typing
		let caseExpr: any = eb.case();

		// Add each WHEN clause
		for (const whenClause of intent.when) {
			const [left, op, right] = compileCondition(
				eb,
				whenClause.condition,
				alias,
			);
			const result = compileExpressionValue(eb, whenClause.result, alias);

			caseExpr = caseExpr.when(left, op, right).then(result);
		}

		// Add ELSE clause if present
		if (intent.else) {
			const elseResult = compileExpressionValue(eb, intent.else, alias);
			caseExpr = caseExpr.else(elseResult);
		}

		// End and alias the expression
		return caseExpr.end().as(intent.as ?? 'case_result');
	});
};
