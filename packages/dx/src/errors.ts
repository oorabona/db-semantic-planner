/**
 * Error thrown when attempting to execute a query without a database configured.
 *
 * @example
 * ```typescript
 * const orm = createOrm({ model: schema }); // No db!
 * await orm.query('users').findMany(); // Throws ExecutionError
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
 * Error thrown when findFirstOrThrow() finds no results.
 *
 * @example
 * ```typescript
 * await orm.query('users').where(eq('id', 999)).findFirstOrThrow();
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
 *   orm.query('users').include('posts').plan();
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
 */
function findClosestMatch(
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
	const matrix: number[][] = [];

	for (let i = 0; i <= b.length; i++) {
		matrix[i] = [i];
	}
	for (let j = 0; j <= a.length; j++) {
		matrix[0]![j] = j;
	}

	for (let i = 1; i <= b.length; i++) {
		for (let j = 1; j <= a.length; j++) {
			if (b.charAt(i - 1) === a.charAt(j - 1)) {
				matrix[i]![j] = matrix[i - 1]![j - 1]!;
			} else {
				matrix[i]![j] = Math.min(
					matrix[i - 1]![j - 1]! + 1, // substitution
					matrix[i]![j - 1]! + 1, // insertion
					matrix[i - 1]![j]! + 1, // deletion
				);
			}
		}
	}

	return matrix[b.length]![a.length]!;
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
			opts.available.length > 0
				? opts.available.join(', ')
				: '(none defined)';

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
