/**
 * @module identifier-validation
 * Validate SQL identifiers (schema, table, column names) in CLI commands.
 *
 * Mirrors the contract from packages/adapter-pgsql/src/validate.ts but kept
 * local to avoid a runtime dependency on the full adapter just for validation.
 *
 * Rules (PostgreSQL-compatible):
 *  1. Must not be empty
 *  2. Must not exceed 63 bytes (PostgreSQL NAMEDATALEN - 1)
 *  3. Must start with a letter (a-z, A-Z) or underscore
 *  4. Must contain only letters, digits, underscore, or dollar sign
 *  5. Must not contain NUL bytes or control characters
 */

/** Thrown when a string is not a valid SQL identifier. */
export class InvalidIdentifierError extends Error {
	constructor(
		public readonly value: string,
		public readonly identifierType: string,
		reason: string,
	) {
		super(`Invalid ${identifierType} identifier "${value}": ${reason}`);
		this.name = 'InvalidIdentifierError';
	}
}

const VALID_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;

/**
 * Validate that `value` is a safe SQL identifier.
 *
 * @param value - The string to validate
 * @param identifierType - Human-readable type label used in error messages
 *   (e.g. 'schema', 'table', 'column')
 * @throws {InvalidIdentifierError} if the value is not safe
 */
export function validateIdentifier(
	value: string,
	identifierType: string,
): void {
	if (!value || value.length === 0) {
		throw new InvalidIdentifierError(value, identifierType, 'cannot be empty');
	}

	// Rule 5: reject NUL bytes / control chars before length check
	// (NUL byte could be used to confuse downstream consumers)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — detecting control chars is the purpose of this regex
	if (/[\u0000-\u001f\u007f]/u.test(value)) {
		throw new InvalidIdentifierError(
			value,
			identifierType,
			'contains control characters or NUL byte',
		);
	}

	// Rule 2: PostgreSQL NAMEDATALEN is 64 bytes; max identifier = 63 bytes.
	// Buffer.byteLength gives accurate UTF-8 length (JS strings are UTF-16).
	const byteLen = Buffer.byteLength(value, 'utf8');
	if (byteLen > 63) {
		throw new InvalidIdentifierError(
			value,
			identifierType,
			`exceeds maximum length of 63 bytes (got ${byteLen})`,
		);
	}

	// Rules 3 & 4: character set
	if (!VALID_IDENTIFIER_RE.test(value)) {
		if (/^[0-9]/.test(value)) {
			throw new InvalidIdentifierError(
				value,
				identifierType,
				'cannot start with a digit',
			);
		}
		throw new InvalidIdentifierError(
			value,
			identifierType,
			'contains invalid characters (only letters, digits, underscore, and $ allowed)',
		);
	}
}
