/**
 * NQL v2.1: Output formatters for REPL results
 *
 * Formats query results according to the selected output mode:
 * - json: Nested JSON structure (default, preserves relations)
 * - table: Flattened tabular format (nested objects become columns)
 * - csv: CSV export format (same flattening as table)
 */

export type OutputMode = 'json' | 'table' | 'csv';

/**
 * Format rows according to the specified output mode
 */
export function formatOutput(
	rows: Record<string, unknown>[],
	columns: string[],
	mode: OutputMode,
): string {
	switch (mode) {
		case 'json':
			return formatAsJson(rows);
		case 'table':
			return formatAsTable(rows, columns);
		case 'csv':
			return formatAsCsv(rows, columns);
	}
}

/**
 * Format as nested JSON (default mode)
 */
function formatAsJson(rows: Record<string, unknown>[]): string {
	if (rows.length === 0) {
		return '[]';
	}
	return JSON.stringify(rows, null, 2);
}

/**
 * Format as ASCII table (flattens nested objects)
 */
function formatAsTable(
	rows: Record<string, unknown>[],
	columns: string[],
): string {
	if (rows.length === 0) {
		return '(empty result set)';
	}

	// Flatten nested objects and get all columns
	const flattenedRows = rows.map((row) => flattenObject(row));
	const allColumns = getAllColumns(flattenedRows, columns);

	// Calculate column widths
	const widths = allColumns.map((col) => {
		const maxDataWidth = Math.max(
			...flattenedRows.map((row) => formatValue(row[col]).length),
		);
		return Math.max(col.length, maxDataWidth);
	});

	// Header row
	const header = allColumns
		.map((col, i) => col.padEnd(widths[i] ?? 0))
		.join(' | ');
	const separator = widths.map((w) => '-'.repeat(w)).join('-+-');

	// Data rows
	const dataRows = flattenedRows.map((row) =>
		allColumns
			.map((col, i) => formatValue(row[col]).padEnd(widths[i] ?? 0))
			.join(' | '),
	);

	return [header, separator, ...dataRows].join('\n');
}

/**
 * Format as CSV (flattens nested objects)
 */
function formatAsCsv(
	rows: Record<string, unknown>[],
	columns: string[],
): string {
	if (rows.length === 0) {
		return '';
	}

	// Flatten nested objects and get all columns
	const flattenedRows = rows.map((row) => flattenObject(row));
	const allColumns = getAllColumns(flattenedRows, columns);

	// Header row
	const header = allColumns.map((col) => escapeCsvValue(col)).join(',');

	// Data rows
	const dataRows = flattenedRows.map((row) =>
		allColumns.map((col) => escapeCsvValue(formatValue(row[col]))).join(','),
	);

	return [header, ...dataRows].join('\n');
}

/**
 * Flatten a nested object into a single-level object
 * Uses underscore convention: { a: { b: 1 } } → { "a_b": 1 }
 */
function flattenObject(
	obj: Record<string, unknown>,
	prefix = '',
): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(obj)) {
		const newKey = prefix ? `${prefix}_${key}` : key;

		if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
			// Recursively flatten nested objects
			Object.assign(
				result,
				flattenObject(value as Record<string, unknown>, newKey),
			);
		} else if (Array.isArray(value)) {
			// For arrays, JSON stringify them
			result[newKey] = JSON.stringify(value);
		} else {
			result[newKey] = value;
		}
	}

	return result;
}

/**
 * Get all unique column names from flattened rows
 * Preserves original column order when possible
 */
function getAllColumns(
	flattenedRows: Record<string, unknown>[],
	baseColumns: string[],
): string[] {
	const allKeys = new Set<string>();

	// First add base columns that exist in flattened data
	for (const col of baseColumns) {
		if (flattenedRows.some((row) => col in row)) {
			allKeys.add(col);
		}
	}

	// Then add any new columns from flattening
	for (const row of flattenedRows) {
		for (const key of Object.keys(row)) {
			allKeys.add(key);
		}
	}

	return Array.from(allKeys);
}

/**
 * Format a value for display
 */
function formatValue(value: unknown): string {
	if (value === null || value === undefined) {
		return 'null';
	}
	if (typeof value === 'string') {
		return value;
	}
	return String(value);
}

/**
 * Escape a value for CSV output
 */
function escapeCsvValue(value: string): string {
	// If value contains comma, newline, or quote, wrap in quotes
	if (value.includes(',') || value.includes('\n') || value.includes('"')) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}
