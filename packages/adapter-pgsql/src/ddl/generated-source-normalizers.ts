/** Normalize source facts shared by SQL emission and managed-step declarations. */
const STRICT_INTEGER = /^[+-]?\d+$/;

/** Return one canonical base-10 spelling for an optional sequence integer. */
export function normalizeSequenceInteger(
	value: unknown,
	context: string,
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || !Number.isInteger(value))
			throw new Error(`${context}: expected a finite integer`);
		return Object.is(value, -0) ? '0' : String(value);
	}
	if (typeof value !== 'string' && typeof value !== 'number')
		throw new Error(
			`${context}: expected a finite number or numeric string, received ${typeof value}`,
		);
	if (typeof value !== 'string' || !STRICT_INTEGER.test(value))
		throw new Error(`${context}: expected an integer or strict integer string`);
	const negative = value.startsWith('-');
	const digits = value.replace(/^[+-]?0*/, '') || '0';
	return digits === '0' ? '0' : negative ? `-${digits}` : digits;
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
