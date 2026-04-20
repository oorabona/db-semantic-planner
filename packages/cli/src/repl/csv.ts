/**
 * @module csv
 * CSV parsing and format detection for .load / .dump commands.
 *
 * No external dependencies — uses RFC 4180 parsing with smart format sniffing.
 */

import { readFile } from 'node:fs/promises';

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
// Error
// ============================================================================

/**
 * Thrown when the CSV content is structurally invalid (RFC 4180 violation,
 * field-count mismatch, unterminated quote, etc.).
 */
export class CsvParseError extends Error {
	/** 1-based physical line number where the error was detected. */
	readonly line: number;

	constructor(line: number, message: string) {
		super(`CSV parse error at line ${line}: ${message}`);
		this.name = 'CsvParseError';
		this.line = line;
		Object.setPrototypeOf(this, CsvParseError.prototype);
	}
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
function detectSeparator(lines: readonly string[], quote: string): string {
	let bestSep = ',';
	let bestScore = -1;

	for (const sep of CANDIDATE_SEPARATORS) {
		const counts = lines.map((line) => parseCsvLine(line, sep, quote).length);
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
		const schemaSet = new Set(schemaColumns.map((c) => c.toLowerCase().trim()));
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
	physicalLine?: number,
): string[] {
	const fields: string[] = [];
	let current = '';
	let inQuotes = false;
	let i = 0;

	while (i < line.length) {
		const char = line[i]!;

		if (inQuotes) {
			if (char === quote) {
				// Check for escaped quote (RFC 4180 doubled-quote escape)
				if (i + 1 < line.length && line[i + 1] === quote) {
					current += quote;
					i += 2;
					continue;
				}
				// Closing quote — next char must be separator or end-of-string.
				// (RFC 4180 §2.6: chars after closing quote before separator = error)
				// Only validate in strict mode (physicalLine provided).
				if (
					physicalLine !== undefined &&
					i + 1 < line.length &&
					line[i + 1] !== separator
				) {
					throw new CsvParseError(
						physicalLine,
						`unexpected character '${line[i + 1]}' after closing quote`,
					);
				}
				inQuotes = false;
				i++;
				continue;
			}
			current += char;
			i++;
		} else {
			if (char === quote && current === '') {
				// Start of quoted field (RFC 4180 §2.5: quotes must start the field)
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

	// EOF-in-quote: only throw in strict mode (physicalLine provided).
	// In lenient mode (sniffing), return partial fields.
	if (inQuotes && physicalLine !== undefined) {
		throw new CsvParseError(
			physicalLine,
			'unterminated quoted field (EOF in quote)',
		);
	}

	fields.push(current);
	return fields;
}

// ============================================================================
// Stateful RFC 4180 tokeniser internals
// ============================================================================

/**
 * A logical CSV row: one or more physical lines joined by quoted newlines.
 * @internal
 */
interface LogicalRow {
	/** Concatenated text of all physical lines (including embedded newlines). */
	rawText: string;
	/** The first physical line's text — used for format sniffing. */
	rawFirstLine: string;
	/** 1-based physical line number where this logical row starts. */
	startPhysicalLine: number;
}

/**
 * Tokenise a complete CSV file string into logical rows.
 *
 * A logical row spans one or more physical lines: when a field is opened with
 * a quote character, embedded newlines (LF or CRLF) are part of the field
 * until the matching closing quote is found. This is the fix for RFC 4180
 * multiline quoted fields being silently truncated by the previous readline
 * approach.
 *
 * Returns an array of LogicalRow objects. Throws CsvParseError if the file
 * ends while inside a quoted field (unterminated quote).
 */
function tokeniseCsvContent(content: string, quoteChar: string): LogicalRow[] {
	const rows: LogicalRow[] = [];
	const q = quoteChar;
	let inQuote = false;
	let rowStart = 0;
	let physicalLine = 1;
	let rowStartPhysicalLine = 1;
	/**
	 * Exclusive end index of the first physical line within the current logical
	 * row — used to populate rawFirstLine for format sniffing.
	 * -1 means we haven't crossed a newline yet in this row.
	 */
	let firstLineOfRowEnd = -1;

	for (let i = 0; i < content.length; i++) {
		const ch = content[i]!;

		if (ch === q) {
			if (!inQuote) {
				inQuote = true;
			} else {
				// Check for doubled quote (RFC 4180 escape)
				if (i + 1 < content.length && content[i + 1] === q) {
					i++; // skip the doubled quote
				} else {
					inQuote = false;
				}
			}
		} else if (ch === '\n') {
			// Record end of first physical line (regardless of quote state)
			if (firstLineOfRowEnd === -1) {
				firstLineOfRowEnd = i > 0 && content[i - 1] === '\r' ? i - 1 : i;
			}
			physicalLine++;

			if (!inQuote) {
				// End of logical row
				const rawEnd = i > 0 && content[i - 1] === '\r' ? i - 1 : i;
				const rawText = content.slice(rowStart, rawEnd);
				const rawFirstLine =
					firstLineOfRowEnd === rawEnd
						? rawText // single-line row: rawFirstLine == rawText
						: content.slice(rowStart, firstLineOfRowEnd);
				rows.push({
					rawText,
					rawFirstLine,
					startPhysicalLine: rowStartPhysicalLine,
				});
				rowStart = i + 1;
				rowStartPhysicalLine = physicalLine;
				firstLineOfRowEnd = -1;
			}
			// inQuote: embedded newline — stay in same logical row, continue accumulating
		} else if (ch === '\r') {
			// CR not followed by LF = CR-only line ending
			if (i + 1 >= content.length || content[i + 1] !== '\n') {
				if (firstLineOfRowEnd === -1) {
					firstLineOfRowEnd = i;
				}
				physicalLine++;

				if (!inQuote) {
					const rawText = content.slice(rowStart, i);
					const rawFirstLine =
						firstLineOfRowEnd === i
							? rawText
							: content.slice(rowStart, firstLineOfRowEnd);
					rows.push({
						rawText,
						rawFirstLine,
						startPhysicalLine: rowStartPhysicalLine,
					});
					rowStart = i + 1;
					rowStartPhysicalLine = physicalLine;
					firstLineOfRowEnd = -1;
				}
			}
			// CR+LF: CR is skipped here; the \n at i+1 will handle row emission
		}
	}

	// Handle final row (file with no trailing newline)
	if (rowStart < content.length) {
		if (inQuote) {
			throw new CsvParseError(
				rowStartPhysicalLine,
				'unterminated quoted field at end of file',
			);
		}
		const rawText = content.slice(rowStart).replace(/\r$/, '');
		if (rawText.length > 0) {
			const rawFirstLine =
				firstLineOfRowEnd === -1
					? rawText
					: content.slice(rowStart, firstLineOfRowEnd);
			rows.push({
				rawText,
				rawFirstLine,
				startPhysicalLine: rowStartPhysicalLine,
			});
		}
	} else if (inQuote) {
		// File ended exactly at a newline while in quote
		throw new CsvParseError(
			rowStartPhysicalLine,
			'unterminated quoted field at end of file',
		);
	}

	return rows;
}

/**
 * Parse a logical row's rawText into field values.
 *
 * The rawText may contain embedded newlines inside quoted fields (RFC 4180 §2.6).
 * Uses a character-level state machine — does NOT use parseCsvLine (which is
 * single-line only and throws on unterminated quotes).
 */
function parseLogicalRow(
	row: LogicalRow,
	separator: string,
	quote: string,
): string[] {
	const text = row.rawText;
	const fields: string[] = [];
	let current = '';
	let inQuotes = false;
	let i = 0;

	while (i < text.length) {
		const ch = text[i]!;

		if (inQuotes) {
			if (ch === quote) {
				if (i + 1 < text.length && text[i + 1] === quote) {
					// Doubled quote — literal quote character
					current += quote;
					i += 2;
					continue;
				}
				// Closing quote — validate next char
				const next = text[i + 1];
				if (
					next !== undefined &&
					next !== separator &&
					next !== '\r' &&
					next !== '\n'
				) {
					throw new CsvParseError(
						row.startPhysicalLine,
						`unexpected character '${next}' after closing quote`,
					);
				}
				inQuotes = false;
				i++;
				continue;
			}
			// Embedded newline or any other char inside quotes
			current += ch;
			i++;
		} else {
			if (ch === quote && current === '') {
				inQuotes = true;
				i++;
				continue;
			}
			if (ch === separator) {
				fields.push(current);
				current = '';
				i++;
				continue;
			}
			current += ch;
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
 * Single-pass stateful RFC 4180 parser: reads the file once, tokenises into
 * logical rows (spanning physical lines for quoted multiline fields), sniffs
 * format from the first 10 rows, then parses all rows into field maps.
 *
 * Throws CsvParseError on structural violations (unterminated quotes, field
 * count mismatch, extra chars after closing quote).
 *
 * @param filePath - Absolute path to CSV file
 * @param schemaColumns - Optional column names from DB schema for header matching
 * @returns Parsed CSV data with detected format and row records
 */
export async function parseCsvFile(
	filePath: string,
	schemaColumns?: readonly string[],
): Promise<CsvData> {
	// Single read — no double-open (fixes TOCTOU / double-read issue)
	const raw = await readFile(filePath, 'utf-8');

	if (raw.length === 0) {
		return {
			format: { separator: ',', quote: '"', hasHeader: false, columns: [] },
			rows: [],
		};
	}

	// -------------------------------------------------------------------------
	// Phase 1 — Quick physical-line sniff (ignores quote state intentionally)
	//
	// We split on \n to get a sample of physical lines for format detection.
	// This is sufficient for detecting separator, quote char, and header — the
	// sniff heuristics work on field counts and char frequency which don't
	// require quote-aware row spanning.
	// -------------------------------------------------------------------------
	const SNIFF_LINE_COUNT = 10;
	const physicalLines = raw.split('\n');
	const sampleLines = physicalLines
		.slice(0, SNIFF_LINE_COUNT * 3) // over-sample to find SNIFF_LINE_COUNT non-blank
		.map((l) => l.replace(/\r$/, ''))
		.filter((l) => l.trim() !== '')
		.slice(0, SNIFF_LINE_COUNT);

	if (sampleLines.length === 0) {
		return {
			format: { separator: ',', quote: '"', hasHeader: false, columns: [] },
			rows: [],
		};
	}

	const format = sniffCsvFormat(sampleLines, schemaColumns);

	// -------------------------------------------------------------------------
	// Phase 2 — Stateful RFC 4180 character-level tokeniser
	//
	// Now that we know the quote character, tokenise the full content into
	// logical rows, correctly handling embedded newlines in quoted fields.
	// -------------------------------------------------------------------------
	const logicalRows = tokeniseCsvContent(raw, format.quote);

	if (logicalRows.length === 0) {
		return { format, rows: [] };
	}

	// -------------------------------------------------------------------------
	// Phase 3 — Parse logical rows into field arrays
	// -------------------------------------------------------------------------
	const rows: Record<string, string>[] = [];
	let rowIndex = 0;

	for (const logicalRow of logicalRows) {
		// Skip blank logical rows
		if (logicalRow.rawText.trim() === '') {
			continue;
		}

		// Skip header row (rowIndex counts only non-blank rows)
		if (rowIndex === 0 && format.hasHeader) {
			rowIndex++;
			continue;
		}

		const fields = parseLogicalRow(logicalRow, format.separator, format.quote);

		// Field count validation (M-class fix)
		if (fields.length !== format.columns.length) {
			throw new CsvParseError(
				logicalRow.startPhysicalLine,
				`expected ${format.columns.length} fields, got ${fields.length}`,
			);
		}

		const row: Record<string, string> = {};
		for (let i = 0; i < format.columns.length; i++) {
			row[format.columns[i]!] = fields[i] ?? '';
		}
		rows.push(row);
		rowIndex++;
	}

	return { format, rows };
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
	if (
		value.includes(',') ||
		value.includes('\n') ||
		value.includes('\r') ||
		value.includes('"')
	) {
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
