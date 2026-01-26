/**
 * @module errors
 * Error types for the Kysely adapter.
 */

/**
 * Valid SQL identifier pattern.
 * - Starts with letter or underscore
 * - Contains only letters, numbers, underscores
 * - Max 63 characters (PostgreSQL limit)
 */
const VALID_IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

/**
 * Thrown when schema name fails validation
 */
export class InvalidIdentifierError extends Error {
	readonly identifier: string;

	constructor(identifier: string, message?: string) {
		super(message ?? `Invalid identifier: ${identifier}`);
		this.name = 'InvalidIdentifierError';
		this.identifier = identifier;
		Object.setPrototypeOf(this, InvalidIdentifierError.prototype);
	}
}

/**
 * Validate a SQL identifier (schema name, table name, etc.).
 * Throws InvalidIdentifierError if invalid.
 *
 * @param identifier - The identifier to validate
 * @param type - The type of identifier for error messages (default: 'identifier')
 * @throws InvalidIdentifierError if the identifier is invalid
 *
 * @example
 * ```typescript
 * validateIdentifier('tenant_123', 'schema'); // OK
 * validateIdentifier('my-schema', 'schema'); // Throws: hyphens not allowed
 * validateIdentifier('123abc', 'schema'); // Throws: cannot start with number
 * ```
 */
export function validateIdentifier(
	identifier: string,
	type: string = 'identifier',
): void {
	if (!identifier || typeof identifier !== 'string') {
		throw new InvalidIdentifierError(
			identifier,
			`Invalid ${type}: must be a non-empty string`,
		);
	}

	if (!VALID_IDENTIFIER_PATTERN.test(identifier)) {
		throw new InvalidIdentifierError(
			identifier,
			`Invalid ${type}: "${identifier}" must start with a letter or underscore, contain only alphanumeric characters and underscores, and be at most 63 characters`,
		);
	}
}

/**
 * Thrown by findFirstOrThrow when no results
 */
export class NotFoundError extends Error {
	readonly table: string;

	constructor(table: string) {
		super(`No record found in ${table}`);
		this.name = 'NotFoundError';
		this.table = table;
		Object.setPrototypeOf(this, NotFoundError.prototype);
	}
}

/**
 * Thrown when compilation fails
 */
export class CompilationError extends Error {
	override readonly cause: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = 'CompilationError';
		this.cause = cause;
		Object.setPrototypeOf(this, CompilationError.prototype);
	}
}
