/**
 * DDL Phase: Drop Statements
 *
 * Generates DROP TABLE IF EXISTS ... CASCADE statements.
 * Only emitted when includeDropStatements=true.
 * Tables are dropped in reverse order to handle FK dependencies.
 *
 * @module ddl/phases/drop-statements
 */

import { generateDropTable } from '../ddl-generator.js';
import type { PhaseContext } from './types.js';

/**
 * Generate DROP TABLE statements for all tables in reverse dependency order.
 *
 * @param ctx - Phase context
 * @returns Array of DDL statements (empty if includeDropStatements is false)
 */
export function generateDropStatementsPhase(ctx: PhaseContext): string[] {
	const { tables, schemaName, naming, includeDropStatements } = ctx;
	if (!includeDropStatements) {
		return [];
	}
	const statements: string[] = [];
	for (const table of [...tables].reverse()) {
		statements.push(generateDropTable(table.name, schemaName, naming));
	}
	statements.push(''); // Empty line separator
	return statements;
}
