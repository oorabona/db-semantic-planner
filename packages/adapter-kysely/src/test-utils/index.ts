/**
 * Test Utilities for db-semantic-planner
 *
 * Provides SQL snapshot testing and other testing helpers.
 *
 * @example
 * ```typescript
 * import {
 *   setupSqlSnapshotMatcher,
 *   normalizeSql,
 *   compareSql,
 * } from '@db-semantic-planner/adapter-kysely/test-utils';
 *
 * setupSqlSnapshotMatcher(import.meta.url);
 *
 * describe('SQL generation', () => {
 *   it('generates correct SELECT', () => {
 *     const sql = query.dump().sql;
 *     expect(sql).toMatchSqlSnapshot('select-query');
 *   });
 * });
 * ```
 */

// Re-export dialect test helpers (from main package)
export {
	getDialectName,
	skipIfMissingCapability,
	withMockedCapabilities,
} from '../dialect.js';
// SQL Snapshot utilities
export {
	assertSqlSnapshot,
	compareSql,
	formatSqlForSnapshot,
	getSnapshotDir,
	getSnapshotPath,
	normalizeSql,
	readSqlSnapshot,
	type SqlCompareResult,
	type SqlSnapshotOptions,
	sanitizeTestName,
	writeSqlSnapshot,
} from './sql-snapshot.js';
// Vitest custom matchers
export { setupSqlSnapshotMatcher } from './vitest-matchers.js';
