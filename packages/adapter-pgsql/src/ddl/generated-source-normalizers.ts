/** Normalize source facts shared by SQL emission and managed-step declarations. */
const STRICT_INTEGER = /^[+-]?\d+$/;
const POSTGRES_SEQUENCE_MIN = -9223372036854775808n;
const POSTGRES_SEQUENCE_MAX = 9223372036854775807n;

/** Return one canonical base-10 spelling for an optional sequence integer. */
export function normalizeSequenceInteger(
	value: unknown,
	context: string,
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value))
			throw new Error(
				`${context}: expected a safe integer; use a strict decimal string for larger exact values`,
			);
		value = Object.is(value, -0) ? '0' : String(value);
	}
	if (typeof value !== 'string')
		throw new Error(
			`${context}: expected a finite number or numeric string, received ${typeof value}`,
		);
	if (!STRICT_INTEGER.test(value))
		throw new Error(`${context}: expected an integer or strict integer string`);
	const negative = value.startsWith('-');
	const digits = value.replace(/^[+-]?0*/, '') || '0';
	const normalized = digits === '0' ? '0' : negative ? `-${digits}` : digits;
	const integer = BigInt(normalized);
	if (integer < POSTGRES_SEQUENCE_MIN || integer > POSTGRES_SEQUENCE_MAX)
		throw new Error(`${context}: outside PostgreSQL sequence bounds`);
	return normalized;
}

/** Validate an optional source boolean before a DDL truthiness decision. */
export function normalizeOptionalBoolean(
	value: unknown,
	context: string,
): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'boolean')
		throw new Error(`${context}: expected a boolean`);
	return value;
}
