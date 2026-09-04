/** Resolve a WHERE operator without consulting Object.prototype. */
export function resolveWhereOperator<T>(
	operator: string | undefined,
	operators: Readonly<Record<string, T>>,
): T;
export function resolveWhereOperator<T>(
	operator: string | undefined,
	operators: Readonly<Record<string, T>>,
	fallback: T,
): T;
export function resolveWhereOperator<T>(
	operator: string | undefined,
	operators: Readonly<Record<string, T>>,
	fallback?: T,
): T {
	if (operator !== undefined && Object.hasOwn(operators, operator)) {
		return operators[operator]!;
	}
	if (fallback !== undefined) return fallback;
	throw new Error(`No WHERE handler registered for operator: ${operator}`);
}
