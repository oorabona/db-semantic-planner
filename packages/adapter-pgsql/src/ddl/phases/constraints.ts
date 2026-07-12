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

import { getCheckConstraintDatabaseName } from '../../check-constraint-name.js';
import { renderCheckConstraintClause } from '../../check-expression.js';
import { validateCheckExpression } from '../../validate.js';
import { generateAlterTableAddFK } from '../ddl-generator.js';
import { type PhaseContext, sup } from './types.js';
import {
	qualifyTableIdent as qualifyTable,
	quoteIdent as quoteId,
} from './utils.js';

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
				const constraintName = quoteId(
					getCheckConstraintDatabaseName(check, naming),
				);
				const expression = renderCheckConstraintClause(check);
				validateCheckExpression(expression, 'check constraint expression');
				statements.push(
					`ALTER TABLE ${qualifiedTable} ADD CONSTRAINT ${constraintName} ${expression};`,
				);
			}
		}
	}

	return statements;
}
