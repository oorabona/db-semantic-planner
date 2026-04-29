/**
 * Redact sensitive values in a query dump's `params` array before logging.
 *
 * Defense-in-depth helper: when application code may have inserted PII as
 * literal parameter values (e.g. an email in a WHERE clause), this replaces
 * any string value matching a configured pattern with the `replacement`
 * placeholder. Non-string values are passed through unchanged.
 */

export type RedactionPattern = string | RegExp;

export type RedactionConfig = {
	/** Patterns to match against string param values. String = substring (case-insensitive); RegExp = `.test()`. */
	readonly patterns: ReadonlyArray<RedactionPattern>;
	/** Placeholder substituted for matched values. Default `'[REDACTED]'`. */
	readonly replacement?: string;
};

/**
 * Curated regex set for common PII shapes. Match against the value itself
 * (not the column name), so they detect data shaped like an email / token /
 * credit-card / SSN regardless of which `$N` slot it landed in.
 *
 * @stable Adding entries is non-breaking; removing one is a semver-major change
 *   because callers may rely on a specific shape being redacted.
 */
export const DEFAULT_REDACTION_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
	/^[^@\s]+@[^@\s]+\.[^@\s]+$/, // email
	/^Bearer\s+[A-Za-z0-9._-]+$/i, // bearer token
	/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, // JWT
	/^\d{3}-\d{2}-\d{4}$/, // US SSN
	/^(?:\d[ -]?){13,19}$/, // credit card (13-19 digits, optional spaces/dashes)
	/^sk-[A-Za-z0-9]{20,}$/, // OpenAI-style API key
	/^[A-Fa-f0-9]{32,}$/, // hex secret (32+ chars)
]);

const DEFAULT_REPLACEMENT = '[REDACTED]';

/**
 * Returns a NEW array of params with sensitive string values replaced.
 * The input array is never mutated. Non-string values pass through unchanged.
 */
export function redactParams(
	params: readonly unknown[],
	config: RedactionConfig,
): unknown[] {
	const replacement = config.replacement ?? DEFAULT_REPLACEMENT;
	return params.map((value) =>
		matchesAnyPattern(value, config.patterns) ? replacement : value,
	);
}

function matchesAnyPattern(
	value: unknown,
	patterns: ReadonlyArray<RedactionPattern>,
): boolean {
	if (typeof value !== 'string') return false;
	for (const pattern of patterns) {
		if (typeof pattern === 'string') {
			if (
				pattern.length > 0 &&
				value.toLowerCase().includes(pattern.toLowerCase())
			)
				return true;
		} else if (pattern.test(value)) {
			return true;
		}
	}
	return false;
}
