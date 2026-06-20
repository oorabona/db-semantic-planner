/**
 * @module compiler/column-validator
 * Schema-based column and table validation for the NQL compiler.
 */

import type {
	NqlBindingRelationFilterMetadata,
	NqlBindingVirtualRelation,
} from '@dbsp/types';
import { toColumnList } from '@dbsp/types';
import {
	explainUnsupportedNqlBindingIncludeHop,
	type NqlBindingIncludeRelationShape,
} from '@dbsp/types/internal';
import { NqlErrorCodes, NqlSemanticException } from '../errors/index.js';
import { DEFAULT_RELATION_TARGET_COLUMN } from './binding-relation-utils.js';
import type {
	ColumnValidatorPseudoColumn,
	ColumnValidatorRelation,
	ColumnValidatorSchema,
} from './types.js';

/**
 * Validates column references against the schema.
 * When no schema is provided, validation is skipped (backward compat).
 */
export class ColumnValidator {
	private knownCteTables: Set<string> = new Set();
	private virtualBindingTables: Map<string, readonly string[]> = new Map();
	private virtualBindingRelationFilters: Map<
		string,
		NqlBindingRelationFilterMetadata
	> = new Map();

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
	addVirtualBindingTable(
		name: string,
		columns: readonly string[],
		relationFilters?: NqlBindingRelationFilterMetadata,
	): void {
		this.virtualBindingTables.set(name, columns);
		if (relationFilters) {
			this.virtualBindingRelationFilters.set(name, relationFilters);
		}
	}

	/** Clear all registered virtual binding tables (used between compilations). */
	clearVirtualBindingTables(): void {
		this.virtualBindingTables.clear();
		this.virtualBindingRelationFilters.clear();
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

	getPhysicalTableColumns(name: string): readonly string[] | undefined {
		return this.schema.getTable(name)?.columns.map((column) => column.name);
	}

	getPseudoColumns(name: string): readonly ColumnValidatorPseudoColumn[] {
		return this.schema.getTable(name)?.pseudoColumns ?? [];
	}

	hasPhysicalTable(name: string): boolean {
		return !this.virtualBindingTables.has(name) && !!this.schema.getTable(name);
	}

	hasQualifiedRelationLookup(): boolean {
		return typeof this.schema.getRelation === 'function';
	}

	getRelation(
		sourceTable: string,
		relationName: string,
	): ColumnValidatorRelation | undefined {
		return (
			this.schema.getRelation?.(`${sourceTable}.${relationName}`) ??
			this.schema
				.getRelationsFrom(sourceTable)
				.find((relation) => relation.name === relationName)
		);
	}

	getRelationsFrom(sourceTable: string): readonly ColumnValidatorRelation[] {
		return this.schema.getRelationsFrom(sourceTable);
	}

	getVirtualBindingRelation(
		bindingName: string,
		relationName: string,
	): NqlBindingVirtualRelation | undefined {
		return this.virtualBindingRelationFilters
			.get(bindingName)
			?.relations.find((relation) => relation.relation === relationName);
	}

	getVirtualBindingScalarRelation(
		bindingName: string,
		relationName: string,
	): NqlBindingVirtualRelation | undefined {
		return this.virtualBindingRelationFilters
			.get(bindingName)
			?.scalarRelations?.find((relation) => relation.relation === relationName);
	}

	private static virtualRelationIncludeShape(
		relation: NqlBindingVirtualRelation,
	): NqlBindingIncludeRelationShape {
		const relationType = relation.relationType;
		const foreignKey =
			relationType === 'belongsTo'
				? relation.sourceColumn
				: relation.targetColumn;
		return {
			type: relationType,
			foreignKey,
			source: relation.sourceTable,
			target: relation.targetTable,
		};
	}

	resolveVirtualBindingScalarRelationForInclude(
		bindingName: string,
		relationPath: readonly string[],
	): NqlBindingVirtualRelation {
		const relationName = relationPath.join('.');
		if (relationPath.length < 1) {
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				`Query '${bindingName}' reads from an NQL binding and cannot use relation include '${relationName}' (ref-#192): the relation path must name a source-table relation.`,
			);
		}
		const relation = relationPath[0];
		if (!relation) {
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				`Query '${bindingName}' reads from an NQL binding and cannot use relation include '${relationName}' (ref-#192): the relation path must name a source-table relation.`,
			);
		}
		const virtualRelation = this.getVirtualBindingScalarRelation(
			bindingName,
			relation,
		);
		if (virtualRelation) {
			const resolvedFirstHop =
				this.getRelation(virtualRelation.sourceTable, relation) ??
				ColumnValidator.virtualRelationIncludeShape(virtualRelation);
			const unsupportedFirstHopReason = explainUnsupportedNqlBindingIncludeHop(
				relation,
				resolvedFirstHop,
				{ relation },
			);
			if (unsupportedFirstHopReason) {
				throw new NqlSemanticException(
					NqlErrorCodes.SEM_INVALID_SYNTAX,
					`Query '${bindingName}' reads from an NQL binding and cannot use relation include '${relationName}' (ref-#192): ${unsupportedFirstHopReason}.`,
				);
			}
			let sourceTable = virtualRelation.targetTable;
			for (let i = 1; i < relationPath.length; i++) {
				const tailRelation = relationPath[i];
				if (!tailRelation) {
					throw new NqlSemanticException(
						NqlErrorCodes.SEM_INVALID_SYNTAX,
						`Query '${bindingName}' reads from an NQL binding and cannot use relation include '${relationName}' (ref-#192): relation path segment ${i + 1} is empty.`,
					);
				}
				const resolvedTail = this.getRelation(sourceTable, tailRelation);
				if (!resolvedTail) {
					throw new NqlSemanticException(
						NqlErrorCodes.SEM_INVALID_SYNTAX,
						`Query '${bindingName}' reads from an NQL binding and cannot use relation include '${relationName}' (ref-#192): tail relation '${tailRelation}' is not declared on table '${sourceTable}'.`,
					);
				}
				const unsupportedReason = explainUnsupportedNqlBindingIncludeHop(
					tailRelation,
					resolvedTail,
					{ relation: tailRelation },
				);
				if (unsupportedReason) {
					throw new NqlSemanticException(
						NqlErrorCodes.SEM_INVALID_SYNTAX,
						`Query '${bindingName}' reads from an NQL binding and cannot use relation include '${relationName}' (ref-#192): tail ${unsupportedReason}.`,
					);
				}
				sourceTable = resolvedTail.target;
			}
			return virtualRelation;
		}
		const reason = this.explainVirtualBindingScalarRelationRejection(
			bindingName,
			relation,
		);
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			`Query '${bindingName}' reads from an NQL binding and cannot use relation include '${relation}' (ref-#192): ${reason}.`,
		);
	}

	explainVirtualBindingRelationRejection(
		bindingName: string,
		relationName: string,
	): string {
		const metadata = this.virtualBindingRelationFilters.get(bindingName);
		if (!metadata) {
			return 'no binding relation-filter metadata is available';
		}
		if (metadata.unsafeReason) return metadata.unsafeReason;
		const sourceTable = metadata.sourceTable;
		if (!sourceTable) {
			return 'the binding source table could not be proven';
		}
		const relation = this.getRelation(sourceTable, relationName);
		if (!relation) {
			return `relation '${relationName}' is not declared on source table '${sourceTable}'`;
		}
		const fkColumns = toColumnList(relation.foreignKey);
		if (relation.type !== 'belongsTo') {
			return `relation '${relationName}' is '${relation.type ?? 'unknown'}'; A-lite only supports relations whose FK column is on the binding source table`;
		}
		if (fkColumns.length === 0) {
			return `relation '${relationName}' must have at least one FK column for A-lite binding relation filters`;
		}
		for (const fkColumn of fkColumns) {
			const directProjection = metadata.directProjectionLineage?.find(
				(projection) =>
					projection.sourceTable === sourceTable &&
					ColumnValidator.columnsMatch(projection.sourceColumn, fkColumn),
			);
			if (!directProjection) {
				const available = this.virtualBindingTables
					.get(bindingName)
					?.join(', ');
				return `relation '${relationName}' FK column '${fkColumn}' is not projected as a direct source-column projection by binding '${bindingName}'${available ? ` (available columns: ${available})` : ''}`;
			}
		}
		const available = this.virtualBindingTables.get(bindingName)?.join(', ');
		return `relation '${relationName}' FK columns '${fkColumns.join(', ')}' are not available through binding '${bindingName}'${available ? ` (available columns: ${available})` : ''}`;
	}

	explainVirtualBindingScalarRelationRejection(
		bindingName: string,
		relationName: string,
	): string {
		const metadata = this.virtualBindingRelationFilters.get(bindingName);
		if (!metadata) {
			return 'no binding relation metadata is available';
		}
		if (metadata.unsafeReason) return metadata.unsafeReason;
		const sourceTable = metadata.sourceTable;
		if (!sourceTable) {
			return 'the binding source table could not be proven';
		}
		const recursiveReason =
			this.explainVirtualBindingRecursiveScalarRelationRejection(
				bindingName,
				relationName,
				sourceTable,
				metadata,
			);
		if (recursiveReason) return recursiveReason;
		const relation = this.getRelation(sourceTable, relationName);
		if (!relation) {
			return `relation '${relationName}' is not declared on source table '${sourceTable}'`;
		}
		if (relation.type === 'belongsToMany') {
			if (
				relation.recursive !== undefined ||
				(relation.source !== undefined && relation.source === relation.target)
			) {
				return `relation '${relationName}' is recursive/self-referential; binding relation columns for recursive relations require recursive CTE handling and are not supported (ref-#193)`;
			}
			if (
				typeof relation.through !== 'string' ||
				relation.through.length === 0
			) {
				return `relation '${relationName}' is many-to-many but does not declare a resolvable junction table (ref-#192)`;
			}
			const sourceColumns =
				toColumnList(relation.sourceKey).length > 0
					? toColumnList(relation.sourceKey)
					: ['id'];
			const throughSourceColumns = toColumnList(relation.foreignKey);
			const throughTargetColumns = toColumnList(relation.otherKey);
			const targetColumns =
				toColumnList(relation.targetKey).length > 0
					? toColumnList(relation.targetKey)
					: ['id'];
			if (sourceColumns.length !== 1) {
				return `relation '${relationName}' source key is composite; binding many-to-many relation columns require a single source key column (ref-#179)`;
			}
			if (throughSourceColumns.length !== 1) {
				return `relation '${relationName}' junction source FK is composite or missing; binding many-to-many relation columns require a single junction source FK column (ref-#179)`;
			}
			if (throughTargetColumns.length !== 1) {
				return `relation '${relationName}' junction target FK is composite or missing; binding many-to-many relation columns require a single junction target FK column (ref-#179)`;
			}
			if (targetColumns.length !== 1) {
				return `relation '${relationName}' target key is composite; binding many-to-many relation columns require a single target key column (ref-#179)`;
			}
			const [sourceColumn] = sourceColumns;
			if (sourceColumn === undefined) {
				return `relation '${relationName}' source key is missing; binding many-to-many relation columns require a single source key column (ref-#179)`;
			}
			const directProjection = metadata.directProjectionLineage?.find(
				(projection) =>
					projection.sourceTable === sourceTable &&
					ColumnValidator.columnsMatch(projection.sourceColumn, sourceColumn),
			);
			if (!directProjection) {
				const available = this.virtualBindingTables
					.get(bindingName)
					?.join(', ');
				return `relation '${relationName}' source key column '${sourceColumn}' is not projected as a direct source-column projection by binding '${bindingName}'${available ? ` (available columns: ${available})` : ''}`;
			}
			const available = this.virtualBindingTables.get(bindingName)?.join(', ');
			return `relation '${relationName}' many-to-many source column '${sourceColumn}' is not available through binding '${bindingName}'${available ? ` (available columns: ${available})` : ''}`;
		}
		const unsupportedReason = explainUnsupportedNqlBindingIncludeHop(
			relationName,
			relation,
		);
		if (unsupportedReason) return unsupportedReason;
		const fkColumns = toColumnList(relation.foreignKey);
		const sourceColumns =
			relation.type === 'belongsTo'
				? fkColumns
				: toColumnList(relation.sourceKey).length > 0
					? toColumnList(relation.sourceKey)
					: ['id'];
		for (const sourceColumn of sourceColumns) {
			const directProjection = metadata.directProjectionLineage?.find(
				(projection) =>
					projection.sourceTable === sourceTable &&
					ColumnValidator.columnsMatch(projection.sourceColumn, sourceColumn),
			);
			if (!directProjection) {
				const available = this.virtualBindingTables
					.get(bindingName)
					?.join(', ');
				const sourceColumnLabel =
					relation.type === 'belongsTo' ? 'FK column' : 'source key column';
				return `relation '${relationName}' ${sourceColumnLabel} '${sourceColumn}' is not projected as a direct source-column projection by binding '${bindingName}'${available ? ` (available columns: ${available})` : ''}`;
			}
		}
		const available = this.virtualBindingTables.get(bindingName)?.join(', ');
		return `relation '${relationName}' source columns '${sourceColumns.join(', ')}' are not available through binding '${bindingName}'${available ? ` (available columns: ${available})` : ''}`;
	}

	private static recursiveDirection(value: unknown): 'up' | 'down' | undefined {
		if (value === null || typeof value !== 'object') return undefined;
		const direction = (value as { readonly direction?: unknown }).direction;
		if (direction === 'up' || direction === 'ancestors') return 'up';
		if (direction === 'down' || direction === 'descendants') return 'down';
		return undefined;
	}

	private explainVirtualBindingRecursiveScalarRelationRejection(
		bindingName: string,
		relationName: string,
		sourceTable: string,
		metadata: NqlBindingRelationFilterMetadata,
	): string | undefined {
		const lowerRelationName = relationName.toLowerCase();
		const pseudoColumn = this.getPseudoColumns(sourceTable).find(
			(candidate) =>
				candidate.ascendantKeyword?.toLowerCase() === lowerRelationName ||
				candidate.descendantKeyword?.toLowerCase() === lowerRelationName,
		);
		if (!pseudoColumn) return undefined;
		const direction =
			pseudoColumn.ascendantKeyword?.toLowerCase() === lowerRelationName
				? 'up'
				: 'down';
		const recursiveRelations = this.getRelationsFrom(sourceTable).filter(
			(relation) =>
				relation.recursive !== undefined &&
				relation.source === relation.target &&
				relation.source === sourceTable &&
				ColumnValidator.recursiveDirection(relation.recursive) === direction,
		);
		if (recursiveRelations.length === 0) {
			return `recursive traversal '${relationName}' is missing recursive relation metadata for direction '${direction}' (ref-#193)`;
		}
		for (const relation of recursiveRelations) {
			const relationFkColumns = toColumnList(relation.foreignKey);
			const fkColumns =
				relationFkColumns.length > 0
					? relationFkColumns
					: toColumnList(pseudoColumn.foreignKeyColumn);
			if (fkColumns.length !== 1) {
				return `relation '${relation.name}' self-ref FK is composite or missing; binding recursive relation columns require a single self-ref FK column (ref-#193)`;
			}
			const relationTargetColumns = toColumnList(relation.targetKey);
			const targetColumns =
				relationTargetColumns.length > 0
					? relationTargetColumns
					: pseudoColumn.targetColumn !== undefined
						? [pseudoColumn.targetColumn]
						: [DEFAULT_RELATION_TARGET_COLUMN];
			if (targetColumns.length !== 1) {
				return `relation '${relation.name}' target key is composite; binding recursive relation columns require a single target key column (ref-#193)`;
			}
			const selfRefColumn = fkColumns[0];
			const targetKeyColumn = targetColumns[0];
			if (selfRefColumn === undefined || targetKeyColumn === undefined) {
				return `relation '${relation.name}' recursive metadata is missing a single-column seed; binding recursive relation columns require a single self-ref FK and target key column (ref-#193)`;
			}
			if (
				(pseudoColumn.foreignKeyColumn !== undefined &&
					!ColumnValidator.columnsMatch(
						pseudoColumn.foreignKeyColumn,
						selfRefColumn,
					)) ||
				(pseudoColumn.targetColumn !== undefined &&
					!ColumnValidator.columnsMatch(
						pseudoColumn.targetColumn,
						targetKeyColumn,
					))
			) {
				continue;
			}
			const seedColumn = direction === 'up' ? selfRefColumn : targetKeyColumn;
			const directProjection = metadata.directProjectionLineage?.find(
				(projection) =>
					projection.sourceTable === sourceTable &&
					ColumnValidator.columnsMatch(projection.sourceColumn, seedColumn),
			);
			if (!directProjection) {
				const available = this.virtualBindingTables
					.get(bindingName)
					?.join(', ');
				const seedLabel =
					direction === 'up' ? 'self-ref FK column' : 'target key column';
				return `recursive traversal '${relationName}' ${seedLabel} '${seedColumn}' is not projected as a direct source-column projection by binding '${bindingName}'${available ? ` (available columns: ${available})` : ''} (ref-#193)`;
			}
			return undefined;
		}
		return `recursive traversal '${relationName}' pseudo metadata does not match a single-column recursive self-reference (ref-#193)`;
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

	resolvePhysicalColumnName(table: string, column: string): string | undefined {
		if (column === '*') return column;
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
			const virtualRelation = this.getVirtualBindingRelation(
				sourceTable,
				relationName,
			);
			if (virtualRelation) return virtualRelation.targetTable;
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				`Query '${sourceTable}' reads from an NQL binding and cannot use relation filters (${relationName}) under A-lite (ref-#182): ${this.explainVirtualBindingRelationRejection(sourceTable, relationName)}.`,
			);
		}
		const rel = this.getRelation(sourceTable, relationName);
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
