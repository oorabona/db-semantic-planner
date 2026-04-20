/**
 * Shared DDL phase utilities.
 *
 * Centralises identifier quoting with mandatory validation so every phase
 * funnels through `validateIdentifier()` before emitting DDL.
 *
 * @module ddl/phases/utils
 */

import {
	validateExtensionName,
	validateIdentifier,
	validateSqlExpression,
} from '../../validate.js';
import type { PhaseContext } from './types.js';

// ---------------------------------------------------------------------------
// Index method validation
// ---------------------------------------------------------------------------

/**
 * Valid PostgreSQL index access methods.
 * Used by validateIndexMethod() to reject unknown / injection-bearing strings.
 */
export const VALID_INDEX_METHODS = new Set([
	'btree',
	'hash',
	'gist',
	'gin',
	'brin',
	'hnsw',
	'ivfflat',
	'bm25',
]);

/**
 * Validate a PostgreSQL index access method (USING clause).
 *
 * Method names are emitted unquoted into DDL (`USING btree`, `USING hnsw`),
 * so an allowlist is the only safe approach — regex-based checks cannot
 * guard all injection vectors for unquoted keywords.
 *
 * @security Allowlist — rejects anything not in VALID_INDEX_METHODS.
 * @param method Raw method name from IndexIR (e.g. `'btree'`, `'hnsw'`)
 * @param context Human-readable context for error messages
 * @throws Error when the method is not in the allowlist
 */
export function validateIndexMethod(
	method: string,
	context = 'index method',
): void {
	if (!VALID_INDEX_METHODS.has(method)) {
		throw new Error(
			`Invalid ${context}: "${method}". Must be one of: ${[...VALID_INDEX_METHODS].join(', ')}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Enum label validation (shared by migration-sql.ts and enum-types.ts)
// ---------------------------------------------------------------------------

/**
 * Validate an enum label (single-quoted string value in CREATE TYPE ... AS ENUM,
 * ADD VALUE, or AFTER clause).
 *
 * Enum labels may be any printable string but must not contain NUL bytes or
 * control characters, which PostgreSQL silently truncates or rejects at the
 * protocol level.
 *
 * @param value The enum label to validate
 * @param context Human-readable context label for error messages
 * @throws Error if the label contains forbidden characters
 */
export function validateEnumLabel(value: string, context = 'enum label'): void {
	// Reject NUL bytes — PostgreSQL truncates strings at the first NUL silently
	if (/\x00/.test(value)) {
		throw new Error(
			`Invalid ${context}: contains NUL byte (\\x00) which would be silently truncated by PostgreSQL`,
		);
	}
	// Reject control characters that have no valid use in enum labels
	if (/[\x01-\x1f\x7f]/.test(value)) {
		throw new Error(
			`Invalid ${context}: contains control characters (only printable characters allowed)`,
		);
	}
}

/**
 * Quote a PostgreSQL identifier for use in DDL statements.
 *
 * @security Always calls `validateIdentifier()` before quoting.
 * Escapes embedded double-quotes by doubling them as defense-in-depth.
 * Throws `InvalidIdentifierError` for identifiers that contain control
 * characters, injection vectors, or other forbidden patterns.
 *
 * @param name Raw identifier (table name, schema name, column name, …)
 * @param type Identifier type used for error context; one of
 *   `'table' | 'column' | 'schema' | 'alias'` — defaults to `'alias'`
 * @returns Double-quoted identifier safe for DDL emission
 */
export function quoteIdent(
	name: string,
	type: 'table' | 'column' | 'schema' | 'alias' = 'alias',
): string {
	validateIdentifier(name, type);
	return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quote a PostgreSQL extension name for use in CREATE EXTENSION DDL statements.
 *
 * Extension names allow hyphens and dots (e.g. `uuid-ossp`, `postgis-raster`)
 * which standard identifiers do not. This function calls `validateExtensionName()`
 * for injection-safety, then wraps the name in double-quotes so PostgreSQL
 * accepts hyphenated names without error.
 *
 * @security Always calls `validateExtensionName()` before quoting.
 * @param name Raw extension name (e.g. `uuid-ossp`)
 * @returns Double-quoted name safe for DDL emission (e.g. `"uuid-ossp"`)
 */
export function quoteExtensionName(name: string): string {
	validateExtensionName(name, 'extension');
	// No need to escape double-quotes inside — validateExtensionName rejects them.
	return `"${name}"`;
}

/**
 * Quote a PostgreSQL role name for use in DDL statements (e.g. CREATE POLICY ... TO).
 *
 * Role names may contain spaces and other characters not allowed in standard
 * identifiers (e.g. `"app admin"`, `"read-only"`), but must not contain
 * injection vectors such as semicolons, comment markers, or backslashes.
 *
 * @security Validates via validateSqlExpression() (blocks `;`, `--`, `/*`, `$$`, `\`)
 * and rejects embedded double-quotes, NUL bytes, control characters, and names
 * exceeding PostgreSQL's NAMEDATALEN limit (63 bytes). Wraps the name in
 * double-quotes for safe DDL emission.
 *
 * @param name Raw role name (e.g. `app admin`)
 * @returns Double-quoted role name safe for DDL emission (e.g. `"app admin"`)
 */
export function quoteRoleName(name: string): string {
	if (!name) {
		throw new Error('quoteRoleName: role name must not be empty');
	}
	// Reject embedded double-quotes — no legitimate role name needs them inside
	if (name.includes('"')) {
		throw new Error(
			`quoteRoleName: role name "${name}" must not contain double-quote characters`,
		);
	}
	// Reject NUL bytes — PostgreSQL silently truncates at the first NUL
	if (/\x00/.test(name)) {
		throw new Error(
			`quoteRoleName: role name contains NUL byte (\\x00) which would be silently truncated by PostgreSQL`,
		);
	}
	// Reject other control characters (0x01-0x1F, 0x7F)
	if (/[\x01-\x1f\x7f]/.test(name)) {
		throw new Error(
			`quoteRoleName: role name contains control characters (only printable characters allowed)`,
		);
	}
	// Enforce PostgreSQL NAMEDATALEN: identifiers are truncated at 63 bytes.
	// We count bytes (not JS chars) because PostgreSQL uses strlen() semantics.
	const byteLength = Buffer.byteLength(name, 'utf8');
	if (byteLength > 63) {
		throw new Error(
			`quoteRoleName: role name exceeds PostgreSQL NAMEDATALEN limit of 63 bytes (got ${byteLength} bytes): "${name}"`,
		);
	}
	// Block injection vectors (semicolons, comments, dollar-quotes, backslash)
	validateSqlExpression(name, 'role name');
	return `"${name}"`;
}

/**
 * Qualify a table name with an optional schema prefix.
 * Both the schema and table names are validated + quoted via `quoteIdent`.
 *
 * @param tableName  Unqualified table name (pre-naming-plugin)
 * @param schemaName Optional schema name
 * @param naming     NamingPlugin from PhaseContext
 * @returns `"schema"."table"` or `"table"` if no schema
 */
export function qualifyTableIdent(
	tableName: string,
	schemaName: string | undefined,
	naming: PhaseContext['naming'],
): string {
	const table = quoteIdent(naming.toDatabase(tableName), 'table');
	if (schemaName) {
		return `${quoteIdent(naming.toDatabase(schemaName), 'schema')}.${table}`;
	}
	return table;
}

/**
 * Format a default value for safe SQL emission.
 *
 * Handles the following value types:
 * - `null` → `NULL`
 * - `{ sql: string }` → raw SQL expression (validated via validateSqlExpression)
 * - `string` ending with `()` → emitted unquoted as a bare function call (e.g. `now()`)
 * - `string` (other) → single-quoted literal with `'` escaped as `''` (e.g. `'hello''world'`)
 * - `number` → numeric literal
 * - `boolean` → `true` / `false`
 * - other → single-quoted string representation
 *
 * @security The `{ sql }` escape hatch is validated via validateSqlExpression()
 * before interpolation to prevent injection of multi-statement or comment-bearing strings.
 *
 * @param value The default value from ModelIR
 * @param context Human-readable label for error messages
 * @returns SQL-safe default clause fragment (without `DEFAULT` keyword)
 */
export function formatSqlDefault(
	value: unknown,
	context = 'column default',
): string {
	if (value === null || value === undefined) return 'NULL';

	// { sql: string } escape hatch — emit verbatim after validation
	if (typeof value === 'object' && 'sql' in (value as object)) {
		const rawSql = (value as Record<string, unknown>).sql;
		if (typeof rawSql !== 'string') {
			throw new Error(
				`formatSqlDefault({ sql }): expected string, got ${typeof rawSql}`,
			);
		}
		validateSqlExpression(rawSql, context);
		return rawSql;
	}

	// Function-like expressions (e.g. 'now()') — emit unquoted
	if (typeof value === 'string') {
		if (value.endsWith('()')) return value;
		return `'${value.replace(/'/g, "''")}'`;
	}

	if (typeof value === 'number') return String(value);
	if (typeof value === 'boolean') return value ? 'true' : 'false';

	// Fallback: single-quoted string representation
	return `'${String(value).replace(/'/g, "''")}'`;
}
