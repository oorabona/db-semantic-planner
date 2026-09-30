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

import { createPgPhysicalModel } from '../../physical-model/index.js';
import { generateCreateIndex } from '../ddl-generator.js';
import { shouldEmitAutoFkIndex } from '../fk-index-coverage.js';
import type { PhaseContext } from './types.js';

function physicalAutoIndexName(
	table: PhaseContext['tables'][number],
	foreignKey: PhaseContext['tables'][number]['foreignKeys'][number],
): string {
	const carried = foreignKey.autoIndexName;
	if (carried !== undefined) return carried;
	const tables = new Map([[table.name, table]]);
	const physical = createPgPhysicalModel({
		mode: 'logical',
		schema: 'public',
		model: {
			tables,
			relations: new Map(),
			getTable: (name) => tables.get(name),
			getRelation: () => undefined,
			getRelationsFrom: () => [],
			getRelationsTo: () => [],
			isAmbiguous: () => ({ ambiguous: false, options: [] }),
		},
	});
	const autoIndexName = physical.model
		.getTable(table.name)
		?.foreignKeys.find(
			(item) => item.columns.join(',') === foreignKey.columns.join(','),
		)?.autoIndexName;
	if (autoIndexName === undefined)
		throw new Error(
			'physical automatic foreign-key index name is missing from the model',
		);
	return autoIndexName;
}

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
		// Explicit indexes
		for (const idx of table.indexes) {
			statements.push(
				generateCreateIndex(table.name, idx, schemaName, indexContext),
			);
		}
		if (!fkAutoIndex) continue;
		for (const fk of table.foreignKeys) {
			const column = fk.columns[0];
			if (
				fk.columns.length !== 1 ||
				column === undefined ||
				!shouldEmitAutoFkIndex(table, column)
			)
				continue;
			const autoIndexName = physicalAutoIndexName(table, fk);
			statements.push(
				generateCreateIndex(
					table.name,
					{
						name: autoIndexName,
						columns: [column],
						unique: false,
					},
					schemaName,
					indexContext,
				),
			);
		}
	}

	return statements;
}
