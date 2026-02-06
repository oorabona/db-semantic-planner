/**
 * Error thrown when attempting to execute a query without a database configured.
 *
 * @example
 * ```typescript
 * const orm = createOrm({ model: schema, adapter: mockAdapter }); // Mock adapter
 * await orm.select('users').findMany(); // Throws ExecutionError (mock can't execute)
 * ```
 */
export class ExecutionError extends Error {
	override readonly name = 'ExecutionError' as const;

	/**
	 * The operation that was attempted.
	 */
	readonly operation: string;

	/**
	 * The reason the operation failed.
	 */
	readonly reason: string;

	/**
	 * How to fix the issue.
	 */
	readonly fix: string;

	constructor(opts: { operation: string; reason: string; fix: string }) {
		const message =
			`Cannot execute ${opts.operation}: ${opts.reason}\n\n` +
			`To fix: ${opts.fix}`;

		super(message);

		this.operation = opts.operation;
		this.reason = opts.reason;
		this.fix = opts.fix;

		Object.setPrototypeOf(this, ExecutionError.prototype);
	}
}

/**
 * Error thrown when firstOrThrow() finds no results.
 *
 * @example
 * ```typescript
 * await orm.select('users').where(eq('id', 999)).firstOrThrow();
 * // Throws NotFoundError: No record found for 'users'
 * ```
 */
export class NotFoundError extends Error {
	override readonly name = 'NotFoundError' as const;

	/**
	 * The table that was queried.
	 */
	readonly table: string;

	/**
	 * Optional: hint about the query that returned no results.
	 */
	readonly hint?: string;

	constructor(table: string, hint?: string) {
		const message = hint
			? `No record found for '${table}'. ${hint}`
			: `No record found for '${table}'`;

		super(message);
		this.table = table;
		if (hint !== undefined) {
			this.hint = hint;
		}
		Object.setPrototypeOf(this, NotFoundError.prototype);
	}
}

/**
 * Error thrown when strict mode is enabled and an ambiguous relation is detected.
 *
 * This error provides detailed information about the ambiguity and available options
 * for disambiguation.
 *
 * @example
 * ```typescript
 * try {
 *   orm.select('users').include('posts').plan();
 * } catch (error) {
 *   if (error instanceof AmbiguousRelationError) {
 *     console.log(error.options); // ['authoredPosts', 'reviewedPosts']
 *   }
 * }
 * ```
 */
export class AmbiguousRelationError extends Error {
	override readonly name = 'AmbiguousRelationError' as const;

	/**
	 * The source table where the ambiguous relation originates.
	 */
	readonly sourceTable: string;

	/**
	 * The target table that has multiple possible relations.
	 */
	readonly targetTable: string;

	/**
	 * Available relation names that can be used to disambiguate.
	 * Use one of these values with `{ via: 'relationName' }` to resolve the ambiguity.
	 */
	readonly options: readonly string[];

	constructor(
		sourceTable: string,
		targetTable: string,
		options: readonly string[],
	) {
		const optionsList = options.join(', ');
		const firstOption = options[0] ?? 'relationName';

		const message =
			`Ambiguous relation from '${sourceTable}' to '${targetTable}'.\n` +
			`Multiple relations found: ${optionsList}\n\n` +
			`To fix, specify which relation to use:\n` +
			`  .include('${targetTable}', { via: '${firstOption}' })\n\n` +
			`Or set a global hint in createOrm:\n` +
			`  createOrm({ db, relationHints: { ${targetTable}: '${firstOption}' } })`;

		super(message);

		this.sourceTable = sourceTable;
		this.targetTable = targetTable;
		this.options = options;

		// Required for proper instanceof checks when extending built-in classes
		// See: https://github.com/microsoft/TypeScript/wiki/FAQ#why-doesnt-extending-built-ins-like-error-array-and-map-work
		Object.setPrototypeOf(this, AmbiguousRelationError.prototype);
	}
}

/**
 * Finds the closest match to a target string from a list of candidates.
 * Uses Levenshtein distance for fuzzy matching.
 *
 * @example
 * ```typescript
 * findClosestMatch('usrs', ['users', 'posts', 'comments']); // 'users'
 * findClosestMatch('xyz', ['users', 'posts']); // undefined (no close match)
 * ```
 */
export function findClosestMatch(
	target: string,
	candidates: readonly string[],
): string | undefined {
	if (candidates.length === 0) return undefined;

	const targetLower = target.toLowerCase();
	let bestMatch: string | undefined;
	let bestScore = Number.POSITIVE_INFINITY;

	for (const candidate of candidates) {
		const candidateLower = candidate.toLowerCase();

		// Exact prefix match is best
		if (candidateLower.startsWith(targetLower)) {
			return candidate;
		}

		// Calculate simple distance (Levenshtein approximation for small strings)
		const distance = levenshteinDistance(targetLower, candidateLower);
		if (distance < bestScore && distance <= Math.max(target.length, 3)) {
			bestScore = distance;
			bestMatch = candidate;
		}
	}

	return bestMatch;
}

/**
 * Simple Levenshtein distance implementation.
 */
function levenshteinDistance(a: string, b: string): number {
	// Pre-initialize matrix with zeros
	const rows = b.length + 1;
	const cols = a.length + 1;
	const matrix: number[][] = [];

	for (let i = 0; i < rows; i++) {
		matrix[i] = new Array<number>(cols).fill(0);
	}

	// Initialize first column
	for (let i = 0; i < rows; i++) {
		const row = matrix[i];
		if (row) row[0] = i;
	}
	// Initialize first row
	const firstRow = matrix[0];
	if (firstRow) {
		for (let j = 0; j < cols; j++) {
			firstRow[j] = j;
		}
	}

	for (let i = 1; i < rows; i++) {
		const currentRow = matrix[i];
		const prevRow = matrix[i - 1];
		if (!currentRow || !prevRow) continue;

		for (let j = 1; j < cols; j++) {
			const prevDiag = prevRow[j - 1] ?? 0;
			const prevUp = prevRow[j] ?? 0;
			const prevLeft = currentRow[j - 1] ?? 0;

			if (b.charAt(i - 1) === a.charAt(j - 1)) {
				currentRow[j] = prevDiag;
			} else {
				currentRow[j] = Math.min(
					prevDiag + 1, // substitution
					prevLeft + 1, // insertion
					prevUp + 1, // deletion
				);
			}
		}
	}

	const lastRow = matrix[b.length];
	return lastRow ? (lastRow[a.length] ?? 0) : 0;
}

/**
 * Error thrown when a requested relation does not exist.
 *
 * Provides helpful suggestions including available relations and fuzzy-matched
 * "Did you mean?" hints.
 *
 * @example
 * ```typescript
 * throw new RelationNotFoundError({
 *   table: 'users',
 *   requested: 'comment',
 *   available: ['posts', 'profile', 'comments'],
 * });
 * // Error: Relation 'comment' not found on table 'users'.
 * // Available relations: posts, profile, comments
 * // Did you mean 'comments'?
 * ```
 */
export class RelationNotFoundError extends Error {
	override readonly name = 'RelationNotFoundError' as const;

	/**
	 * The table where the relation was requested.
	 */
	readonly table: string;

	/**
	 * The relation name that was requested but not found.
	 */
	readonly requested: string;

	/**
	 * Available relations on this table.
	 */
	readonly available: readonly string[];

	/**
	 * Suggested relation name (fuzzy match), if any.
	 */
	readonly suggestion?: string;

	constructor(opts: {
		table: string;
		requested: string;
		available: readonly string[];
	}) {
		const suggestion = findClosestMatch(opts.requested, opts.available);
		const availableList =
			opts.available.length > 0 ? opts.available.join(', ') : '(none defined)';

		let message =
			`Relation '${opts.requested}' not found on table '${opts.table}'.\n` +
			`Available relations: ${availableList}`;

		if (suggestion) {
			message += `\n\nDid you mean '${suggestion}'?`;
		}

		super(message);

		this.table = opts.table;
		this.requested = opts.requested;
		this.available = opts.available;
		if (suggestion !== undefined) {
			this.suggestion = suggestion;
		}

		Object.setPrototypeOf(this, RelationNotFoundError.prototype);
	}
}

/**
 * Error thrown when an operation is invalid or malformed.
 *
 * @example
 * ```typescript
 * orm.insert('users').values([]).execute();
 * // Throws InvalidOperationError: No values provided for insert
 * ```
 */
export class InvalidOperationError extends Error {
	override readonly name = 'InvalidOperationError' as const;

	/**
	 * The operation that was attempted.
	 */
	readonly operation: string;

	/**
	 * The reason the operation is invalid.
	 */
	readonly reason: string;

	constructor(operation: string, reason: string) {
		const message = `Invalid ${operation}: ${reason}`;
		super(message);
		this.operation = operation;
		this.reason = reason;
		Object.setPrototypeOf(this, InvalidOperationError.prototype);
	}
}

/**
 * Error thrown when an operation is potentially unsafe and requires explicit confirmation.
 *
 * @example
 * ```typescript
 * orm.update('users').set({ active: false }).execute();
 * // Throws UnsafeOperationError: WHERE clause required
 * ```
 */
export class UnsafeOperationError extends Error {
	override readonly name = 'UnsafeOperationError' as const;

	/**
	 * The operation that was attempted.
	 */
	readonly operation: string;

	/**
	 * How to make the operation safe or explicit.
	 */
	readonly fix: string;

	constructor(operation: string, fix: string) {
		const message = `Unsafe ${operation}: ${fix}`;
		super(message);
		this.operation = operation;
		this.fix = fix;
		Object.setPrototypeOf(this, UnsafeOperationError.prototype);
	}
}

/**
 * Error thrown when a requested table does not exist in the schema.
 *
 * Provides helpful suggestions including available tables and fuzzy-matched
 * "Did you mean?" hints.
 *
 * @example
 * ```typescript
 * throw new TableNotFoundError({
 *   requested: 'usrs',
 *   available: ['users', 'posts', 'comments'],
 * });
 * // Error: Table 'usrs' not found in schema.
 * // Available tables: users, posts, comments
 * // Did you mean 'users'?
 * ```
 */
export class TableNotFoundError extends Error {
	override readonly name = 'TableNotFoundError' as const;

	/**
	 * The table name that was requested but not found.
	 */
	readonly requested: string;

	/**
	 * Available tables in the schema.
	 */
	readonly available: readonly string[];

	/**
	 * Suggested table name (fuzzy match), if any.
	 */
	readonly suggestion?: string;

	constructor(opts: { requested: string; available: readonly string[] }) {
		const suggestion = findClosestMatch(opts.requested, opts.available);
		const availableList =
			opts.available.length > 0
				? opts.available.slice(0, 10).join(', ') +
					(opts.available.length > 10
						? ` (and ${opts.available.length - 10} more)`
						: '')
				: '(none defined)';

		let message =
			`Table '${opts.requested}' not found in schema.\n` +
			`Available tables: ${availableList}`;

		if (suggestion) {
			message += `\n\nDid you mean '${suggestion}'?`;
		}

		super(message);

		this.requested = opts.requested;
		this.available = opts.available;
		if (suggestion !== undefined) {
			this.suggestion = suggestion;
		}

		Object.setPrototypeOf(this, TableNotFoundError.prototype);
	}
}

/**
 * Error thrown when a requested column does not exist on a table.
 *
 * Provides helpful suggestions including available columns and fuzzy-matched
 * "Did you mean?" hints.
 *
 * @example
 * ```typescript
 * throw new ColumnNotFoundError({
 *   table: 'users',
 *   requested: 'emial',
 *   available: ['id', 'email', 'name', 'createdAt'],
 * });
 * // Error: Column 'emial' not found on table 'users'.
 * // Available columns: id, email, name, createdAt
 * // Did you mean 'email'?
 * ```
 */
export class ColumnNotFoundError extends Error {
	override readonly name = 'ColumnNotFoundError' as const;

	/**
	 * The table where the column was requested.
	 */
	readonly table: string;

	/**
	 * The column name that was requested but not found.
	 */
	readonly requested: string;

	/**
	 * Available columns on this table.
	 */
	readonly available: readonly string[];

	/**
	 * Suggested column name (fuzzy match), if any.
	 */
	readonly suggestion?: string;

	constructor(opts: {
		table: string;
		requested: string;
		available: readonly string[];
	}) {
		const suggestion = findClosestMatch(opts.requested, opts.available);
		const availableList =
			opts.available.length > 0
				? opts.available.slice(0, 15).join(', ') +
					(opts.available.length > 15
						? ` (and ${opts.available.length - 15} more)`
						: '')
				: '(none defined)';

		let message =
			`Column '${opts.requested}' not found on table '${opts.table}'.\n` +
			`Available columns: ${availableList}`;

		if (suggestion) {
			message += `\n\nDid you mean '${suggestion}'?`;
		}

		super(message);

		this.table = opts.table;
		this.requested = opts.requested;
		this.available = opts.available;
		if (suggestion !== undefined) {
			this.suggestion = suggestion;
		}

		Object.setPrototypeOf(this, ColumnNotFoundError.prototype);
	}
}

/**
 * Error thrown when schema's naming convention doesn't match adapter's naming convention.
 *
 * This validation prevents subtle bugs where column names in queries don't match
 * the expected database column names due to naming convention mismatch.
 *
 * @example
 * ```typescript
 * const schema = await getSchemaFromDb(adapter); // dbCasing: 'snake_case'
 * const orm = createOrm({
 *   schema,
 *   adapter: createPgsqlAdapter(pool, { dbCasing: 'preserve' }),
 * });
 * // Throws NamingConventionMismatchError
 * ```
 *
 * @since ARCH-006
 */
export class NamingConventionMismatchError extends Error {
	override readonly name = 'NamingConventionMismatchError' as const;

	/**
	 * The DB casing used by the schema.
	 */
	readonly schemaCasing: string;

	/**
	 * The DB casing used by the adapter.
	 */
	readonly adapterCasing: string;

	constructor(opts: { schemaCasing: string; adapterCasing: string }) {
		const message =
			`DB casing mismatch: Schema uses '${opts.schemaCasing}' but adapter uses '${opts.adapterCasing}'.\n` +
			`Either align them or recreate the schema with the same dbCasing as the adapter.`;

		super(message);

		this.schemaCasing = opts.schemaCasing;
		this.adapterCasing = opts.adapterCasing;

		Object.setPrototypeOf(this, NamingConventionMismatchError.prototype);
	}
}

// ============================================================================
// Error Codes
// ============================================================================

/**
 * Error codes for programmatic error handling.
 *
 * Use these codes to identify error types without relying on `instanceof` checks,
 * which is useful for serialization and cross-boundary error handling.
 *
 * @example
 * ```typescript
 * try {
 *   await orm.select('users').all();
 * } catch (error) {
 *   if (error.code === ErrorCode.EXECUTION_ERROR) {
 *     // Handle execution error
 *   }
 * }
 * ```
 */
export const ErrorCode = {
	/** Query execution failed (no adapter configured) */
	EXECUTION_ERROR: 'DBSP_E001',
	/** No record found (firstOrThrow) */
	NOT_FOUND: 'DBSP_E002',
	/** Ambiguous relation detected in strict mode */
	AMBIGUOUS_RELATION: 'DBSP_E003',
	/** Relation not found in schema */
	RELATION_NOT_FOUND: 'DBSP_E004',
	/** Invalid operation in current context */
	INVALID_OPERATION: 'DBSP_E005',
	/** Unsafe operation blocked */
	UNSAFE_OPERATION: 'DBSP_E006',
	/** Table not found in schema */
	TABLE_NOT_FOUND: 'DBSP_E007',
	/** Column not found on table */
	COLUMN_NOT_FOUND: 'DBSP_E008',
	/** Schema naming convention doesn't match adapter naming convention */
	NAMING_CONVENTION_MISMATCH: 'DBSP_E009',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ============================================================================
// Error Factory
// ============================================================================

/**
 * Factory functions for creating DBSP errors with consistent structure.
 *
 * Using the factory provides several benefits:
 * - Consistent error creation across the codebase
 * - Error codes are automatically attached
 * - Type-safe error construction
 * - Centralized error message formatting
 *
 * @example
 * ```typescript
 * import { Errors } from '@dbsp/core';
 *
 * // Create errors with factory
 * throw Errors.tableNotFound({
 *   requested: 'userz',
 *   available: ['users', 'posts', 'comments'],
 * });
 *
 * // Check error type
 * if (Errors.isTableNotFound(error)) {
 *   console.log(error.suggestion); // 'users'
 * }
 * ```
 */
export const Errors = {
	// -------------------------------------------------------------------------
	// Factory functions
	// -------------------------------------------------------------------------

	/**
	 * Create an execution error (no adapter configured).
	 */
	execution(opts: {
		operation: string;
		reason: string;
		fix: string;
	}): ExecutionError & { code: typeof ErrorCode.EXECUTION_ERROR } {
		const error = new ExecutionError(opts);
		return Object.assign(error, { code: ErrorCode.EXECUTION_ERROR });
	},

	/**
	 * Create a not found error (firstOrThrow returned no results).
	 */
	notFound(
		table: string,
		hint?: string,
	): NotFoundError & { code: typeof ErrorCode.NOT_FOUND } {
		const error = new NotFoundError(table, hint);
		return Object.assign(error, { code: ErrorCode.NOT_FOUND });
	},

	/**
	 * Create an ambiguous relation error.
	 */
	ambiguousRelation(
		sourceTable: string,
		targetTable: string,
		options: readonly string[],
	): AmbiguousRelationError & { code: typeof ErrorCode.AMBIGUOUS_RELATION } {
		const error = new AmbiguousRelationError(sourceTable, targetTable, options);
		return Object.assign(error, { code: ErrorCode.AMBIGUOUS_RELATION });
	},

	/**
	 * Create a relation not found error.
	 */
	relationNotFound(opts: {
		table: string;
		requested: string;
		available: readonly string[];
	}): RelationNotFoundError & { code: typeof ErrorCode.RELATION_NOT_FOUND } {
		const error = new RelationNotFoundError(opts);
		return Object.assign(error, { code: ErrorCode.RELATION_NOT_FOUND });
	},

	/**
	 * Create an invalid operation error.
	 */
	invalidOperation(
		operation: string,
		reason: string,
	): InvalidOperationError & { code: typeof ErrorCode.INVALID_OPERATION } {
		const error = new InvalidOperationError(operation, reason);
		return Object.assign(error, { code: ErrorCode.INVALID_OPERATION });
	},

	/**
	 * Create an unsafe operation error.
	 */
	unsafeOperation(
		operation: string,
		fix: string,
	): UnsafeOperationError & { code: typeof ErrorCode.UNSAFE_OPERATION } {
		const error = new UnsafeOperationError(operation, fix);
		return Object.assign(error, { code: ErrorCode.UNSAFE_OPERATION });
	},

	/**
	 * Create a table not found error.
	 */
	tableNotFound(opts: {
		requested: string;
		available: readonly string[];
	}): TableNotFoundError & { code: typeof ErrorCode.TABLE_NOT_FOUND } {
		const error = new TableNotFoundError(opts);
		return Object.assign(error, { code: ErrorCode.TABLE_NOT_FOUND });
	},

	/**
	 * Create a column not found error.
	 */
	columnNotFound(opts: {
		table: string;
		requested: string;
		available: readonly string[];
	}): ColumnNotFoundError & { code: typeof ErrorCode.COLUMN_NOT_FOUND } {
		const error = new ColumnNotFoundError(opts);
		return Object.assign(error, { code: ErrorCode.COLUMN_NOT_FOUND });
	},

	// -------------------------------------------------------------------------
	// Type guards
	// -------------------------------------------------------------------------

	/** Check if error is an ExecutionError */
	isExecution(error: unknown): error is ExecutionError {
		return error instanceof ExecutionError;
	},

	/** Check if error is a NotFoundError */
	isNotFound(error: unknown): error is NotFoundError {
		return error instanceof NotFoundError;
	},

	/** Check if error is an AmbiguousRelationError */
	isAmbiguousRelation(error: unknown): error is AmbiguousRelationError {
		return error instanceof AmbiguousRelationError;
	},

	/** Check if error is a RelationNotFoundError */
	isRelationNotFound(error: unknown): error is RelationNotFoundError {
		return error instanceof RelationNotFoundError;
	},

	/** Check if error is an InvalidOperationError */
	isInvalidOperation(error: unknown): error is InvalidOperationError {
		return error instanceof InvalidOperationError;
	},

	/** Check if error is an UnsafeOperationError */
	isUnsafeOperation(error: unknown): error is UnsafeOperationError {
		return error instanceof UnsafeOperationError;
	},

	/** Check if error is a TableNotFoundError */
	isTableNotFound(error: unknown): error is TableNotFoundError {
		return error instanceof TableNotFoundError;
	},

	/** Check if error is a ColumnNotFoundError */
	isColumnNotFound(error: unknown): error is ColumnNotFoundError {
		return error instanceof ColumnNotFoundError;
	},

	/** Check if error is a NamingConventionMismatchError */
	isNamingConventionMismatch(
		error: unknown,
	): error is NamingConventionMismatchError {
		return error instanceof NamingConventionMismatchError;
	},

	/** Check if error is any DBSP error */
	isDbspError(
		error: unknown,
	): error is
		| ExecutionError
		| NotFoundError
		| AmbiguousRelationError
		| RelationNotFoundError
		| InvalidOperationError
		| UnsafeOperationError
		| TableNotFoundError
		| ColumnNotFoundError
		| NamingConventionMismatchError {
		return (
			error instanceof ExecutionError ||
			error instanceof NotFoundError ||
			error instanceof AmbiguousRelationError ||
			error instanceof RelationNotFoundError ||
			error instanceof InvalidOperationError ||
			error instanceof UnsafeOperationError ||
			error instanceof TableNotFoundError ||
			error instanceof ColumnNotFoundError ||
			error instanceof NamingConventionMismatchError
		);
	},

	/** Check if error has a DBSP error code */
	hasCode(error: unknown): error is Error & { code: ErrorCode } {
		return (
			error instanceof Error &&
			'code' in error &&
			typeof (error as Error & { code: unknown }).code === 'string' &&
			(error as Error & { code: string }).code.startsWith('DBSP_E')
		);
	},
} as const;
