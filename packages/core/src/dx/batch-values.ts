import { validateIdentifier } from './errors.js';

/**
 * Validate a PostgreSQL type name for use in CAST($N AS type[]).
 *
 * Type names are not plain SQL identifiers: they may contain spaces
 * (e.g. `timestamp with time zone`), parenthesised modifiers (e.g.
 * `varchar(255)`, `numeric(10,2)`), array brackets (`int4[]`), and
 * schema qualification (`myschema.myenum`).
 *
 * Allowed characters: letters, digits, underscore, space, dot,
 * parentheses, comma, and square brackets.
 *
 * Rejected: quotes (`"`, `'`), semicolons, backslashes, comment
 * sequences (`--`, `/*`), and the empty string.
 *
 * @internal — exported for adapter compile-time revalidation only.
 */
export function validateTypeName(typeName: string): void {
	if (!typeName || typeName.length === 0) {
		throw new Error(
			`batchValues: invalid type name '${typeName}'. Type names must not be empty.`,
		);
	}
	// Reject dangerous characters that can break out of a TypeName context
	if (
		/["';\\]/.test(typeName) ||
		/--/.test(typeName) ||
		/\/\*/.test(typeName)
	) {
		throw new Error(
			`batchValues: invalid type name '${typeName}'. ` +
				'Type names must not contain quotes, semicolons, backslashes, or comment sequences.',
		);
	}
	// Allow only safe characters: letters, digits, underscore, space, dot,
	// parentheses, comma, square brackets
	if (!/^[a-zA-Z0-9_\s.()[\],]+$/.test(typeName)) {
		throw new Error(
			`batchValues: invalid type name '${typeName}'. ` +
				'Type names may only contain letters, digits, underscores, spaces, dots, ' +
				'parentheses, commas, and square brackets.',
		);
	}
}

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
	// Uses the type-name-safe validator (allows spaces, parens, brackets, dots)
	// so that complex types like 'varchar(255)', 'numeric(10,2)', 'int4[]',
	// and 'timestamp with time zone' are accepted while injection chars are rejected.
	for (const t of types) {
		validateTypeName(t);
	}
	// Security: validate alias and column names centrally so BOTH the
	// orm.from(batchValues(...)) and orm...join(batchValues(...)) paths are
	// protected at the source.  The deparser emits these as SQL identifiers
	// in AS alias(col1, col2) — an unvalidated name could inject SQL.
	const alias = opts?.alias ?? 'batch';
	validateIdentifier(alias, 'alias');
	for (const col of columns) {
		validateIdentifier(col, 'column');
	}
	// Defensive copies: freeze all returned arrays so post-construction mutation
	// of the caller's arrays cannot change what gets compiled.
	// Vector 1 (mutation): caller mutates original arrays after batchValues() returns.
	// Each data row is also copied so the caller cannot mutate individual arrays.
	// The inner Object.freeze returns `readonly unknown[]` but BatchValuesRef.data
	// declares `readonly unknown[][]` (inner arrays typed as mutable unknown[]).
	// The cast is safe: callers only read from data[], never write to inner arrays.
	const frozenData: readonly unknown[][] = Object.freeze(
		data.map((row) => Object.freeze([...row]) as unknown[]),
	);
	const frozenColumns: readonly string[] = Object.freeze([...columns]);
	const frozenTypes: readonly string[] = Object.freeze([...types]);
	return Object.freeze({
		__kind: 'batchValues',
		data: frozenData,
		columns: frozenColumns,
		types: frozenTypes,
		alias,
		ordinality: opts?.ordinality ?? false,
	});
}
