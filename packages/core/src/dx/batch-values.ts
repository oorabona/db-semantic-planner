import { validateIdentifier } from './errors.js';

// ============================================================================
// Structured PostgreSQL type-name grammar
// ============================================================================

/**
 * Fixed allowlist of known multi-word PostgreSQL base types (case-insensitive).
 * These are the only multi-word base types accepted by the structured grammar;
 * all other base types must be strict SQL identifiers (optionally schema-qualified).
 */
const MULTIWORD_BASE_TYPES: readonly string[] = [
	'timestamp with time zone',
	'timestamp without time zone',
	'time with time zone',
	'time without time zone',
	'double precision',
	'character varying',
	'bit varying',
];

/** Match a strict SQL identifier: letter or underscore, then letters/digits/underscores. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate a PostgreSQL type name for use in CAST($N AS type[]).
 *
 * Accepted grammar (structured, not a broad character-class):
 *   typeName = trim(base [modifier] [arraySuffix])
 *
 *   arraySuffix = "[]"          — at most ONE level; "int4[][]" is rejected as a
 *                                  raw type-name input (array-ness is handled by the
 *                                  batch-values layer which appends its own "[]").
 *   modifier    = "(" digits ")" | "(" digits "," digits ")"
 *                                — e.g. "(255)", "(10,2)"; any other parenthesised
 *                                  content is rejected.
 *   base        = multiWordType | ident | ident "." ident
 *   multiWordType = one of: "timestamp with time zone",
 *                           "timestamp without time zone",
 *                           "time with time zone",
 *                           "time without time zone",
 *                           "double precision",
 *                           "character varying",
 *                           "bit varying"
 *   ident       = [A-Za-z_][A-Za-z0-9_]*
 *
 * Examples that pass: int4, text, uuid, numeric(10,2), varchar(255),
 *   timestamp with time zone, myschema.myenum, int4[].
 * Examples that throw: empty string, int4[][], int4) ; DROP TABLE x; --,
 *   foo'bar, int4)); JOIN users ON true.
 *
 * @internal — exported for adapter compile-time revalidation only.
 */
export function validateTypeName(typeName: string): void {
	const raw = typeName.trim();
	if (raw.length === 0) {
		throw new Error(
			`batchValues: invalid type name '${typeName}'. Type names must not be empty.`,
		);
	}

	let rest = raw;

	// ── Step 1: strip at most ONE trailing array suffix "[]" ─────────────────
	// More than one "[]" (e.g. "int4[][]") is rejected by the grammar: after
	// stripping one, the remaining rest must NOT end in "[]" again.
	if (rest.endsWith('[]')) {
		rest = rest.slice(0, -2);
		if (rest.endsWith('[]')) {
			throw new Error(
				`batchValues: invalid type name '${typeName}'. ` +
					'At most one array suffix "[]" is allowed as a raw type-name input. ' +
					'Use "int4[]" not "int4[][]".',
			);
		}
	}

	// ── Step 2: strip optional modifier "(N)" or "(N,M)" ─────────────────────
	// Only digits inside parens; any other parenthesised content is rejected.
	const modifierMatch = rest.match(/\(([^)]*)\)$/);
	if (modifierMatch) {
		const inner = modifierMatch[1] ?? '';
		if (!/^\d+(?:,\d+)?$/.test(inner)) {
			throw new Error(
				`batchValues: invalid type name '${typeName}'. ` +
					`Type modifier must be "(N)" or "(N,M)" with digits only; got "(${inner})".`,
			);
		}
		rest = rest.slice(0, rest.length - modifierMatch[0].length).trimEnd();
	}

	// ── Step 3: validate the base type ───────────────────────────────────────
	const baseLower = rest.toLowerCase();

	// (a) Multi-word allowlist (case-insensitive)
	if (MULTIWORD_BASE_TYPES.includes(baseLower)) {
		return; // valid
	}

	// (b) Strict identifier, optionally schema-qualified: ident | ident.ident
	const parts = rest.split('.');
	if (parts.length > 2) {
		throw new Error(
			`batchValues: invalid type name '${typeName}'. ` +
				'Schema-qualified types allow at most one dot (schema.type).',
		);
	}
	for (const part of parts) {
		if (!IDENT_RE.test(part)) {
			throw new Error(
				`batchValues: invalid type name '${typeName}'. ` +
					`Base type "${part}" is not a valid SQL identifier ` +
					'([A-Za-z_][A-Za-z0-9_]*) and is not in the multi-word type allowlist.',
			);
		}
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
	// Normalize (trim) each type name before validation so that the stored descriptor
	// holds clean values — the adapter's compile-time array check (endsWith('[]'))
	// must see a trimmed string or it produces the wrong cast shape.
	const normalizedTypes = types.map((t) => t.trim());
	for (const t of normalizedTypes) {
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
	// Store normalized (trimmed) type names so the adapter's compile-time checks
	// (e.g. endsWith('[]')) work correctly without re-trimming at every call site.
	const frozenTypes: readonly string[] = Object.freeze([...normalizedTypes]);
	return Object.freeze({
		__kind: 'batchValues',
		data: frozenData,
		columns: frozenColumns,
		types: frozenTypes,
		alias,
		ordinality: opts?.ordinality ?? false,
	});
}
