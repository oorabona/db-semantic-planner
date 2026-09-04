/** Resolve a WHERE operator without consulting Object.prototype. */
export function resolveWhereOperator<T>(
	operator: string | undefined,
	operators: Readonly<Record<string, T>>,
): T;
export function resolveWhereOperator(
	operator: string | undefined,
	aliases: Readonly<Record<string, string>>,
	registered: ReadonlyMap<string, unknown>,
): string;
export function resolveWhereOperator<T>(
	operator: string | undefined,
	operators: Readonly<Record<string, T>>,
	registered?: ReadonlyMap<string, unknown>,
): T | string {
	if (typeof operator === 'string' && operator.length > 0) {
		if (Object.hasOwn(operators, operator)) {
			return operators[operator]!;
		}
		if (registered?.has(operator)) {
			return operator;
		}
	}
	throw new Error(`No WHERE handler registered for operator: ${operator}`);
}
