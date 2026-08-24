/** Normalize source facts shared by SQL emission and managed-step declarations. */
const STRICT_INTEGER = /^[+-]?\d+$/;
const POSTGRES_SEQUENCE_MIN = -9223372036854775808n;
const POSTGRES_SEQUENCE_MAX = 9223372036854775807n;
const POSTGRES_SEQUENCE_MAX_DIGITS = '9223372036854775807';
const POSTGRES_SEQUENCE_MIN_DIGITS = '9223372036854775808';

/** Refuse the one PostgreSQL sequence integer which is syntactically valid but unusable. */
export function assertNonZeroSequenceIncrement(
	value: string | undefined,
	context: string,
): void {
	if (value === '0')
		throw new Error(`${context}: sequence increment must be non-zero`);
}

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
	// Bound the lexical domain before parsing: hostile decimal strings must not
	// allocate an arbitrarily large BigInt merely to be refused.
	if (
		digits.length > POSTGRES_SEQUENCE_MAX_DIGITS.length ||
		(digits.length === POSTGRES_SEQUENCE_MAX_DIGITS.length &&
			((negative && digits > POSTGRES_SEQUENCE_MIN_DIGITS) ||
				(!negative && digits > POSTGRES_SEQUENCE_MAX_DIGITS)))
	)
		throw new Error(`${context}: outside PostgreSQL sequence bounds`);
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
