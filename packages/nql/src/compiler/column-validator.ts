/**
 * @module compiler/column-validator
 * Schema-based column and table validation for the NQL compiler.
 */

import { NqlErrorCodes, NqlSemanticException } from '../errors/index.js';
import type { ColumnValidatorSchema } from './types.js';

/**
 * Validates column references against the schema.
 * When no schema is provided, validation is skipped (backward compat).
 */
export class ColumnValidator {
	constructor(private readonly schema: ColumnValidatorSchema) {}

	/**
	 * Convert camelCase to snake_case for column name matching.
	 * NQL queries may use either form (e.g., viewCount or view_count).
	 */
	private static toSnakeCase(name: string): string {
		return name.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
	}

	/**
	 * Check if a query column matches a schema column.
	 * Accepts exact match OR snake_case ↔ camelCase equivalence.
	 */
	private static columnsMatch(queryCol: string, schemaCol: string): boolean {
		if (queryCol === schemaCol) return true;
		// Compare snake_case forms: camelCase schema name vs snake_case query name
		return (
			ColumnValidator.toSnakeCase(queryCol) ===
			ColumnValidator.toSnakeCase(schemaCol)
		);
	}

	validateColumn(table: string, column: string): void {
		if (column === '*') return;
		const tableInfo = this.schema.getTable(table);
		if (!tableInfo) return; // Unknown table → graceful degradation
		const exists = tableInfo.columns.some((c) =>
			ColumnValidator.columnsMatch(column, c.name),
		);
		if (!exists) {
			const available = tableInfo.columns.map((c) => c.name).join(', ');
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_UNKNOWN_COLUMN,
				`Column '${column}' does not exist on table '${table}'. Available columns: ${available}`,
			);
		}
	}

	validateTable(table: string): void {
		const tableInfo = this.schema.getTable(table);
		if (!tableInfo) {
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_UNKNOWN_TABLE,
				`Table '${table}' does not exist in the schema`,
			);
		}
	}

	resolveRelationTarget(
		sourceTable: string,
		relationName: string,
	): string | undefined {
		const relations = this.schema.getRelationsFrom(sourceTable);
		const rel = relations.find((r) => r.name === relationName);
		return rel?.target;
	}
}
