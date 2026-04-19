/**
 * DDL Phase: Row Level Security (RLS)
 *
 * Generates:
 * 1. ALTER TABLE ... ENABLE ROW LEVEL SECURITY (when rlsEnabled=true on table)
 * 2. CREATE POLICY statements for each policy on the table
 *
 * Guarded by the supportsDDLRowLevelSecurity capability flag.
 *
 * @module ddl/phases/rls
 */

import { generateCreatePolicy } from '../ddl-generator.js';
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
 * Generate ENABLE ROW LEVEL SECURITY and CREATE POLICY statements.
 *
 * @param ctx - Phase context
 * @returns Array of DDL statements (empty if RLS is unsupported by the dialect)
 */
export function generateRlsPhase(ctx: PhaseContext): string[] {
	const { tables, schemaName, naming, caps } = ctx;
	if (!sup(caps, caps?.supportsDDLRowLevelSecurity)) {
		return [];
	}
	const statements: string[] = [];
	for (const table of tables) {
		if (table.rlsEnabled) {
			const qualifiedTable = qualifyTable(table.name, schemaName, naming);
			statements.push(
				`ALTER TABLE ${qualifiedTable} ENABLE ROW LEVEL SECURITY;`,
			);
		}
		for (const policy of table.policies ?? []) {
			statements.push(
				generateCreatePolicy(table.name, policy, schemaName, naming),
			);
		}
	}
	return statements;
}
