/**
 * Shared compiler utilities for unnest-based batch operations.
 *
 * Used by batch INSERT (Block 2), batch UPDATE (Block 3), batch UPSERT (Block 4),
 * and CTE unnest builder (Block 5).
 */

import { InvalidOperationError } from '@dbsp/core';
import type { Node } from '@pgsql/types';
import { parseExpression } from './raw-expression-parser.js';

// ============================================================================
// Type Inference
// ============================================================================

/**
 * Infer PostgreSQL array type for unnest parameter casting.
 * Strategy: schema-driven (columnTypes map) first, runtime fallback if absent.
 *
 * Only produces whitelisted PG types per INV-05:
 *   int4[], int8[], float8[], text[], bool[], jsonb[], uuid[], date[], timestamptz[]
 *   or the raw dbType value for DX-050 custom types.
 */
export function inferPgArrayType(
	columnName: string,
	columnTypes?: Record<string, string>,
	sampleValue?: unknown,
): string {
	// 1. Schema-driven: use column type from ModelIR (via columnTypes map)
	if (columnTypes?.[columnName]) {
		const pgBase = mapToPgBaseType(columnTypes[columnName]);
		return `${pgBase}[]`;
	}

	// 2. Runtime fallback: infer from sample value type
	if (sampleValue !== null && sampleValue !== undefined) {
		if (typeof sampleValue === 'number') {
			return Number.isInteger(sampleValue) ? 'int4[]' : 'float8[]';
		}
		if (typeof sampleValue === 'string') return 'text[]';
		if (typeof sampleValue === 'boolean') return 'bool[]';
		if (typeof sampleValue === 'object') return 'jsonb[]';
	}

	// 3. Default fallback (ERR-03: unknown type → text[])
	return 'text[]';
}

/**
 * Map a PostgreSQL type string (as produced by mapColumnType / mapBaseType in type-mapping.ts)
 * to the canonical base type name used in array casts.
 *
 * E.g. "INTEGER" → "int4", "VARCHAR(255)" → "text", "BOOLEAN" → "bool"
 */
function mapToPgBaseType(pgType: string): string {
	// Strip length/precision qualifiers like VARCHAR(255), NUMERIC(10,2)
	const normalized = pgType
		.toUpperCase()
		.replace(/\(.*\)/, '')
		.trim();
	switch (normalized) {
		case 'INTEGER':
		case 'INT':
		case 'INT4':
		case 'SERIAL':
			return 'int4';
		case 'BIGINT':
		case 'INT8':
		case 'BIGSERIAL':
			return 'int8';
		case 'SMALLINT':
		case 'INT2':
			return 'int2';
		case 'REAL':
		case 'FLOAT4':
			return 'float4';
		case 'DOUBLE PRECISION':
		case 'FLOAT8':
		case 'FLOAT':
		case 'NUMERIC':
		case 'DECIMAL':
			return 'float8';
		case 'TEXT':
		case 'VARCHAR':
		case 'CHAR':
		case 'CHARACTER VARYING':
			return 'text';
		case 'BOOLEAN':
		case 'BOOL':
			return 'bool';
		case 'JSON':
		case 'JSONB':
			return 'jsonb';
		case 'UUID':
			return 'uuid';
		case 'TIMESTAMP':
		case 'TIMESTAMPTZ':
		case 'TIMESTAMP WITH TIME ZONE':
			return 'timestamptz';
		case 'DATE':
			return 'date';
		default:
			// Pass through for custom types (DX-050 dbType) — lowercase for consistency
			return pgType.toLowerCase();
	}
}

// ============================================================================
// Array Transposition
// ============================================================================

/**
 * Transpose row-major values to column-major arrays for unnest.
 *
 * Input (rows):   [[1, 'a'], [2, 'b']]
 * Output (cols):  [[1, 2], ['a', 'b']]
 */
export function transposeToColumnArrays(
	columns: string[],
	values: unknown[][],
): unknown[][] {
	return columns.map((_, colIdx) => values.map((row) => row[colIdx]));
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate that all rows have the same number of values as columns.
 * Throws InvalidOperationError on mismatch (INV-02 / ERR-02).
 *
 * PostgreSQL's unnest silently NULL-pads shorter arrays — we must prevent this.
 */
export function validateBatchCardinality(
	columns: string[],
	values: unknown[][],
): void {
	for (let i = 0; i < values.length; i++) {
		const row = values[i];
		if (row === undefined || row.length !== columns.length) {
			throw new InvalidOperationError(
				'insert',
				`Array length mismatch at row ${i}: expected ${columns.length} columns, got ${row?.length ?? 0}`,
			);
		}
	}
}

// ============================================================================
// Raw SQL Expression Parsing
// ============================================================================

/**
 * Parse a raw SQL fragment into a pg AST expression node.
 *
 * Wraps the fragment in `SELECT <fragment>` to obtain a valid statement,
 * then extracts the expression from the first target-list entry.
 * Used by mutation compilers to inject raw SQL into SET clauses.
 *
 * @throws Error if the fragment cannot be parsed as a valid SQL expression.
 * @internal
 */
export function parseRawExpression(sqlFragment: string): Node {
	try {
		return parseExpression(sqlFragment);
	} catch {
		throw new Error(
			`sql(): cannot parse raw SQL fragment as expression: ${sqlFragment}`,
		);
	}
}
