/**
 * @module assertion-functions
 * Individual assertion evaluators for the REPL assertion system.
 *
 * Each function takes inputs and returns an AssertionOutcome.
 * Grouped by domain: general, SQL, params, DB, intent.
 *
 * Extracted from assertion-runner.ts for SRP (Phase 5.6).
 */

import type { AssertionType, TableAssertionData } from './assertion-parser.js';
import type { BatchResult } from './batch.js';
import type { AssertionOutcome } from './assertion-runner.js';

// ============================================================
// Helpers
// ============================================================

/**
 * Normalize SQL for comparison by collapsing whitespace
 * This handles formatting differences between generated and expected SQL
 */
export function normalizeSQL(sql: string): string {
	return sql
		.replace(/\s+/g, ' ') // Collapse multiple whitespace to single space
		.replace(/\s*,\s*/g, ', ') // Normalize comma spacing
		.replace(/\s*\(\s*/g, '(') // Remove spaces around opening parens
		.replace(/\s*\)\s*/g, ')') // Remove spaces around closing parens
		.trim()
		.toLowerCase();
}

/**
 * Convert camelCase to snake_case
 */
function toSnakeCase(str: string): string {
	return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// ============================================================
// GENERAL ASSERTIONS
// ============================================================

/**
 * Assert that a string contains a substring
 */
export function assertContains(
	field: string,
	actual: string,
	expected: string,
	originalType?: AssertionType,
): AssertionOutcome {
	const passed = actual.includes(expected);
	return {
		type: originalType ?? (`${field}.contains` as AssertionType),
		expected,
		actual: passed ? undefined : actual, // Full value, no truncation
		passed,
		message: passed ? undefined : `Expected ${field} to contain "${expected}"`,
	};
}

/**
 * Assert exact string equality
 */
export function assertEquals(
	field: string,
	actual: string,
	expected: string,
): AssertionOutcome {
	const passed = actual.trim() === expected.trim();
	return {
		type: `${field}.equals` as AssertionType,
		expected,
		actual: passed ? undefined : actual, // Full value, no truncation
		passed,
		message: passed ? undefined : `Expected ${field} to equal "${expected}"`,
	};
}

/**
 * Assert string matches regex
 */
export function assertMatches(
	field: string,
	actual: string,
	pattern: string,
): AssertionOutcome {
	const regex = new RegExp(pattern);
	const passed = regex.test(actual);
	return {
		type: `${field}.matches` as AssertionType,
		expected: pattern,
		actual: passed ? undefined : actual, // Full value, no truncation
		passed,
		message: passed ? undefined : `Expected ${field} to match /${pattern}/`,
	};
}

/**
 * Assert query success/failure
 */
export function assertSuccess(actual: boolean, expected: boolean): AssertionOutcome {
	const passed = actual === expected;
	return {
		type: 'success',
		expected,
		actual: passed ? undefined : actual,
		passed,
		message: passed
			? undefined
			: `Expected query to ${expected ? 'succeed' : 'fail'}, but it ${actual ? 'succeeded' : 'failed'}`,
	};
}

// ============================================================
// SQL ASSERTIONS
// ============================================================

/**
 * Assert SQL equality with normalization
 */
export function assertSQLEquals(actual: string, expected: string): AssertionOutcome {
	const normalizedActual = normalizeSQL(actual);
	const normalizedExpected = normalizeSQL(expected);
	const passed = normalizedActual === normalizedExpected;

	return {
		type: 'sql.equals',
		expected,
		actual: passed ? undefined : actual,
		passed,
		message: passed
			? undefined
			: `SQL mismatch:\n  Expected: ${expected}\n  Actual:   ${actual}`,
	};
}

/**
 * Assert SQL contains table name (handles logical/physical naming)
 * Matches: "productImages" → product_images, productimages, "productImages"
 */
export function assertSQLTable(sql: string, tableName: string): AssertionOutcome {
	const normalizedSql = sql.toLowerCase();
	const logicalLower = tableName.toLowerCase();
	const physicalSnake = toSnakeCase(tableName).toLowerCase();

	// Check various forms: logical, physical snake_case, or quoted
	const found =
		normalizedSql.includes(logicalLower) ||
		normalizedSql.includes(physicalSnake) ||
		normalizedSql.includes(`"${logicalLower}"`) ||
		normalizedSql.includes(`"${physicalSnake}"`);

	return {
		type: 'sql.table',
		expected: tableName,
		actual: found ? undefined : sql, // Full value, no truncation
		passed: found,
		message: found
			? undefined
			: `Expected SQL to reference table "${tableName}" (or "${physicalSnake}")`,
	};
}

/**
 * Assert SQL contains column name
 */
export function assertSQLColumn(sql: string, columnName: string): AssertionOutcome {
	const normalizedSql = sql.toLowerCase();
	const columnLower = columnName.toLowerCase();
	const columnSnake = toSnakeCase(columnName).toLowerCase();

	const found =
		normalizedSql.includes(columnLower) ||
		normalizedSql.includes(columnSnake) ||
		normalizedSql.includes(`"${columnLower}"`) ||
		normalizedSql.includes(`"${columnSnake}"`);

	return {
		type: 'sql.column',
		expected: columnName,
		actual: found ? undefined : sql, // Full value, no truncation
		passed: found,
		message: found
			? undefined
			: `Expected SQL to reference column "${columnName}"`,
	};
}

/**
 * Assert SQL references a table via JOIN or CTE
 * Detects: LEFT/RIGHT/INNER/FULL/CROSS JOIN, WITH clause (CTE)
 * Handles schema-qualified names: "schema"."table" and plain "table"
 */
export function assertSQLJoin(sql: string, tableName: string): AssertionOutcome {
	const normalizedSql = sql.toLowerCase();
	const tableNameLower = tableName.toLowerCase();
	const tableSnake = toSnakeCase(tableName).toLowerCase();

	// Check for any type of JOIN (left, right, inner, full, cross)
	const joinPattern = /\b(left|right|inner|full|cross)?\s*join\b/;
	const hasJoin = joinPattern.test(normalizedSql);

	// Check for CTE (WITH clause)
	const ctePattern = new RegExp(
		`\\bwith\\b[^)]*\\b(${tableNameLower}|${tableSnake})\\b`,
	);
	const hasCte = ctePattern.test(normalizedSql);

	// Check for table name (handles schema-qualified: "schema"."table")
	// Match: "table", "schema"."table", table (unquoted)
	const tablePatterns = [
		`"${tableNameLower}"`, // quoted logical
		`"${tableSnake}"`, // quoted physical
		`.${tableNameLower}`, // after schema dot
		`.${tableSnake}`, // after schema dot (snake)
		` ${tableNameLower} `, // unquoted with spaces
		` ${tableSnake} `, // unquoted snake
	];
	const hasTable = tablePatterns.some((p) => normalizedSql.includes(p));

	// Pass if: (has JOIN AND has table) OR (has CTE with table)
	const found = (hasJoin && hasTable) || hasCte;

	return {
		type: 'sql.join',
		expected: tableName,
		actual: found ? undefined : sql,
		passed: found,
		message: found
			? undefined
			: `Expected SQL to reference "${tableName}" via JOIN or CTE`,
	};
}

// ============================================================
// PARAMS ASSERTIONS
// ============================================================

/**
 * Assert params array equality
 */
export function assertParamsEquals(
	actual: readonly unknown[],
	expected: unknown[],
): AssertionOutcome {
	const actualStr = JSON.stringify(actual);
	const expectedStr = JSON.stringify(expected);
	const passed = actualStr === expectedStr;

	return {
		type: 'params.equals',
		expected,
		actual: passed ? undefined : [...actual],
		passed,
		message: passed
			? undefined
			: `Params mismatch:\n  Expected: ${expectedStr}\n  Actual:   ${actualStr}`,
	};
}

/**
 * Assert params array length
 */
export function assertParamsLength(
	actual: readonly unknown[],
	expected: number,
): AssertionOutcome {
	const passed = actual.length === expected;
	return {
		type: 'params.length',
		expected,
		actual: passed ? undefined : actual.length,
		passed,
		message: passed
			? undefined
			: `Expected ${expected} params, got ${actual.length}`,
	};
}

/**
 * Assert parameter types (string, number, boolean, null, object)
 */
export function assertParamsType(
	params: readonly unknown[],
	expectedTypes: string[],
): AssertionOutcome {
	if (params.length !== expectedTypes.length) {
		return {
			type: 'params.type',
			expected: expectedTypes,
			actual: params.map((p) => typeof p),
			passed: false,
			message: `Expected ${expectedTypes.length} params, got ${params.length}`,
		};
	}

	const actualTypes: string[] = [];
	const mismatches: string[] = [];

	for (let i = 0; i < params.length; i++) {
		const param = params[i];
		const expectedType = expectedTypes[i];
		let actualType: string;

		if (param === null) {
			actualType = 'null';
		} else if (Array.isArray(param)) {
			actualType = 'array';
		} else if (typeof param === 'object') {
			actualType = 'object';
		} else {
			actualType = typeof param;
		}

		actualTypes.push(actualType);

		if (actualType !== expectedType) {
			mismatches.push(
				`Index ${i}: expected ${expectedType}, got ${actualType}`,
			);
		}
	}

	const passed = mismatches.length === 0;

	return {
		type: 'params.type',
		expected: expectedTypes,
		actual: passed ? undefined : actualTypes,
		passed,
		message: passed ? undefined : `Type mismatch: ${mismatches.join('; ')}`,
	};
}

/**
 * Assert specific parameter value by index
 * Value format: { index: number, value: unknown }
 */
export function assertParamsValue(
	params: readonly unknown[],
	spec: unknown,
): AssertionOutcome {
	const { index, value } =
		typeof spec === 'object' && spec !== null
			? (spec as { index: number; value: unknown })
			: { index: 0, value: spec };

	if (index >= params.length) {
		return {
			type: 'params.value',
			expected: value,
			actual: undefined,
			passed: false,
			message: `No param at index ${index} (only ${params.length} params)`,
		};
	}

	const actual = params[index];
	const passed = JSON.stringify(actual) === JSON.stringify(value);

	return {
		type: 'params.value',
		expected: value,
		actual: passed ? undefined : actual,
		passed,
		message: passed
			? undefined
			: `Param at index ${index}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual)}`,
	};
}

// ============================================================
// DB ASSERTIONS (require database connection)
// ============================================================

/**
 * Assert exact row count from query result
 */
export function assertDbRowsEquals(
	result: BatchResult,
	expected: number,
): AssertionOutcome {
	const rowCount = result.rowCount ?? 0;
	const passed = rowCount === expected;

	return {
		type: 'db.rows.equals',
		expected,
		actual: passed ? undefined : rowCount,
		passed,
		message: passed ? undefined : `Expected ${expected} rows, got ${rowCount}`,
	};
}

/**
 * Assert minimum row count
 */
export function assertDbRowsMin(
	result: BatchResult,
	expected: number,
): AssertionOutcome {
	const rowCount = result.rowCount ?? 0;
	const passed = rowCount >= expected;

	return {
		type: 'db.rows.min',
		expected,
		actual: passed ? undefined : rowCount,
		passed,
		message: passed
			? undefined
			: `Expected at least ${expected} rows, got ${rowCount}`,
	};
}

/**
 * Assert maximum row count
 */
export function assertDbRowsMax(
	result: BatchResult,
	expected: number,
): AssertionOutcome {
	const rowCount = result.rowCount ?? 0;
	const passed = rowCount <= expected;

	return {
		type: 'db.rows.max',
		expected,
		actual: passed ? undefined : rowCount,
		passed,
		message: passed
			? undefined
			: `Expected at most ${expected} rows, got ${rowCount}`,
	};
}

/**
 * Assert column exists in result
 */
export function assertDbColumnExists(
	result: BatchResult,
	columnName: string,
): AssertionOutcome {
	const columns = result.columns ?? [];
	const columnLower = columnName.toLowerCase();
	const columnSnake = toSnakeCase(columnName).toLowerCase();

	const found = columns.some((col) => {
		const colLower = col.toLowerCase();
		return colLower === columnLower || colLower === columnSnake;
	});

	return {
		type: 'db.column.exists',
		expected: columnName,
		actual: found ? undefined : columns,
		passed: found,
		message: found
			? undefined
			: `Column "${columnName}" not found in result. Available: ${columns.join(', ')}`,
	};
}

/**
 * Assert specific cell value in result
 * Value format: { row: number, column: string, value: unknown }
 */
export function assertDbValueEquals(
	result: BatchResult,
	spec: unknown,
): AssertionOutcome {
	const { row, column, value } =
		typeof spec === 'object' && spec !== null
			? (spec as { row: number; column: string; value: unknown })
			: { row: 0, column: '', value: spec };

	const rows = result.rows ?? [];
	if (row >= rows.length) {
		return {
			type: 'db.value.equals',
			expected: value,
			actual: undefined,
			passed: false,
			message: `No row at index ${row} (only ${rows.length} rows)`,
		};
	}

	const rowData = rows[row] as Record<string, unknown> | undefined;
	if (!rowData) {
		return {
			type: 'db.value.equals',
			expected: value,
			actual: undefined,
			passed: false,
			message: `Row ${row} is empty`,
		};
	}

	// Try both exact column name and snake_case
	const actual = rowData[column] ?? rowData[toSnakeCase(column)];
	const passed = JSON.stringify(actual) === JSON.stringify(value);

	return {
		type: 'db.value.equals',
		expected: value,
		actual: passed ? undefined : actual,
		passed,
		message: passed
			? undefined
			: `Value at [${row}]["${column}"]: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual)}`,
	};
}

/**
 * Assert db.output table: compare parsed markdown table against actual DB rows.
 * - Row count must match exactly
 * - Only listed columns are checked (extra actual columns ignored)
 * - Values compared as trimmed strings
 * - "NULL" (case-sensitive) matches null/undefined actual values
 */
export function assertDbOutput(
	result: BatchResult,
	tableData: TableAssertionData,
): AssertionOutcome {
	const { columns, rows: expectedRows } = tableData;
	const actualRows = (result.rows ?? []) as Record<string, unknown>[];

	// Normalize a value for string comparison (Date → ISO, etc.)
	const normalize = (val: unknown): string => {
		if (val === null || val === undefined) return 'NULL';
		if (val instanceof Date) return val.toISOString();
		if (typeof val === 'object') return JSON.stringify(val);
		return String(val);
	};

	// Helper: format actual rows as markdown table for error messages
	const formatActualTable = (): string => {
		if (actualRows.length === 0) return '(no rows)';
		const actualCols =
			columns.length > 0
				? columns
				: Object.keys(actualRows[0] as Record<string, unknown>);
		const header = `| ${actualCols.join(' | ')} |`;
		const separator = `| ${actualCols.map(() => '---').join(' | ')} |`;
		const rows = actualRows.map((row) => {
			const cells = actualCols.map((col) => normalize(row[col]));
			return `| ${cells.join(' | ')} |`;
		});
		return [header, separator, ...rows].join('\n');
	};

	// Row count check
	if (actualRows.length !== expectedRows.length) {
		return {
			type: 'db.output',
			expected: `${expectedRows.length} rows`,
			actual: `${actualRows.length} rows`,
			passed: false,
			message: `Expected ${expectedRows.length} rows, got ${actualRows.length}\nActual data:\n${formatActualTable()}`,
		};
	}

	// Check expected columns exist in actual result (if any rows)
	if (actualRows.length > 0) {
		const firstRow = actualRows[0] as Record<string, unknown>;
		for (const col of columns) {
			if (!(col in firstRow)) {
				return {
					type: 'db.output',
					expected: `column "${col}" in results`,
					actual: `columns: ${Object.keys(firstRow).join(', ')}`,
					passed: false,
					message: `Expected column "${col}" not found in results. Available: ${Object.keys(firstRow).join(', ')}\nActual data:\n${formatActualTable()}`,
				};
			}
		}
	}

	// Row-by-row, column-by-column comparison
	for (let r = 0; r < expectedRows.length; r++) {
		const expectedRow = expectedRows[r]!;
		const actualRow = actualRows[r]!;

		for (let c = 0; c < columns.length; c++) {
			const col = columns[c]!;
			const expectedVal = expectedRow[c] ?? '';
			const actualVal = actualRow[col];
			const normalizedActual = normalize(actualVal);

			// NULL handling: "NULL" (case-sensitive) matches null/undefined
			const expectedIsNull = expectedVal === 'NULL';
			const actualIsNull = actualVal === null || actualVal === undefined;

			if (expectedIsNull && actualIsNull) continue;
			if (expectedIsNull !== actualIsNull) {
				return {
					type: 'db.output',
					expected: expectedVal,
					actual: normalizedActual,
					passed: false,
					message: `Row ${r + 1}, column "${col}": expected ${expectedVal}, got ${normalizedActual}\nActual data:\n${formatActualTable()}`,
				};
			}

			// String comparison (trimmed, with Date→ISO normalization)
			if (normalizedActual.trim() !== expectedVal.trim()) {
				return {
					type: 'db.output',
					expected: expectedVal,
					actual: normalizedActual,
					passed: false,
					message: `Row ${r + 1}, column "${col}": expected "${expectedVal}", got "${normalizedActual}"\nActual data:\n${formatActualTable()}`,
				};
			}
		}
	}

	return {
		type: 'db.output',
		expected: `${expectedRows.length} rows matching`,
		actual: `${expectedRows.length} rows matching`,
		passed: true,
		message: undefined,
	};
}

// ============================================================
// INTENT AST ASSERTIONS (semantic verification)
// ============================================================

/**
 * Assert intent type (query, insert, update, delete, upsert)
 */
export function assertIntentType(
	result: BatchResult,
	expected: string,
): AssertionOutcome {
	const actual = result.intent?.type;

	if (!result.intent) {
		return {
			type: 'intent.type',
			expected,
			actual: undefined,
			passed: false,
			message: 'No intent available (command or parse error)',
		};
	}

	const passed = actual === expected;

	return {
		type: 'intent.type',
		expected,
		actual: passed ? undefined : actual,
		passed,
		message: passed
			? undefined
			: `Expected intent type "${expected}", got "${actual}"`,
	};
}

/**
 * Assert main table name (logical name)
 */
export function assertIntentTable(
	result: BatchResult,
	expected: string,
): AssertionOutcome {
	const actual = result.intent?.table;

	if (!result.intent) {
		return {
			type: 'intent.table',
			expected,
			actual: undefined,
			passed: false,
			message: 'No intent available (command or parse error)',
		};
	}

	// Compare case-insensitively for flexibility
	const passed = actual?.toLowerCase() === expected.toLowerCase();

	return {
		type: 'intent.table',
		expected,
		actual: passed ? undefined : actual,
		passed,
		message: passed
			? undefined
			: `Expected table "${expected}", got "${actual}"`,
	};
}

/**
 * Assert relations joined via `with` keyword
 * Value can be a single string or array of strings
 */
export function assertIntentWith(
	result: BatchResult,
	expected: string | string[],
): AssertionOutcome {
	const actual = result.intent?.with ?? [];
	const expectedArray = Array.isArray(expected) ? expected : [expected];

	if (!result.intent) {
		return {
			type: 'intent.with',
			expected: expectedArray,
			actual: undefined,
			passed: false,
			message: 'No intent available (command or parse error)',
		};
	}

	// Check if all expected relations are present (case-insensitive)
	const actualLower = actual.map((r: string) => r.toLowerCase());
	const missing = expectedArray.filter(
		(e) => !actualLower.includes(e.toLowerCase()),
	);

	const passed = missing.length === 0;

	return {
		type: 'intent.with',
		expected: expectedArray,
		actual: passed ? undefined : actual,
		passed,
		message: passed
			? undefined
			: `Missing relations: ${missing.join(', ')}. Found: ${actual.join(', ')}`,
	};
}

/**
 * Assert whether intent has WHERE clause
 */
export function assertIntentHasWhere(
	result: BatchResult,
	expected: boolean,
): AssertionOutcome {
	const actual = result.intent?.hasWhere ?? false;

	if (!result.intent) {
		return {
			type: 'intent.hasWhere',
			expected,
			actual: undefined,
			passed: false,
			message: 'No intent available (command or parse error)',
		};
	}

	const passed = actual === expected;

	return {
		type: 'intent.hasWhere',
		expected,
		actual: passed ? undefined : actual,
		passed,
		message: passed
			? undefined
			: `Expected hasWhere=${expected}, got ${actual}`,
	};
}

/**
 * Assert whether intent has GROUP BY clause
 */
export function assertIntentHasGroupBy(
	result: BatchResult,
	expected: boolean,
): AssertionOutcome {
	const actual = result.intent?.hasGroupBy ?? false;

	if (!result.intent) {
		return {
			type: 'intent.hasGroupBy',
			expected,
			actual: undefined,
			passed: false,
			message: 'No intent available (command or parse error)',
		};
	}

	const passed = actual === expected;

	return {
		type: 'intent.hasGroupBy',
		expected,
		actual: passed ? undefined : actual,
		passed,
		message: passed
			? undefined
			: `Expected hasGroupBy=${expected}, got ${actual}`,
	};
}

/**
 * Assert whether intent has ORDER BY clause
 */
export function assertIntentHasOrderBy(
	result: BatchResult,
	expected: boolean,
): AssertionOutcome {
	const actual = result.intent?.hasOrderBy ?? false;

	if (!result.intent) {
		return {
			type: 'intent.hasOrderBy',
			expected,
			actual: undefined,
			passed: false,
			message: 'No intent available (command or parse error)',
		};
	}

	const passed = actual === expected;

	return {
		type: 'intent.hasOrderBy',
		expected,
		actual: passed ? undefined : actual,
		passed,
		message: passed
			? undefined
			: `Expected hasOrderBy=${expected}, got ${actual}`,
	};
}
