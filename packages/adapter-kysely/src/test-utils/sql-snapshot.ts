/**
 * SQL Snapshot Testing Utilities
 *
 * Provides tools for snapshot-based regression testing of SQL generation.
 * Snapshots are stored as .sql files for easy review and documentation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Normalizes SQL for comparison by:
 * - Collapsing multiple whitespace to single space
 * - Trimming each line
 * - Normalizing line endings
 * - Removing trailing semicolons (optional in generated SQL)
 *
 * Does NOT lowercase keywords to preserve readability in snapshots.
 */
export function normalizeSql(sql: string): string {
	return sql
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.filter((line) => !line.startsWith('--')) // Strip SQL comments
		.join('\n')
		.replace(/\s+/g, ' ')
		.replace(/;\s*$/, '')
		.trim();
}

/**
 * Formats SQL for snapshot storage with consistent formatting.
 * Adds light formatting for readability while keeping it parseable.
 */
export function formatSqlForSnapshot(sql: string): string {
	// Normalize first
	let formatted = normalizeSql(sql);

	// Add line breaks after major clauses for readability
	const clauses = [
		'SELECT',
		'FROM',
		'WHERE',
		'AND',
		'OR',
		'ORDER BY',
		'GROUP BY',
		'HAVING',
		'LIMIT',
		'OFFSET',
		'LEFT JOIN',
		'RIGHT JOIN',
		'INNER JOIN',
		'JOIN',
		'WITH',
	];

	for (const clause of clauses) {
		// Add newline before clause (except at start)
		const regex = new RegExp(`\\s+(${clause})\\s+`, 'gi');
		formatted = formatted.replace(regex, `\n${clause} `);
	}

	// Indent subqueries
	formatted = formatted.replace(/\(\s*SELECT/gi, '(\n  SELECT');
	formatted = formatted.replace(/EXISTS\s*\(\n/gi, 'EXISTS (\n');

	return formatted.trim();
}

/**
 * Gets the snapshot directory path for a test file.
 */
export function getSnapshotDir(testFilePath: string): string {
	const dir = dirname(testFilePath);
	const testFileName = basename(testFilePath, '.ts').replace('.test', '');
	return join(dir, '__snapshots__', testFileName);
}

/**
 * Sanitizes a test name for use as a filename.
 */
export function sanitizeTestName(testName: string): string {
	return testName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.substring(0, 100); // Limit length
}

/**
 * Gets the full path to a snapshot file.
 */
export function getSnapshotPath(
	testFilePath: string,
	testName: string,
): string {
	const snapshotDir = getSnapshotDir(testFilePath);
	const fileName = `${sanitizeTestName(testName)}.sql`;
	return join(snapshotDir, fileName);
}

/**
 * Reads a SQL snapshot from disk.
 * Returns null if the snapshot doesn't exist.
 */
export function readSqlSnapshot(
	testFilePath: string,
	testName: string,
): string | null {
	const snapshotPath = getSnapshotPath(testFilePath, testName);

	if (!existsSync(snapshotPath)) {
		return null;
	}

	return readFileSync(snapshotPath, 'utf-8');
}

/**
 * Writes a SQL snapshot to disk.
 * Creates the snapshot directory if it doesn't exist.
 */
export function writeSqlSnapshot(
	testFilePath: string,
	testName: string,
	sql: string,
): void {
	const snapshotPath = getSnapshotPath(testFilePath, testName);
	const snapshotDir = dirname(snapshotPath);

	if (!existsSync(snapshotDir)) {
		mkdirSync(snapshotDir, { recursive: true });
	}

	const formatted = formatSqlForSnapshot(sql);
	const header = `-- Snapshot: ${testName}\n-- Generated: ${new Date().toISOString().split('T')[0]}\n\n`;

	writeFileSync(snapshotPath, `${header + formatted}\n`, 'utf-8');
}

/**
 * Result of comparing two SQL strings.
 */
export interface SqlCompareResult {
	/** Whether the SQL strings match after normalization */
	match: boolean;
	/** Human-readable diff if they don't match */
	diff?: string;
	/** Normalized expected SQL */
	expected: string;
	/** Normalized actual SQL */
	actual: string;
}

/**
 * Compares two SQL strings after normalization.
 * Returns a result object with match status and optional diff.
 */
export function compareSql(expected: string, actual: string): SqlCompareResult {
	const normalizedExpected = normalizeSql(expected);
	const normalizedActual = normalizeSql(actual);

	if (normalizedExpected === normalizedActual) {
		return {
			match: true,
			expected: normalizedExpected,
			actual: normalizedActual,
		};
	}

	// Generate a simple diff
	const diff = generateSimpleDiff(normalizedExpected, normalizedActual);

	return {
		match: false,
		diff,
		expected: normalizedExpected,
		actual: normalizedActual,
	};
}

/**
 * Generates a simple line-by-line diff between two strings.
 */
function generateSimpleDiff(expected: string, actual: string): string {
	const lines: string[] = [];

	lines.push('SQL Snapshot Mismatch:');
	lines.push('');
	lines.push('Expected:');
	lines.push(`  ${expected}`);
	lines.push('');
	lines.push('Actual:');
	lines.push(`  ${actual}`);

	// Find first difference position
	let diffPos = 0;
	const minLen = Math.min(expected.length, actual.length);
	while (diffPos < minLen && expected[diffPos] === actual[diffPos]) {
		diffPos++;
	}

	if (diffPos < expected.length || diffPos < actual.length) {
		const context = 20;
		const start = Math.max(0, diffPos - context);
		const expectedSnippet = expected.substring(start, diffPos + context);
		const actualSnippet = actual.substring(start, diffPos + context);

		lines.push('');
		lines.push(`First difference at position ${diffPos}:`);
		lines.push(`  Expected: "...${expectedSnippet}..."`);
		lines.push(`  Actual:   "...${actualSnippet}..."`);
	}

	return lines.join('\n');
}

/**
 * Options for the SQL snapshot assertion.
 */
export interface SqlSnapshotOptions {
	/** Test file path (usually import.meta.url or __filename) */
	testFilePath: string;
	/** Test name for the snapshot file */
	testName: string;
	/** Whether to update snapshots (reads from UPDATE_SNAPSHOTS env) */
	update?: boolean;
}

/**
 * Asserts that SQL matches the stored snapshot.
 *
 * - If no snapshot exists, creates one and passes
 * - If snapshot exists and matches, passes
 * - If snapshot exists and differs, fails with diff (unless update mode)
 * - In update mode, overwrites snapshot and passes
 *
 * @throws Error if SQL doesn't match snapshot (and not in update mode)
 */
export function assertSqlSnapshot(
	sql: string,
	options: SqlSnapshotOptions,
): void {
	const { testFilePath, testName } = options;
	const update = options.update ?? process.env.UPDATE_SNAPSHOTS === 'true';

	const existing = readSqlSnapshot(testFilePath, testName);

	// No existing snapshot - create it
	if (existing === null) {
		writeSqlSnapshot(testFilePath, testName, sql);
		return;
	}

	// Compare with existing
	const result = compareSql(existing, sql);

	if (result.match) {
		return;
	}

	// Mismatch - update or fail
	if (update) {
		writeSqlSnapshot(testFilePath, testName, sql);
		return;
	}

	const snapshotPath = getSnapshotPath(testFilePath, testName);
	throw new Error(
		`${result.diff}\n\nSnapshot file: ${snapshotPath}\nRun with UPDATE_SNAPSHOTS=true to update.`,
	);
}
