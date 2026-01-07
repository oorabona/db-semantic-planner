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

	constructor(sourceTable: string, targetTable: string, options: readonly string[]) {
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
