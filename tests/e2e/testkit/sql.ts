/**
 * Lightweight SQL tagged template — Kysely-compatible API for pg Pool.
 *
 * Provides safe identifier quoting and parameter binding without
 * depending on Kysely. Covers the subset used in E2E DDL/seed files:
 *
 * - `sql\`...\`` — tagged template producing a SqlFragment
 * - `sql.ref(identifier)` — safely quoted identifier (schema, table, column)
 * - `sql.lit(value)` — parameterized literal value ($N placeholder)
 * - `sql.join(fragments, separator?)` — join fragments with separator
 * - `fragment.execute(pool)` — execute against a pg Pool
 */

import type pg from 'pg';

// ── Types ──────────────────────────────────────────────────────

/** Result of executing a SqlFragment against a pg Pool. */
export interface SqlResult<
	T extends Record<string, unknown> = Record<string, unknown>,
> {
	readonly rows: T[];
	readonly rowCount: number | null;
}

// ── SqlFragment ────────────────────────────────────────────────

/**
 * An immutable SQL fragment with interleaved text parts and parameter values.
 *
 * Text parts are joined with positional `$N` placeholders for each parameter.
 */
export class SqlFragment<
	T extends Record<string, unknown> = Record<string, unknown>,
> {
	/** Raw SQL text segments (one more than parameters). */
	readonly #parts: readonly string[];
	/** Bound parameter values (inserted between parts). */
	readonly #params: readonly unknown[];

	constructor(parts: readonly string[], params: readonly unknown[]) {
		this.#parts = parts;
		this.#params = params;
	}

	/**
	 * Compile to a single SQL string with positional `$N` placeholders,
	 * plus the flattened parameter array.
	 */
	compile(): { sql: string; parameters: readonly unknown[] } {
		const parameters: unknown[] = [];
		let sqlStr = '';

		for (let i = 0; i < this.#parts.length; i++) {
			sqlStr += this.#parts[i];
			if (i < this.#params.length) {
				const param = this.#params[i];
				if (param instanceof SqlFragment) {
					// Inline nested fragment (e.g. sql.ref, sql.join)
					const nested = param.compile();
					// Re-number nested placeholders
					let nestedSql = nested.sql;
					if (nested.parameters.length > 0) {
						// Replace $1..$N with $(offset+1)..$(offset+N)
						const offset = parameters.length;
						nestedSql = nestedSql.replace(
							/\$(\d+)/g,
							(_, n) => `$${offset + Number(n)}`,
						);
						parameters.push(...nested.parameters);
					}
					sqlStr += nestedSql;
				} else {
					// Scalar value → positional placeholder
					parameters.push(param);
					sqlStr += `$${parameters.length}`;
				}
			}
		}

		return { sql: sqlStr, parameters };
	}

	/** Execute this fragment against a pg Pool. */
	async execute(pool: pg.Pool): Promise<SqlResult<T>> {
		const { sql: sqlStr, parameters } = this.compile();
		const result = await pool.query(sqlStr, parameters as unknown[]);
		return { rows: result.rows as T[], rowCount: result.rowCount };
	}
}

// ── Identifier quoting ─────────────────────────────────────────

/**
 * Quote a PostgreSQL identifier (schema, table, column name).
 * Doubles any embedded double-quotes per SQL standard.
 */
function quoteIdentifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Tagged template literal that produces a {@link SqlFragment}.
 *
 * Interpolated values become either:
 * - Positional `$N` parameters (plain values)
 * - Inlined SQL text (SqlFragment instances from `sql.ref`, `sql.join`, etc.)
 *
 * @example
 * ```ts
 * const frag = sql`INSERT INTO ${sql.ref(schema)}.users (name) VALUES (${sql.lit('Alice')})`;
 * await frag.execute(pool);
 * ```
 */
function sql<T extends Record<string, unknown> = Record<string, unknown>>(
	strings: TemplateStringsArray,
	...values: unknown[]
): SqlFragment<T> {
	return new SqlFragment<T>([...strings], values);
}

/**
 * Create a SqlFragment that renders as a safely-quoted identifier.
 *
 * Supports dotted paths: `sql.ref('schema.table')` → `"schema"."table"`.
 */
sql.ref = function ref(identifier: string): SqlFragment {
	const quoted = identifier.split('.').map(quoteIdentifier).join('.');
	// A fragment with a single part (the quoted identifier) and no parameters
	return new SqlFragment([quoted], []);
};

/**
 * Create a SqlFragment that renders as a positional parameter placeholder.
 *
 * Use when you want an explicit parameterized value in the middle of
 * already-interpolated SQL.
 */
sql.lit = function lit(value: unknown): SqlFragment {
	return new SqlFragment(['', ''], [value]);
};

/**
 * Join an array of SqlFragments with a separator (default: `', '`).
 */
sql.join = function join(
	fragments: readonly SqlFragment[],
	separator = ', ',
): SqlFragment {
	if (fragments.length === 0) {
		return new SqlFragment([''], []);
	}
	// Interleave fragments with separator text
	const parts: string[] = [''];
	const params: unknown[] = [];
	for (let i = 0; i < fragments.length; i++) {
		params.push(fragments[i]);
		parts.push(i < fragments.length - 1 ? separator : '');
	}
	return new SqlFragment(parts, params);
};

/**
 * Create a raw SQL fragment (no quoting, no parameterization).
 * ⚠️ Only use for trusted, hardcoded SQL snippets.
 */
sql.raw = function raw(sqlStr: string): SqlFragment {
	return new SqlFragment([sqlStr], []);
};

export { sql };
