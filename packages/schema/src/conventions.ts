/**
 * ARCH-002 Block 2: Convention Inference
 *
 * Detects foreign keys and M:N relations using:
 * 1. Explicit `references` (highest priority)
 * 2. Convention patterns (fallback)
 *
 * M:N auto-detection: tables with exactly 2 FKs and no business columns.
 */

import type {
	BelongsToRelation,
	ColumnDefinition,
	ConventionsDefinition,
	HasManyRelation,
	ManyToManyRelation,
	RelationsDefinition,
	TableDefinition,
	TablesDefinition,
} from './types.js';

// =============================================================================
// Default Conventions
// =============================================================================

export const DEFAULT_CONVENTIONS: Required<ConventionsDefinition> = {
	fkPattern: '{singular}Id',
	pluralize: true,
	timestamps: ['createdAt', 'updatedAt'],
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Convert table name to singular form.
 * Simple heuristic: remove trailing 's' if present.
 */
export function singularize(name: string): string {
	if (name.endsWith('ies')) {
		return `${name.slice(0, -3)}y`;
	}
	if (name.endsWith('es') && !name.endsWith('ases') && !name.endsWith('uses')) {
		return name.slice(0, -2);
	}
	if (name.endsWith('s') && !name.endsWith('ss')) {
		return name.slice(0, -1);
	}
	return name;
}

/**
 * Convert table name to plural form.
 * Simple heuristic: add 's' or 'es' or 'ies'.
 */
export function pluralize(name: string): string {
	if (
		name.endsWith('y') &&
		!['ay', 'ey', 'oy', 'uy'].some((s) => name.endsWith(s))
	) {
		return `${name.slice(0, -1)}ies`;
	}
	if (
		name.endsWith('s') ||
		name.endsWith('x') ||
		name.endsWith('ch') ||
		name.endsWith('sh')
	) {
		return `${name}es`;
	}
	return `${name}s`;
}

/**
 * Capitalize first letter.
 */
export function capitalize(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Decapitalize first letter.
 */
export function decapitalize(name: string): string {
	return name.charAt(0).toLowerCase() + name.slice(1);
}

// =============================================================================
// FK Detection
// =============================================================================

interface DetectedFK {
	/** Column name in source table */
	column: string;
	/** Target table name */
	targetTable: string;
	/** Inferred relation name (e.g., 'author' from 'authorId') */
	inferredName: string;
	/** Whether this was explicitly defined via `references` */
	explicit: boolean;
	/** Target column (from references.column or default 'id') */
	targetColumn: string;
}

/**
 * Detect foreign keys in a table.
 * Priority: explicit `references` > convention pattern.
 */
export function detectForeignKeys(
	tableName: string,
	table: TableDefinition,
	conventions: Required<ConventionsDefinition>,
	tableNames: Set<string>,
): DetectedFK[] {
	const fks: DetectedFK[] = [];
	const pattern = conventions.fkPattern;

	for (const [colName, colDef] of Object.entries(table)) {
		// PRIORITY 1: Explicit `references` takes precedence
		if (colDef.references) {
			const targetTable = colDef.references.table;
			if (tableNames.has(targetTable)) {
				// Infer relation name from column (remove 'Id' suffix if present)
				const inferredName = colName.endsWith('Id')
					? colName.slice(0, -2)
					: singularize(targetTable);

				fks.push({
					column: colName,
					targetTable,
					inferredName,
					explicit: true,
					targetColumn: colDef.references.column ?? 'id',
				});
			}
			continue; // Skip convention check if explicit reference exists
		}

		// PRIORITY 2: Convention-based detection
		// Pattern like '{singular}Id' → check if column matches any table's singular form
		for (const candidateTable of tableNames) {
			if (candidateTable === tableName) continue; // Skip self (handled separately)

			const singular = singularize(candidateTable);
			const expectedColumn = pattern.replace('{singular}', singular);

			if (colName === expectedColumn) {
				fks.push({
					column: colName,
					targetTable: candidateTable,
					inferredName: singular,
					explicit: false,
					targetColumn: 'id',
				});
				break;
			}
		}

		// Check for self-referential FK (e.g., parentId → same table)
		if (colName.endsWith('Id')) {
			const prefix = colName.slice(0, -2);
			const singular = singularize(tableName);
			// Common self-ref patterns: parentId, managerId, etc.
			if (
				['parent', 'manager', 'supervisor', 'owner', singular].includes(prefix)
			) {
				if (!fks.some((fk) => fk.column === colName)) {
					fks.push({
						column: colName,
						targetTable: tableName,
						inferredName: prefix,
						explicit: false,
						targetColumn: 'id',
					});
				}
			}
		}
	}

	return fks;
}

// =============================================================================
// M:N Detection
// =============================================================================

interface DetectedManyToMany {
	/** Junction table name */
	junction: string;
	/** First table in the M:N relation */
	tableA: string;
	/** Second table in the M:N relation */
	tableB: string;
	/** FK column pointing to tableA */
	fkA: string;
	/** FK column pointing to tableB */
	fkB: string;
}

/**
 * Check if a column is a "business" column (not FK, not metadata).
 */
function isBusinessColumn(
	colName: string,
	colDef: ColumnDefinition,
	timestamps: string[],
): boolean {
	// Primary key is not business data
	if (colDef.primaryKey) return false;
	// Timestamp columns are metadata
	if (timestamps.includes(colName)) return false;
	// FK columns are not business data (they reference other tables)
	if (colDef.references) return false;
	// Columns ending in 'Id' are likely FKs (convention)
	if (colName.endsWith('Id')) return false;
	// Common metadata columns
	if (['id', 'createdBy', 'updatedBy', 'deletedAt'].includes(colName))
		return false;

	// Everything else is business data
	return true;
}

/**
 * Detect pure M:N junction tables.
 * Criteria: exactly 2 FK columns, no business columns.
 */
export function detectManyToMany(
	tables: TablesDefinition,
	conventions: Required<ConventionsDefinition>,
	tableNames: Set<string>,
): DetectedManyToMany[] {
	const results: DetectedManyToMany[] = [];

	for (const [tableName, table] of Object.entries(tables)) {
		const fks = detectForeignKeys(tableName, table, conventions, tableNames);

		// Must have exactly 2 FKs
		if (fks.length !== 2) continue;

		// Check for business columns
		const hasBusinessColumns = Object.entries(table).some(([colName, colDef]) =>
			isBusinessColumn(colName, colDef, conventions.timestamps),
		);

		if (hasBusinessColumns) continue;

		// This is a pure junction table
		const fkA = fks[0];
		const fkB = fks[1];
		if (fkA && fkB) {
			results.push({
				junction: tableName,
				tableA: fkA.targetTable,
				tableB: fkB.targetTable,
				fkA: fkA.column,
				fkB: fkB.column,
			});
		}
	}

	return results;
}

// =============================================================================
// Relation Inference
// =============================================================================

/**
 * Infer all relations from table definitions.
 * Returns a map of 'sourceTable.relationName' → RelationDefinition.
 */
export function inferRelations(
	tables: TablesDefinition,
	conventions: Required<ConventionsDefinition>,
	explicitRelations: RelationsDefinition = {},
): RelationsDefinition {
	const result: RelationsDefinition = { ...explicitRelations };
	const tableNames = new Set(Object.keys(tables));

	// First pass: detect M:N relations (junction tables)
	const manyToManys = detectManyToMany(tables, conventions, tableNames);
	const junctionTables = new Set(manyToManys.map((m) => m.junction));

	// Add M:N relations (bidirectional)
	for (const m2m of manyToManys) {
		const { junction, tableA, tableB, fkA, fkB } = m2m;

		// Use opposite table name for relation path (not junction name)
		const relNameAtoB = conventions.pluralize
			? pluralize(singularize(tableB))
			: tableB;
		const relNameBtoA = conventions.pluralize
			? pluralize(singularize(tableA))
			: tableA;

		const keyAtoB = `${tableA}.${relNameAtoB}`;
		const keyBtoA = `${tableB}.${relNameBtoA}`;

		// Only add if not explicitly defined
		if (!(keyAtoB in result)) {
			const rel: ManyToManyRelation = {
				kind: 'manyToMany',
				target: tableB,
				through: junction,
				sourceFk: fkA,
				targetFk: fkB,
			};
			result[keyAtoB] = rel;
		}

		if (!(keyBtoA in result)) {
			const rel: ManyToManyRelation = {
				kind: 'manyToMany',
				target: tableA,
				through: junction,
				sourceFk: fkB,
				targetFk: fkA,
			};
			result[keyBtoA] = rel;
		}
	}

	// Second pass: detect 1:N and N:1 relations (skip junction tables)
	for (const [tableName, table] of Object.entries(tables)) {
		if (junctionTables.has(tableName)) continue;

		const fks = detectForeignKeys(tableName, table, conventions, tableNames);

		for (const fk of fks) {
			// Skip FKs that point to junction tables
			if (junctionTables.has(fk.targetTable)) continue;

			// BelongsTo: source has FK to target
			const belongsToKey = `${tableName}.${fk.inferredName}`;
			if (!(belongsToKey in result)) {
				const rel: BelongsToRelation = {
					kind: 'belongsTo',
					target: fk.targetTable,
					foreignKey: fk.column,
					targetKey: fk.targetColumn,
				};
				result[belongsToKey] = rel;
			}

			// HasMany: target has many of source (inverse)
			const hasManyName = conventions.pluralize
				? pluralize(singularize(tableName))
				: tableName;
			const hasManyKey = `${fk.targetTable}.${hasManyName}`;
			if (!(hasManyKey in result)) {
				const rel: HasManyRelation = {
					kind: 'hasMany',
					target: tableName,
					foreignKey: fk.column,
					sourceKey: 'id',
				};
				result[hasManyKey] = rel;
			}
		}
	}

	return result;
}
