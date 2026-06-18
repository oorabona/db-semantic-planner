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
	private knownCteTables: Set<string> = new Set();
	private virtualBindingTables: Map<string, readonly string[]> = new Map();

	constructor(private readonly schema: ColumnValidatorSchema) {}

	/**
	 * Register CTE names so validateTable() skips validation for them.
	 * CTE names are not physical tables in the schema, but are valid FROM targets.
	 */
	addKnownCteTables(names: Iterable<string>): void {
		for (const name of names) {
			this.knownCteTables.add(name);
		}
	}

	/** Clear all registered CTE table names (used between compilations). */
	clearKnownCteTables(): void {
		this.knownCteTables.clear();
	}

	/**
	 * Register an NQL binding as a virtual table with a concrete output schema.
	 * Binding columns are logical output names, so matching is exact.
	 */
	addVirtualBindingTable(name: string, columns: readonly string[]): void {
		this.virtualBindingTables.set(name, columns);
	}

	/** Clear all registered virtual binding tables (used between compilations). */
	clearVirtualBindingTables(): void {
		this.virtualBindingTables.clear();
	}

	isVirtualBindingTable(name: string | undefined): boolean {
		return name !== undefined && this.virtualBindingTables.has(name);
	}

	getVirtualBindingColumns(name: string): readonly string[] | undefined {
		return this.virtualBindingTables.get(name);
	}

	getTableColumns(name: string): readonly string[] | undefined {
		const virtualColumns = this.virtualBindingTables.get(name);
		if (virtualColumns) return virtualColumns;
		return this.schema.getTable(name)?.columns.map((column) => column.name);
	}

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

	/**
	 * Resolve a user-authored column spelling to the model column name.
	 * Uses the same exact-or-snake/camel equivalence as validateColumn().
	 */
	resolveColumnName(table: string, column: string): string | undefined {
		if (column === '*') return column;
		const virtualColumns = this.virtualBindingTables.get(table);
		if (virtualColumns) {
			return virtualColumns.find((c) => c === column);
		}
		const tableInfo = this.schema.getTable(table);
		if (!tableInfo) return undefined;
		return tableInfo.columns.find((c) =>
			ColumnValidator.columnsMatch(column, c.name),
		)?.name;
	}

	validateColumn(table: string, column: string): void {
		/* v8 ignore next — '*' columns are validated at call-site before reaching here -- @preserve */
		if (column === '*') return;
		const virtualColumns = this.virtualBindingTables.get(table);
		if (virtualColumns) {
			const exists = virtualColumns.some((c) => c === column);
			if (!exists) {
				const available = virtualColumns.join(', ') || '(none)';
				throw new NqlSemanticException(
					NqlErrorCodes.SEM_UNKNOWN_COLUMN,
					`Column '${column}' is not projected by NQL binding '${table}'. Available columns: ${available}`,
				);
			}
			return;
		}
		const tableInfo = this.schema.getTable(table);
		/* v8 ignore next — graceful degradation: unknown tables skip validation -- @preserve */
		if (!tableInfo) return; // Unknown table → graceful degradation
		const resolvedColumn = this.resolveColumnName(table, column);
		if (resolvedColumn === undefined) {
			const available = tableInfo.columns.map((c) => c.name).join(', ');
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_UNKNOWN_COLUMN,
				`Column '${column}' does not exist on table '${table}'. Available columns: ${available}`,
			);
		}
	}

	validateTable(table: string): void {
		if (this.virtualBindingTables.has(table)) return;
		// CTE names are valid table references even though they are not in the schema
		if (this.knownCteTables.has(table)) return;
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
		if (this.virtualBindingTables.has(sourceTable)) {
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				`Query '${sourceTable}' reads from an NQL binding and cannot use relation filters (${relationName}). Relation constructs require a physical model table, not a CTE binding.`,
			);
		}
		const relations = this.schema.getRelationsFrom(sourceTable);
		const rel = relations.find((r) => r.name === relationName);
		return rel?.target;
	}

	assertNoBindingRelationConstruct(
		bindingName: string | undefined,
		construct: string,
		detail: string,
	): void {
		if (!this.isVirtualBindingTable(bindingName)) return;
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			`Query '${bindingName}' reads from an NQL binding and cannot ${construct} (${detail}). Relation constructs require a physical model table, not a CTE binding.`,
		);
	}

	assertNoBindingRelationPath(
		bindingName: string | undefined,
		path: string,
	): void {
		if (!this.isVirtualBindingTable(bindingName)) return;
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			`Query '${bindingName}' reads from an NQL binding and cannot reference relation path '${path}'. Relation paths require a physical model table, not a CTE binding.`,
		);
	}
}
