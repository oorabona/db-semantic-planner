/**
 * Naming and self-reference convention helpers.
 */

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

interface DetectedFK {
	/** Column name in source table */
	column: string;
	/** Target table name */
	targetTable: string;
	/** Inferred relation name (e.g., 'author' from 'authorId') */
	inferredName: string;
	/** Target column (from references.column or default 'id') */
	targetColumn: string;
	/** Custom parent role for self-ref FKs (from parentRole or inferred) */
	parentRole?: string;
	/** Custom child role for self-ref FKs (from childRole or inferred) */
	childRole?: string;
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
