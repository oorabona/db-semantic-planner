/**
 * Shared utilities for include strategy handlers.
 *
 * Extracted from lateral.ts and json-agg.ts to eliminate FK direction duplication.
 */

import type { ColumnListInput } from '@dbsp/types';
import {
	DEFAULT_PK_COLUMN,
	defaultFkDerivation,
	type FkColumnDerivation,
} from '../../assert-field.js';

/** Minimal shape required by deriveFkColumns — works with both Decision and PlanDecision. */
export interface FkColumnSource {
	readonly relationType?: 'belongsTo' | 'hasMany' | 'hasOne';
	readonly foreignKey?: ColumnListInput;
	readonly parentKey?: ColumnListInput;
	readonly targetTable?: string;
}

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
	decision: FkColumnSource,
	parentTable: string,
	defaultPk: string = DEFAULT_PK_COLUMN,
	deriveFk: FkColumnDerivation = defaultFkDerivation,
): { sourceColumn: ColumnListInput; targetColumn: ColumnListInput } {
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
