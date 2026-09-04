/** Resolve a WHERE operator without consulting Object.prototype. */
export function resolveWhereOperator<T>(
	operator: string | undefined,
	operators: Readonly<Record<string, T>>,
): T;
export function resolveWhereOperator<T>(
	operator: string | undefined,
	operators: Readonly<Record<string, T>>,
): T {
	if (
		typeof operator === 'string' &&
		operator.length > 0 &&
		Object.hasOwn(operators, operator)
	) {
		return operators[operator]!;
	}
	throw new Error(`No WHERE handler registered for operator: ${operator}`);
}
