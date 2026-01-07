/**
 * @module errors
 * Error types for the Kysely adapter.
 */

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
	readonly cause: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = 'CompilationError';
		this.cause = cause;
		Object.setPrototypeOf(this, CompilationError.prototype);
	}
}
