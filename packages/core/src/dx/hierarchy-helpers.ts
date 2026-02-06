/**
 * @module dx/hierarchy-helpers
 * Pure helper functions for recursive/hierarchical query support.
 */

import type { ModelIR } from '../model-ir.js';

/**
 * Extract a named field from a recursive query result.
 *
 * Recursive includes (`ancestors` / `descendants`) add a dynamic property to each row.
 * This helper safely extracts that property without `as any` casts.
 *
 * @internal
 */
export function extractRecursiveField<T>(
	result: T | null | undefined,
	field: 'ancestors' | 'descendants',
): T[] {
	if (result == null) return [];
	const row = result as Record<string, unknown>;
	return (row[field] as T[]) ?? [];
}

/**
 * Find a self-referential relation on a table that matches the desired direction.
 *
 * @param model - The model IR
 * @param table - The table name
 * @param direction - 'ancestors' (needs belongsTo/hasOne) or 'descendants' (needs hasMany)
 * @returns The matching relation or null if not found
 */
export function findSelfRefRelation(
	model: ModelIR,
	table: string,
	direction: 'ancestors' | 'descendants',
): { name: string; type: string } | null {
	// Get all relations from this table
	const tableRelations = model.getRelationsFrom(table);
	if (!tableRelations || tableRelations.length === 0) {
		return null;
	}

	// Find self-referential relations that match the direction
	for (const relation of tableRelations) {
		// Must be self-referential
		if (relation.source !== relation.target) {
			continue;
		}

		// Check if direction matches relation type
		if (direction === 'ancestors') {
			// Need belongsTo or hasOne for ancestor traversal
			if (relation.type === 'belongsTo' || relation.type === 'hasOne') {
				return { name: relation.name, type: relation.type };
			}
		} else {
			// Need hasMany for descendant traversal
			if (relation.type === 'hasMany') {
				return { name: relation.name, type: relation.type };
			}
		}
	}

	return null;
}
