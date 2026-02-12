/**
 * @module csv
 * CSV parsing and format detection for .load / .dump commands.
 *
 * No external dependencies — uses RFC 4180 parsing with smart format sniffing.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// ============================================================================
// Types
// ============================================================================

/** Detected CSV format parameters. */
export interface CsvFormat {
	/** Field separator (comma, semicolon, tab, pipe) */
	readonly separator: string;
	/** Quote character (double-quote, single-quote, or none) */
	readonly quote: string;
	/** Whether the first row contains column names */
	readonly hasHeader: boolean;
	/** Column names (from header row or generated col_0, col_1, ...) */
	readonly columns: readonly string[];
}

/** A parsed CSV file ready for insertion. */
export interface CsvData {
	readonly format: CsvFormat;
	readonly rows: readonly Record<string, string>[];
}

// ============================================================================
// Format Sniffing
// ============================================================================

const CANDIDATE_SEPARATORS = [',', ';', '\t', '|'] as const;
const CANDIDATE_QUOTES = ['"', "'"] as const;

/**
 * Detect CSV format from the first N lines of a file.
 *
 * Strategy:
 * 1. Try each separator candidate — the one that produces the most consistent
 *    field count across sample lines wins.
 * 2. Detect quote character by checking which appears most in field boundaries.
 * 3. Detect header row by checking if first row values look like column names
 *    (no digits-only values, and optionally matches schema column names).
 *
 * @param lines - Sample lines (typically first 5-10 lines of the file)
 * @param schemaColumns - Optional column names from DB schema for header matching
 */
export function sniffCsvFormat(
	lines: readonly string[],
	schemaColumns?: readonly string[],
): CsvFormat {
	if (lines.length === 0) {
		return { separator: ',', quote: '"', hasHeader: false, columns: [] };
	}

	// 1. Detect quote character
	const quote = detectQuoteChar(lines);

	// 2. Detect separator — pick the one with most consistent field count
	const separator = detectSeparator(lines, quote);

	// 3. Parse first row as potential header
	const firstRowFields = parseCsvLine(lines[0]!, separator, quote);

	// 4. Detect header
	const hasHeader = detectHeader(firstRowFields, schemaColumns);

	// 5. Build column names
	const columns = hasHeader
		? firstRowFields.map((f) => f.trim())
		: firstRowFields.map((_, i) => `col_${i}`);

	return { separator, quote, hasHeader, columns };
}

/**
 * Detect the most likely quote character from sample lines.
 */
function detectQuoteChar(lines: readonly string[]): string {
	const joined = lines.join('');
	let bestQuote = '"';
	let bestCount = 0;

	for (const q of CANDIDATE_QUOTES) {
		const count = joined.split(q).length - 1;
		if (count > bestCount) {
			bestCount = count;
			bestQuote = q;
		}
	}

	return bestQuote;
}

/**
 * Detect separator by measuring field-count consistency across lines.
 */
function detectSeparator(
	lines: readonly string[],
	quote: string,
): string {
	let bestSep = ',';
	let bestScore = -1;

	for (const sep of CANDIDATE_SEPARATORS) {
		const counts = lines.map(
			(line) => parseCsvLine(line, sep, quote).length,
		);
		// Score: high if consistent count AND count > 1
		const firstCount = counts[0]!;
		if (firstCount <= 1) continue;

		const consistent = counts.every((c) => c === firstCount);
		const score = consistent ? firstCount * 10 : firstCount;

		if (score > bestScore) {
			bestScore = score;
			bestSep = sep;
		}
	}

	return bestSep;
}

/**
 * Detect whether the first row is a header row.
 *
 * Heuristics:
 * - If schema columns provided and first row matches them → header
 * - If all first-row values are non-numeric, non-empty short strings → header
 * - Otherwise → not a header
 */
function detectHeader(
	firstRowFields: readonly string[],
	schemaColumns?: readonly string[],
): boolean {
	if (firstRowFields.length === 0) return false;

	// If schema columns provided, check for match
	if (schemaColumns && schemaColumns.length > 0) {
		const schemaSet = new Set(
			schemaColumns.map((c) => c.toLowerCase().trim()),
		);
		const matchCount = firstRowFields.filter((f) =>
			schemaSet.has(f.toLowerCase().trim()),
		).length;
		// If > 50% of fields match schema columns → header
		if (matchCount > firstRowFields.length / 2) return true;
	}

	// Heuristic: if all values look like identifiers (not numeric), it's a header
	return firstRowFields.every((field) => {
		const trimmed = field.trim();
		if (trimmed === '') return false;
		// Purely numeric → data, not header
		if (/^\d+(\.\d+)?$/.test(trimmed)) return false;
		// Very long strings (>50 chars) are probably data
		if (trimmed.length > 50) return false;
		return true;
	});
}

// ============================================================================
// CSV Line Parsing (RFC 4180)
// ============================================================================

/**
 * Parse a single CSV line into fields, respecting quoted values.
 */
export function parseCsvLine(
	line: string,
	separator: string,
	quote: string,
): string[] {
	const fields: string[] = [];
	let current = '';
	let inQuotes = false;
	let i = 0;

	while (i < line.length) {
		const char = line[i]!;

		if (inQuotes) {
			if (char === quote) {
				// Check for escaped quote (double quote)
				if (i + 1 < line.length && line[i + 1] === quote) {
					current += quote;
					i += 2;
					continue;
				}
				// End of quoted field
				inQuotes = false;
				i++;
				continue;
			}
			current += char;
			i++;
		} else {
			if (char === quote && current === '') {
				// Start of quoted field
				inQuotes = true;
				i++;
				continue;
			}
			if (char === separator) {
				fields.push(current);
				current = '';
				i++;
				continue;
			}
			current += char;
			i++;
		}
	}

	fields.push(current);
	return fields;
}

// ============================================================================
// File Reading
// ============================================================================

/**
 * Read and parse a CSV file with automatic format detection.
 *
 * Streams the file line-by-line to handle large files.
 *
 * @param filePath - Absolute path to CSV file
 * @param schemaColumns - Optional column names from DB schema for header matching
 * @returns Parsed CSV data with detected format and row records
 */
export async function parseCsvFile(
	filePath: string,
	schemaColumns?: readonly string[],
): Promise<CsvData> {
	// Read first 10 lines for format sniffing
	const sampleLines = await readFirstLines(filePath, 10);

	if (sampleLines.length === 0) {
		return {
			format: { separator: ',', quote: '"', hasHeader: false, columns: [] },
			rows: [],
		};
	}

	const format = sniffCsvFormat(sampleLines, schemaColumns);

	// Parse all lines
	const rows: Record<string, string>[] = [];
	const rl = createInterface({
		input: createReadStream(filePath, 'utf-8'),
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	let lineIndex = 0;
	for await (const line of rl) {
		// Skip header row
		if (lineIndex === 0 && format.hasHeader) {
			lineIndex++;
			continue;
		}

		// Skip empty lines
		if (line.trim() === '') {
			lineIndex++;
			continue;
		}

		const fields = parseCsvLine(line, format.separator, format.quote);
		const row: Record<string, string> = {};
		for (let i = 0; i < format.columns.length; i++) {
			row[format.columns[i]!] = fields[i] ?? '';
		}
		rows.push(row);
		lineIndex++;
	}

	return { format, rows };
}

/**
 * Read the first N lines of a file efficiently.
 */
async function readFirstLines(
	filePath: string,
	count: number,
): Promise<string[]> {
	const lines: string[] = [];
	const rl = createInterface({
		input: createReadStream(filePath, 'utf-8'),
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	for await (const line of rl) {
		if (line.trim() === '') continue;
		lines.push(line);
		if (lines.length >= count) break;
	}

	return lines;
}

// ============================================================================
// CSV Export (for .dump)
// ============================================================================

/**
 * Format rows as CSV string with header.
 *
 * @param rows - Data rows to export
 * @param columns - Column names for header and field ordering
 * @returns CSV string with header row
 */
export function formatCsv(
	rows: readonly Record<string, unknown>[],
	columns: readonly string[],
): string {
	if (columns.length === 0) return '';

	const header = columns.map((c) => escapeCsvField(c)).join(',');
	const dataLines = rows.map((row) =>
		columns.map((col) => escapeCsvField(formatFieldValue(row[col]))).join(','),
	);

	return [header, ...dataLines].join('\n');
}

/**
 * Escape a CSV field value (RFC 4180).
 */
function escapeCsvField(value: string): string {
	if (value.includes(',') || value.includes('\n') || value.includes('"')) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

/**
 * Convert a value to its CSV string representation.
 */
function formatFieldValue(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}
