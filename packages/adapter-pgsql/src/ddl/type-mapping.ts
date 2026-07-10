/**
 * Type Mapping - Maps ModelIR ColumnType to PostgreSQL data types
 *
 * Supports both manual schemas and introspected schemas (preserving originalDbType).
 * Handles auto-increment via SERIAL/BIGSERIAL types.
 *
 * @module ddl/type-mapping
 */

import type { ColumnIR } from '@dbsp/types';
import { isPgBuiltInTypeName, renderColumnDbType } from '../db-type.js';
import { validateDbTypeName } from '../validate.js';

/**
 * Map ColumnType to PostgreSQL data type string.
 *
 * Uses originalDbType if available (from introspection), otherwise
 * falls back to reasonable PostgreSQL defaults.
 *
 * @param col - Column definition from ModelIR
 * @returns PostgreSQL type string (e.g., 'VARCHAR(255)', 'SERIAL', 'JSONB')
 */
export function mapColumnType(col: ColumnIR, targetSchema?: string): string {
	// Prefer original DB type if available (preserves precision/scale).
	if (col.originalDbType?.trim()) {
		const dbType = validateDbTypeName(renderColumnDbType(col, targetSchema));
		return isPgBuiltInTypeName(dbType)
			? uppercaseOutsideQuotedIdentifiers(dbType)
			: dbType;
	}

	// Auto-increment columns use SERIAL/BIGSERIAL
	if (col.autoIncrement) {
		return col.type === 'bigint' ? 'BIGSERIAL' : 'SERIAL';
	}

	const dbType = validateDbTypeName(renderColumnDbType(col, targetSchema));
	return isPgBuiltInTypeName(dbType)
		? uppercaseOutsideQuotedIdentifiers(dbType)
		: dbType;
}

function uppercaseOutsideQuotedIdentifiers(type: string): string {
	let result = '';
	let inQuotedIdentifier = false;

	for (let i = 0; i < type.length; i++) {
		const char = type[i]!;

		if (char === '"') {
			result += char;

			if (inQuotedIdentifier && type[i + 1] === '"') {
				result += type[i + 1];
				i++;
				continue;
			}

			inQuotedIdentifier = !inQuotedIdentifier;
			continue;
		}

		result += inQuotedIdentifier ? char : char.toUpperCase();
	}

	return result;
}

/**
 * Map OnDeleteAction to PostgreSQL syntax.
 */
export function mapOnDeleteAction(action?: string): string {
	switch (action) {
		case 'CASCADE':
			return 'CASCADE';
		case 'SET NULL':
			return 'SET NULL';
		case 'SET DEFAULT':
			return 'SET DEFAULT';
		case 'RESTRICT':
			return 'RESTRICT';
		default:
			return 'NO ACTION';
	}
}
