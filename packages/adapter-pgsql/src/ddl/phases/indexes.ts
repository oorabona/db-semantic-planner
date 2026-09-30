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
import {
	getAutoFkIndexName,
	shouldEmitAutoFkIndex,
} from '../fk-index-coverage.js';
import type { PhaseContext } from './types.js';

/**
 * Generate CREATE INDEX statements for all tables.
 *
 * @param ctx - Phase context
 * @returns Array of DDL statements
 */
export function generateIndexesPhase(ctx: PhaseContext): string[] {
	const { tables, schemaName, fkAutoIndex, caps } = ctx;
	const indexContext = caps ? { caps } : undefined;
	const statements: string[] = [];

	for (const table of tables) {
		const dbTableName = table.name;
		// Explicit indexes
		for (const idx of table.indexes) {
			statements.push(
				generateCreateIndex(table.name, idx, schemaName, indexContext),
			);
		}

		// Auto-generate indexes for single-column FKs without a declared
		// single-column key or another covering declared key.
		if (fkAutoIndex) {
			for (const fk of table.foreignKeys) {
				const fkCol = fk.columns[0];
				if (
					fk.columns.length === 1 &&
					fkCol &&
					shouldEmitAutoFkIndex(table, fkCol)
				) {
					const dbFkCol = fkCol;
					const autoIdx: IndexIR = {
						name: getAutoFkIndexName(dbTableName, dbFkCol),
						columns: [fkCol],
						unique: false,
					};
					statements.push(
						generateCreateIndex(table.name, autoIdx, schemaName, indexContext),
					);
				}
			}
		}
	}

	return statements;
}
