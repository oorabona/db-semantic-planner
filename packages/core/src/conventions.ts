/**
 * Schema Convention Inference
 *
 * Detects foreign keys and M:N relations using:
 * 1. Explicit `references` (highest priority)
 * 2. Convention patterns (fallback)
 *
 * M:N auto-detection: tables with exactly 2 FKs and no business columns.
 *
 * Migrated from @dbsp/schema/conventions.ts as part of ARCH-003.
 */

import type {
	SchemaBelongsToRelation,
	SchemaColumnDefinition,
	SchemaConventionsDefinition,
	SchemaHasManyRelation,
	SchemaManyToManyRelation,
	SchemaRelationsDefinition,
	SchemaTableDefinition,
	SchemaTablesDefinition,
} from './schema-dsl-types.js';

// =============================================================================
// Default Conventions
// =============================================================================

export const DEFAULT_CONVENTIONS: Required<SchemaConventionsDefinition> = {
	fkPattern: '{singular}Id',
	pluralize: true,
	timestamps: ['createdAt', 'updatedAt'],
	fkAutoIndex: true,
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Convert table name to singular form.
 * Simple heuristic: remove trailing 's' if present.
 */
/**
 * Built-in mapping of irregular plural forms to their singular equivalents.
 * Import and extend this to handle domain-specific irregular plurals:
 *
 * ```ts
 * import { IRREGULAR_PLURALS, singularize } from '@dbsp/core';
 * const custom = { ...IRREGULAR_PLURALS, matrices: 'matrix', indices: 'index' };
 * singularize('matrices', custom); // 'matrix'
 * ```
 */
export const IRREGULAR_PLURALS: Record<string, string> = {
	people: 'person',
	children: 'child',
	men: 'man',
	women: 'woman',
	teeth: 'tooth',
	feet: 'foot',
	geese: 'goose',
	mice: 'mouse',
	data: 'datum',
	media: 'medium',
	criteria: 'criterion',
	phenomena: 'phenomenon',
};

export function singularize(
	name: string,
	overrides?: Record<string, string>,
): string {
	const lower = name.toLowerCase();

	// Check user-provided overrides first
	if (overrides) {
		const override = overrides[lower];
		if (override !== undefined) {
			if (name[0]?.toUpperCase() === name[0]) {
				return override.charAt(0).toUpperCase() + override.slice(1);
			}
			return override;
		}
	}

	// Check built-in irregular plurals
	const irregular = IRREGULAR_PLURALS[lower];
	if (irregular !== undefined) {
		// Preserve original case pattern
		if (name[0]?.toUpperCase() === name[0]) {
			return irregular.charAt(0).toUpperCase() + irregular.slice(1);
		}
		return irregular;
	}

	// Handle 'ies' → 'y' (categories → category)
	if (lower.endsWith('ies') && name.length > 3) {
		return `${name.slice(0, -3)}y`;
	}

	// Handle 'es' for words ending in -shes, -ches, -xes, -zes, -ses (boxes → box)
	// But NOT for -les, -res, -tes, etc. (profiles → profile, not profil)
	if (
		lower.endsWith('es') &&
		name.length > 2 &&
		(lower.endsWith('shes') ||
			lower.endsWith('ches') ||
			lower.endsWith('xes') ||
			lower.endsWith('zes') ||
			(lower.endsWith('ses') &&
				!lower.endsWith('ases') &&
				!lower.endsWith('uses')))
	) {
		return name.slice(0, -2);
	}

	// Handle regular plurals ending in 's' (but not 'ss')
	if (lower.endsWith('s') && !lower.endsWith('ss') && name.length > 1) {
		return name.slice(0, -1);
	}

	// Already singular or unknown pattern
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

/**
 * Get the inverse relation name for a self-referential FK.
 * Special case: parent → children (most common hierarchy pattern).
 * Otherwise: pluralize the belongsTo name (manager → managers).
 */
export function getSelfRefInverseName(belongsToName: string): string {
	// The most common self-ref pattern
	if (belongsToName === 'parent') return 'children';

	// For other cases, just pluralize (manager → managers)
	return pluralize(belongsToName);
}

/**
 * Pseudo-column metadata for a self-referential FK.
 * Exported for use by schema builder.
 */
interface SelfRefPseudoColumn {
	/** FK column name (e.g., 'parentId', 'managerId') */
	foreignKeyColumn: string;
	/** Target column (usually 'id') */
	targetColumn: string;
	/** Parent role name (e.g., 'parent', 'manager') */
	parentRole: string;
	/** Child role name (e.g., 'children', 'subordinates') */
	childRole: string;
}

/**
 * Extract pseudo-column metadata from detected FKs.
 * Only self-referential FKs produce pseudo-columns.
 */
export function extractSelfRefPseudoColumns(
	tableName: string,
	fks: DetectedFK[],
): SelfRefPseudoColumn[] {
	const selfRefFKs = fks.filter((fk) => fk.targetTable === tableName);
	if (selfRefFKs.length === 0) return [];

	// Single self-ref FK: use default parent/child keywords
	// Multiple self-ref FKs: require explicit roles (validated elsewhere)
	return selfRefFKs.map((fk) => ({
		foreignKeyColumn: fk.column,
		targetColumn: fk.targetColumn,
		parentRole: fk.parentRole ?? fk.inferredName,
		childRole: fk.childRole ?? getSelfRefInverseName(fk.inferredName),
	}));
}

/**
 * Validate self-referential FK roles for a table.
 * Returns error messages if validation fails.
 */
export function validateSelfRefRoles(
	tableName: string,
	pseudoColumns: SelfRefPseudoColumn[],
	reservedNames: Set<string> = new Set([
		'parent',
		'child',
		'ascendant',
		'descendant',
	]),
): string[] {
	const errors: string[] = [];

	if (pseudoColumns.length === 0) return errors;

	// Collect all role names for collision detection
	const allRoles = new Set<string>();

	for (const pc of pseudoColumns) {
		// Check reserved name collision (only for multi-FK tables)
		if (pseudoColumns.length > 1) {
			if (reservedNames.has(pc.parentRole)) {
				errors.push(
					`Table '${tableName}': parentRole '${pc.parentRole}' conflicts with reserved keyword. Use a custom role name.`,
				);
			}
			if (reservedNames.has(pc.childRole)) {
				errors.push(
					`Table '${tableName}': childRole '${pc.childRole}' conflicts with reserved keyword. Use a custom role name.`,
				);
			}
		}

		// Check cross-collision between different FKs
		if (allRoles.has(pc.parentRole)) {
			errors.push(
				`Table '${tableName}': duplicate parentRole '${pc.parentRole}'. Each self-ref FK needs unique roles.`,
			);
		}
		if (allRoles.has(pc.childRole)) {
			errors.push(
				`Table '${tableName}': duplicate childRole '${pc.childRole}'. Each self-ref FK needs unique roles.`,
			);
		}

		allRoles.add(pc.parentRole);
		allRoles.add(pc.childRole);
	}

	return errors;
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
	/** Custom parent role for self-ref FKs (from parentRole or inferred) */
	parentRole?: string;
	/** Custom child role for self-ref FKs (from childRole or inferred) */
	childRole?: string;
}

/**
 * Detect foreign keys in a table.
 * Priority: explicit `references` > convention pattern.
 */
export function detectForeignKeys(
	tableName: string,
	table: SchemaTableDefinition,
	conventions: Required<SchemaConventionsDefinition>,
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

				const isSelfRef = targetTable === tableName;
				const detectedFK: DetectedFK = {
					column: colName,
					targetTable,
					inferredName,
					explicit: true,
					targetColumn: colDef.references.column ?? 'id',
				};

				// Add self-ref roles if applicable
				if (isSelfRef) {
					detectedFK.parentRole = colDef.references.parentRole ?? inferredName;
					detectedFK.childRole =
						colDef.references.childRole ?? getSelfRefInverseName(inferredName);
				}

				fks.push(detectedFK);
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
						// Auto-infer roles for convention-based self-ref FKs
						parentRole: prefix,
						childRole: getSelfRefInverseName(prefix),
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
	colDef: SchemaColumnDefinition,
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
	tables: SchemaTablesDefinition,
	conventions: Required<SchemaConventionsDefinition>,
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
export function inferRelationsFromSchema(
	tables: SchemaTablesDefinition,
	conventions: Required<SchemaConventionsDefinition>,
	explicitRelations: SchemaRelationsDefinition = {},
): SchemaRelationsDefinition {
	const result: SchemaRelationsDefinition = { ...explicitRelations };
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
			const rel: SchemaManyToManyRelation = {
				kind: 'manyToMany',
				target: tableB,
				through: junction,
				sourceFk: fkA,
				targetFk: fkB,
			};
			result[keyAtoB] = rel;
		}

		if (!(keyBtoA in result)) {
			const rel: SchemaManyToManyRelation = {
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
				const rel: SchemaBelongsToRelation = {
					kind: 'belongsTo',
					target: fk.targetTable,
					foreignKey: fk.column,
					targetKey: fk.targetColumn,
				};
				result[belongsToKey] = rel;
			}

			// HasMany: target has many of source (inverse)
			// For self-referential FKs, use semantic inverse name (parent → children)
			const isSelfRef = fk.targetTable === tableName;
			const hasManyName = isSelfRef
				? getSelfRefInverseName(fk.inferredName)
				: conventions.pluralize
					? pluralize(singularize(tableName))
					: tableName;
			const hasManyKey = `${fk.targetTable}.${hasManyName}`;
			if (!(hasManyKey in result)) {
				const rel: SchemaHasManyRelation = {
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
