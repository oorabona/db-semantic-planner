/**
 * Vitest Custom Matchers for SQL Snapshot Testing
 *
 * Usage in tests:
 * ```typescript
 * import { setupSqlSnapshotMatcher } from '@dbsp/adapter-kysely/test-utils';
 *
 * setupSqlSnapshotMatcher(import.meta.url);
 *
 * it('generates correct SQL', () => {
 *   const sql = query.dump().sql;
 *   expect(sql).toMatchSqlSnapshot('my-query');
 * });
 * ```
 */

import { expect } from 'vitest';
import { assertSqlSnapshot, compareSql } from './sql-snapshot.js';

/** Current test file path, set by setupSqlSnapshotMatcher */
let currentTestFilePath: string | null = null;

/**
 * Sets up the SQL snapshot matcher for the current test file.
 * Call this at the top of your test file.
 *
 * @param testFilePath - Usually `import.meta.url` or `__filename`
 */
export function setupSqlSnapshotMatcher(testFilePath: string): void {
	// Convert file:// URL to path if needed
	if (testFilePath.startsWith('file://')) {
		currentTestFilePath = new URL(testFilePath).pathname;
	} else {
		currentTestFilePath = testFilePath;
	}
}

/**
 * Gets the current test file path.
 * @throws Error if setupSqlSnapshotMatcher hasn't been called
 */
function getTestFilePath(): string {
	if (!currentTestFilePath) {
		throw new Error(
			'SQL snapshot matcher not initialized. Call setupSqlSnapshotMatcher(import.meta.url) at the top of your test file.',
		);
	}
	return currentTestFilePath;
}

/**
 * Custom matcher result type for Vitest.
 */
interface MatcherResult {
	pass: boolean;
	message: () => string;
}

/**
 * Vitest custom matcher for SQL snapshots.
 */
function toMatchSqlSnapshot(
	received: string,
	snapshotName: string,
): MatcherResult {
	const testFilePath = getTestFilePath();

	try {
		assertSqlSnapshot(received, {
			testFilePath,
			testName: snapshotName,
		});

		return {
			pass: true,
			message: () => `SQL matches snapshot "${snapshotName}"`,
		};
	} catch (error) {
		return {
			pass: false,
			message: () => (error instanceof Error ? error.message : String(error)),
		};
	}
}

/**
 * Vitest custom matcher for comparing SQL strings (without snapshots).
 * Useful for inline comparisons with normalization.
 */
function toMatchSql(received: string, expected: string): MatcherResult {
	const result = compareSql(expected, received);

	if (result.match) {
		return {
			pass: true,
			message: () => 'SQL strings match after normalization',
		};
	}

	return {
		pass: false,
		message: () => result.diff ?? 'SQL strings do not match',
	};
}

// Extend Vitest's expect with our custom matchers
expect.extend({
	toMatchSqlSnapshot,
	toMatchSql,
});

// TypeScript declaration merging for custom matchers
declare module 'vitest' {
	// biome-ignore lint/suspicious/noExplicitAny: Vitest requires this signature
	// biome-ignore lint/correctness/noUnusedVariables: Required to match Vitest's Assertion interface
	interface Assertion<T = any> {
		/**
		 * Asserts that SQL matches the stored snapshot file.
		 * Creates the snapshot if it doesn't exist.
		 *
		 * @param snapshotName - Name for the snapshot file (will be sanitized)
		 */
		toMatchSqlSnapshot(snapshotName: string): void;

		/**
		 * Asserts that two SQL strings are equivalent after normalization.
		 * Useful for inline comparisons without snapshot files.
		 *
		 * @param expected - The expected SQL string
		 */
		toMatchSql(expected: string): void;
	}

	interface AsymmetricMatchersContaining {
		toMatchSqlSnapshot(snapshotName: string): void;
		toMatchSql(expected: string): void;
	}
}
