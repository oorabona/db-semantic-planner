/**
 * DDL Phase: Comments
 *
 * Generates COMMENT ON TABLE and COMMENT ON COLUMN statements.
 * Guarded by the supportsDDLComments capability flag.
 *
 * @module ddl/phases/comments
 */

import { assertString } from '../../validate.js';
import { type PhaseContext, sup } from './types.js';
import {
	qualifyTableIdent as qualifyTable,
	quoteIdent as quoteId,
} from './utils.js';

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
		const tableComment = table.comment;
		if (tableComment) {
			assertString(tableComment, 'table comment');
			const qualifiedTable = qualifyTable(table.name, schemaName, naming);
			statements.push(
				`COMMENT ON TABLE ${qualifiedTable} IS '${tableComment.replace(/'/g, "''")}';`,
			);
		}
		for (const col of table.columns) {
			const columnComment = col.comment;
			if (columnComment) {
				assertString(columnComment, 'column comment');
				const qualifiedTable = qualifyTable(table.name, schemaName, naming);
				statements.push(
					`COMMENT ON COLUMN ${qualifiedTable}.${quoteId(naming.toDatabase(col.name))} IS '${columnComment.replace(/'/g, "''")}';`,
				);
			}
		}
	}
	return statements;
}
