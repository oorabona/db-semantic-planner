/**
 * Shared utilities for include strategy handlers.
 *
 * Extracted from lateral.ts and json-agg.ts to eliminate FK direction duplication.
 */

import type { Decision } from '../types.js';

/**
 * Derive the source (parent-side) and target (child-side) column names
 * based on the relation type and FK configuration.
 *
 * For belongsTo: the FK is on the parent side (e.g., user_roles.role_id → roles.id)
 *   → sourceColumn = foreignKey (role_id), targetColumn = parentKey (id)
 * For hasMany/hasOne: the FK is on the child side (e.g., roles.id ← role_permissions.role_id)
 *   → sourceColumn = parentKey (id), targetColumn = foreignKey (role_id)
 */
export function deriveFkColumns(
	decision: Decision,
	parentTable: string,
): { sourceColumn: string; targetColumn: string } {
	if (decision.relationType === 'belongsTo') {
		return {
			sourceColumn: decision.foreignKey ?? `${decision.targetTable}_id`,
			targetColumn: decision.parentKey ?? 'id',
		};
	}
	// hasMany or hasOne
	return {
		sourceColumn: decision.parentKey ?? 'id',
		targetColumn: decision.foreignKey ?? `${parentTable}_id`,
	};
}
