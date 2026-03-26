/**
 * BatchValuesRef — a virtual batch data source backed by unnest($1::type[], ...).
 *
 * Created via `orm.batchValues(data, columns, types, opts?)`.
 * Used as a source in `.from()` or `.join()` to operate on a set of
 * parameter-bound arrays without a real table.
 *
 * @example Batch UPDATE
 * ```typescript
 * const batch = orm.batchValues(
 *   [ids, calleeIds],
 *   ['id', 'callee_id'],
 *   ['integer', 'integer'],
 * );
 * await orm.modify(calls)
 *   .join(batch, { on: eq('calls.id', ref('batch.id')) })
 *   .set({ callee_id: ref('batch.callee_id') })
 *   .execute();
 * ```
 *
 * @example Batch lookup with ordinality
 * ```typescript
 * const requested = orm.batchValues(
 *   [paths, names],
 *   ['path', 'name'],
 *   ['text', 'text'],
 *   { ordinality: true },
 * );
 * await orm.from(requested)
 *   .join('files', { on: eq('files.path', ref('requested.path')) })
 *   .orderBy('requested.ord')
 *   .all();
 * ```
 */
export type BatchValuesOptions = {
	/** Add WITH ORDINALITY -- appends an 'ord' column with row numbers */
	readonly ordinality?: boolean;
	/** Alias for the unnest source in SQL (default: 'batch') */
	readonly alias?: string;
};

/**
 * A virtual batch data source backed by `unnest($1::type[], $2::type[], ...)`.
 *
 * Not a QueryBuilder -- it is a lightweight descriptor passed to `.from()` or
 * `.join()`. The adapter compiles it to a RangeFunction AST node.
 */
export type BatchValuesRef = {
	readonly __kind: 'batchValues';
	/** Column-major data arrays: one array per column */
	readonly data: readonly unknown[][];
	/** Column names for the unnest alias clause */
	readonly columns: readonly string[];
	/** PostgreSQL type names for CAST ($1::type[]) -- e.g. 'integer', 'text' */
	readonly types: readonly string[];
	/** SQL alias used to reference this source (default: 'batch') */
	readonly alias: string;
	/** When true, WITH ORDINALITY is emitted -- adds an 'ord' column */
	readonly ordinality: boolean;
};

/**
 * Type guard for BatchValuesRef.
 */
export function isBatchValuesRef(value: unknown): value is BatchValuesRef {
	return (
		typeof value === 'object' &&
		value !== null &&
		'__kind' in value &&
		(value as BatchValuesRef).__kind === 'batchValues'
	);
}

/**
 * Factory function -- create a BatchValuesRef descriptor.
 *
 * @param data    Column-major arrays: `[idsArray, namesArray, ...]`
 * @param columns Column names: `['id', 'name', ...]`
 * @param types   PG type names: `['integer', 'text', ...]`
 * @param opts    Optional: alias and ordinality flag
 */
export function batchValues(
	data: readonly unknown[][],
	columns: readonly string[],
	types: readonly string[],
	opts?: BatchValuesOptions,
): BatchValuesRef {
	if (data.length !== columns.length || data.length !== types.length) {
		throw new Error(
			'batchValues: data, columns, and types must have the same length ' +
				`(got ${data.length}, ${columns.length}, ${types.length})`,
		);
	}
	if (columns.length === 0) {
		throw new Error('batchValues: at least one column is required');
	}
	// Security: validate type names to prevent SQL injection via CAST($N AS type[]).
	// Only allow identifier characters: letters, digits, underscore.
	const invalidType = types.find((t) => !/^[a-zA-Z0-9_]+$/.test(t));
	if (invalidType !== undefined) {
		throw new Error(
			`batchValues: invalid type name '${invalidType}'. ` +
				'Type names must contain only letters, digits, and underscores.',
		);
	}
	return {
		__kind: 'batchValues',
		data,
		columns,
		types,
		alias: opts?.alias ?? 'batch',
		ordinality: opts?.ordinality ?? false,
	};
}
