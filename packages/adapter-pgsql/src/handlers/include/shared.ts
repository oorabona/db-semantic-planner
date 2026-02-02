/**
 * Shared utilities for include strategy handlers.
 *
 * Extracted from lateral.ts and json-agg.ts to eliminate FK direction duplication.
 */

import {
	DEFAULT_PK_COLUMN,
	defaultFkDerivation,
	type FkColumnDerivation,
} from '../../assert-field.js';
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
	defaultPk: string = DEFAULT_PK_COLUMN,
	deriveFk: FkColumnDerivation = defaultFkDerivation,
): { sourceColumn: string; targetColumn: string } {
	if (decision.relationType === 'belongsTo') {
		return {
			sourceColumn:
				decision.foreignKey ??
				(decision.targetTable
					? deriveFk(decision.targetTable, defaultPk)
					: defaultPk),
			targetColumn: decision.parentKey ?? defaultPk,
		};
	}
	// hasMany or hasOne
	return {
		sourceColumn: decision.parentKey ?? defaultPk,
		targetColumn: decision.foreignKey ?? deriveFk(parentTable, defaultPk),
	};
}
