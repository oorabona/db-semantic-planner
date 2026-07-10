/**
 * Shared compiler utilities for unnest-based batch operations.
 *
 * Used by batch INSERT, batch UPDATE, batch UPSERT, and the CTE unnest builder.
 */

import { InvalidOperationError } from '@dbsp/core';
import type { Node } from '@pgsql/types';
import { validateDbType } from './db-type.js';
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
		if (typeof sampleValue === 'bigint') return 'int8[]';
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
 * Map a type string to the canonical PostgreSQL base type name used in array casts.
 * Accepts both PostgreSQL native types (as produced by type-mapping.ts) and
 * ColumnType values from ModelIR (e.g. 'integer', 'string', 'datetime').
 *
 * E.g. "INTEGER" → "int4", "VARCHAR(255)" → "text", "BOOLEAN" → "bool",
 *      "string" → "text", "datetime" → "timestamptz", "number" → "float8"
 */
function mapToPgBaseType(pgType: string): string {
	const trimmedPgType = pgType.trim();
	// Fail closed on any malformed type before mapping, regardless of caller: the
	// built-in switch below strips the modifier, so numeric(foo) / varchar(1 2) /
	// bit(8,-1) would otherwise be silently normalized to a valid base type and
	// bypass the validation contract. Also rejects the invalid [][] element form.
	try {
		validateDbType(trimmedPgType);
	} catch {
		throw new Error(
			`batchValues: invalid type name '${pgType}'. Must be a structurally valid PostgreSQL type name.`,
		);
	}
	const elementType = stripArraySuffix(trimmedPgType);
	// Strip length/precision qualifiers like VARCHAR(255), NUMERIC(10,2). The
	// switch matches case-insensitively (normalized is upper-cased), so a
	// mixed-case built-in spelling (VarChar, Numeric) maps like its canonical
	// form; only a non-built-in name falls through to the custom default.
	const normalized = elementType
		.toUpperCase()
		.replace(/\(.*\)/, '')
		.trim();

	switch (normalized) {
		// ColumnType aliases (lowercase ColumnType values from ModelIR)
		case 'STRING':
			return 'text';
		case 'NUMBER':
			return 'float8';
		case 'DATETIME':
			return 'timestamptz';
		case 'TIME':
			return 'time';
		// PostgreSQL native types
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
			return 'float8';
		case 'NUMERIC':
		case 'DECIMAL':
			return 'numeric';
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
			// Custom types (DX-050 dbType) already validated above. Emit as-is: a
			// bare name folds per PostgreSQL's rules, and a case-sensitive type is
			// already quoted upstream (introspection quotes catalog names).
			return elementType;
	}
}

// ============================================================================
// Array Suffix Helpers
// ============================================================================

/**
 * Strip the trailing `[]` suffix from a PostgreSQL array type string.
 *
 * @example
 * stripArraySuffix('int4[]')  // → 'int4'
 * stripArraySuffix('text[]')  // → 'text'
 * stripArraySuffix('text')    // → 'text'  (no-op if no suffix)
 */
export function stripArraySuffix(pgArrayType: string): string {
	return pgArrayType.endsWith('[]') ? pgArrayType.slice(0, -2) : pgArrayType;
}

// ============================================================================
// ModelIR Type Mapping
// ============================================================================

/**
 * Map a ModelIR column type string to a PostgreSQL base type name used in
 * array casts (without the `[]` suffix).
 *
 * Returns `undefined` when the type is not in the whitelist — callers should
 * fall back to runtime inference in that case.
 *
 * @example
 * mapModelIRTypeToPgBase('integer')   // → 'int4'
 * mapModelIRTypeToPgBase('timestamp') // → 'timestamptz'
 * mapModelIRTypeToPgBase('date')      // → 'date'
 */
export function mapModelIRTypeToPgBase(dataType: string): string | undefined {
	const t = dataType.toLowerCase();
	// Integer types
	if (t === 'integer' || t === 'int' || t === 'serial' || t === 'bigserial')
		return 'int4';
	if (t === 'bigint') return 'int8';
	// Float types
	if (
		t === 'decimal' ||
		t === 'float' ||
		t === 'double' ||
		t === 'real' ||
		t === 'numeric'
	)
		return 'float8';
	// Text types
	if (t === 'text' || t === 'string' || t === 'varchar' || t === 'char')
		return 'text';
	// Boolean
	if (t === 'boolean' || t === 'bool') return 'bool';
	// JSON
	if (t === 'json' || t === 'jsonb') return 'jsonb';
	// UUID
	if (t === 'uuid') return 'uuid';
	// Date/time — map to native PG types
	if (t === 'timestamp' || t === 'timestamptz' || t === 'datetime')
		return 'timestamptz';
	if (t === 'date') return 'date';
	// Not in whitelist — caller falls back to runtime inference
	return undefined;
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
