/**
 * DDL Phase: Indexes
 *
 * Generates CREATE INDEX statements for:
 * 1. Explicit indexes defined on each table
 * 2. Auto-generated indexes for FK columns (when fkAutoIndex=true)
 *
 * Auto-indexes are only generated for single-column FKs that do not already
 * have an explicit index, following PostgreSQL best practices for JOIN performance.
 *
 * @module ddl/phases/indexes
 */

import type { IndexIR } from '@dbsp/types';
import { generateCreateIndex } from '../ddl-generator.js';
import { getAutoFkIndexName } from '../schema-diff.js';
import type { PhaseContext } from './types.js';

/**
 * Generate CREATE INDEX statements for all tables.
 *
 * @param ctx - Phase context
 * @returns Array of DDL statements
 */
export function generateIndexesPhase(ctx: PhaseContext): string[] {
	const { tables, schemaName, naming, fkAutoIndex, caps } = ctx;
	const indexContext = caps ? { caps } : undefined;
	const statements: string[] = [];

	for (const table of tables) {
		// Collect explicit index column names to avoid duplicating FK auto-indexes
		const explicitIndexColumns = new Set(
			table.indexes.flatMap((idx) =>
				idx.columns.length === 1 ? idx.columns : [],
			),
		);

		// Explicit indexes
		for (const idx of table.indexes) {
			statements.push(
				generateCreateIndex(table.name, idx, schemaName, naming, indexContext),
			);
		}

		// Auto-generate indexes for single-column FK columns without an explicit index
		if (fkAutoIndex) {
			for (const fk of table.foreignKeys) {
				const fkCol = fk.columns[0];
				if (
					fk.columns.length === 1 &&
					fkCol &&
					!explicitIndexColumns.has(fkCol)
				) {
					const dbTableName = naming.toDatabase(table.name);
					const dbFkCol = naming.toDatabase(fkCol);
					const autoIdx: IndexIR = {
						// Auto-index names are derived from emitted DB identifiers. Existing
						// old-style names do not churn because compareIndexes tracks auto-FK
						// identity structurally (columns + unique), not by index name.
						name: getAutoFkIndexName(dbTableName, dbFkCol),
						columns: [fkCol],
						unique: false,
					};
					statements.push(
						generateCreateIndex(
							table.name,
							autoIdx,
							schemaName,
							naming,
							indexContext,
						),
					);
				}
			}
		}
	}

	return statements;
}
