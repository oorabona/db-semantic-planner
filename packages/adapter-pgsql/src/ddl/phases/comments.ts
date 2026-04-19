/**
 * DDL Phase: Comments
 *
 * Generates COMMENT ON TABLE and COMMENT ON COLUMN statements.
 * Guarded by the supportsDDLComments capability flag.
 *
 * @module ddl/phases/comments
 */

import { type PhaseContext, sup } from './types.js';

/**
 * Quote an identifier for use in DDL statements.
 */
function quoteId(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

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
 * Generate COMMENT ON TABLE and COMMENT ON COLUMN statements.
 *
 * @param ctx - Phase context
 * @returns Array of DDL statements (empty if comments are unsupported by the dialect)
 */
export function generateCommentsPhase(ctx: PhaseContext): string[] {
	const { tables, schemaName, naming, caps } = ctx;
	if (!sup(caps, caps?.supportsDDLComments)) {
		return [];
	}
	const statements: string[] = [];
	for (const table of tables) {
		if (table.comment) {
			const qualifiedTable = qualifyTable(table.name, schemaName, naming);
			statements.push(
				`COMMENT ON TABLE ${qualifiedTable} IS '${table.comment.replace(/'/g, "''")}';`,
			);
		}
		for (const col of table.columns) {
			if (col.comment) {
				const qualifiedTable = qualifyTable(table.name, schemaName, naming);
				statements.push(
					`COMMENT ON COLUMN ${qualifiedTable}.${quoteId(naming.toDatabase(col.name))} IS '${col.comment.replace(/'/g, "''")}';`,
				);
			}
		}
	}
	return statements;
}
