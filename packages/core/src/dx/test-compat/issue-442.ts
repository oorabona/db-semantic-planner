/** Test-only compatibility boundary for #442. */
import type { ExpressionRef } from '../expressions.js';
import type { QueryBuilder } from '../query-builder-types.js';

type ExpressionWhere<TResult> = {
	where(condition: ExpressionRef): QueryBuilder<TResult>;
};

declare const builder: QueryBuilder<{ readonly id: number }>;
declare const expression: ExpressionRef;
export function verifyCompatibilityCanary(): void {
	// @ts-expect-error #442: public where() excludes ExpressionRef; remove this boundary when predicate-branded expressions are designed.
	builder.where(expression);
}

/** Test-only call through the runtime ExpressionRef branch. */
export function whereExpression<TResult>(
	builder: QueryBuilder<TResult>,
	condition: ExpressionRef,
): QueryBuilder<TResult> {
	return (builder as QueryBuilder<TResult> & ExpressionWhere<TResult>).where(
		condition,
	);
}
