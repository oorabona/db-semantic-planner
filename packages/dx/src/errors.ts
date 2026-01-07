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

	constructor(message: string) {
		super(message);
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

	constructor(table: string) {
		super(`No record found for '${table}'`);
		this.table = table;
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
		const message =
			`Ambiguous relation to '${targetTable}' from '${sourceTable}'. ` +
			`Available relations: ${optionsList}. ` +
			`Use { via: 'relationName' } to disambiguate.`;

		super(message);

		this.sourceTable = sourceTable;
		this.targetTable = targetTable;
		this.options = options;

		// Required for proper instanceof checks when extending built-in classes
		// See: https://github.com/microsoft/TypeScript/wiki/FAQ#why-doesnt-extending-built-ins-like-error-array-and-map-work
		Object.setPrototypeOf(this, AmbiguousRelationError.prototype);
	}
}
