/**
 * Shared DDL phase utilities.
 *
 * Centralises identifier quoting with mandatory validation so every phase
 * funnels through `validateIdentifier()` before emitting DDL.
 *
 * @module ddl/phases/utils
 */

import { validateIdentifier } from '../../validate.js';
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
export function quoteIdent(name: string): string {
	validateIdentifier(name, 'alias');
	return `"${name.replace(/"/g, '""')}"`;
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
	const table = quoteIdent(naming.toDatabase(tableName));
	if (schemaName) {
		return `${quoteIdent(naming.toDatabase(schemaName))}.${table}`;
	}
	return table;
}
