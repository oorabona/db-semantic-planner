/**
 * DDL Phase: Constraints
 *
 * Generates ALTER TABLE ADD CONSTRAINT statements for:
 * 1. Foreign keys (always included — no capability flag, FKs are core SQL)
 * 2. Check constraints (guarded by supportsDDLCheckConstraints)
 *
 * Runs after CREATE TABLE to handle circular FK dependencies.
 *
 * @module ddl/phases/constraints
 */

import { generateAlterTableAddFK } from '../ddl-generator.js';
import { type PhaseContext, sup } from './types.js';
import { quoteIdent as quoteId } from './utils.js';

/**
 * Qualify a table name with an optional schema prefix.
 */
function qualifyTable(
	tableName: string,
	schemaName: string | undefined,
	naming: PhaseContext['naming'],
): string {
	const table = quoteId(naming.toDatabase(tableName));
	if (schemaName) {
		return `${quoteId(naming.toDatabase(schemaName))}.${table}`;
	}
	return table;
}

/**
 * Generate ALTER TABLE ADD CONSTRAINT statements for foreign keys and check constraints.
 *
 * @param ctx - Phase context
 * @returns Array of DDL statements
 */
export function generateConstraintsPhase(ctx: PhaseContext): string[] {
	const { tables, schemaName, naming, caps } = ctx;
	const statements: string[] = [];

	// FK constraints (two-pass approach: tables first, then FKs to handle circularity)
	for (const table of tables) {
		for (const fk of table.foreignKeys) {
			statements.push(
				generateAlterTableAddFK(table.name, fk, schemaName, naming),
			);
		}
	}

	// Check constraints
	if (sup(caps, caps?.supportsDDLCheckConstraints)) {
		for (const table of tables) {
			for (const check of table.checkConstraints ?? []) {
				const qualifiedTable = qualifyTable(table.name, schemaName, naming);
				const constraintName = quoteId(check.name);
				statements.push(
					`ALTER TABLE ${qualifiedTable} ADD CONSTRAINT ${constraintName} ${check.expression};`,
				);
			}
		}
	}

	return statements;
}
