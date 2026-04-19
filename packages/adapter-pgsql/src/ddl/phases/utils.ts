/**
 * Shared DDL phase utilities.
 *
 * Centralises identifier quoting with mandatory validation so every phase
 * funnels through `validateIdentifier()` before emitting DDL.
 *
 * @module ddl/phases/utils
 */

import { validateExtensionName, validateIdentifier } from '../../validate.js';
import type { PhaseContext } from './types.js';

/**
 * Quote a PostgreSQL identifier for use in DDL statements.
 *
 * @security Always calls `validateIdentifier()` before quoting.
 * Escapes embedded double-quotes by doubling them as defense-in-depth.
 * Throws `InvalidIdentifierError` for identifiers that contain control
 * characters, injection vectors, or other forbidden patterns.
 *
 * @param name Raw identifier (table name, schema name, column name, …)
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
