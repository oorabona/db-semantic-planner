/**
 * Type Mapping - Maps ModelIR ColumnType to PostgreSQL data types
 *
 * Supports both manual schemas and introspected schemas (preserving originalDbType).
 * Handles auto-increment via SERIAL/BIGSERIAL types.
 *
 * @module ddl/type-mapping
 */

import type { ColumnIR, ColumnType } from '@dbsp/types';
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
export function mapColumnType(col: ColumnIR): string {
	// Prefer original DB type if available (preserves precision/scale)
	if (col.originalDbType) {
		return validateDbTypeName(col.originalDbType);
	}

	// Auto-increment columns use SERIAL/BIGSERIAL
	if (col.autoIncrement) {
		return col.type === 'bigint' ? 'BIGSERIAL' : 'SERIAL';
	}

	// Standard type mapping
	return mapBaseType(col.type);
}

/**
 * Map base ColumnType to PostgreSQL type (without auto-increment handling).
 */
function mapBaseType(type: ColumnType): string {
	switch (type) {
		case 'string':
			return 'VARCHAR(255)';
		case 'text':
			return 'TEXT';
		case 'number':
		case 'integer':
			return 'INTEGER';
		case 'bigint':
			return 'BIGINT';
		case 'decimal':
			return 'NUMERIC';
		case 'boolean':
			return 'BOOLEAN';
		case 'date':
			return 'DATE';
		case 'time':
			return 'TIME';
		case 'datetime':
		case 'timestamp':
			return 'TIMESTAMPTZ';
		case 'json':
		case 'jsonb':
			return 'JSONB';
		case 'uuid':
			return 'UUID';
		// PostgreSQL-specific range types
		case 'daterange':
			return 'DATERANGE';
		case 'tsrange':
			return 'TSRANGE';
		case 'tstzrange':
			return 'TSTZRANGE';
		case 'int4range':
			return 'INT4RANGE';
		case 'int8range':
			return 'INT8RANGE';
		case 'numrange':
			return 'NUMRANGE';
		default:
			// Fallback for unknown types
			return 'TEXT';
	}
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
