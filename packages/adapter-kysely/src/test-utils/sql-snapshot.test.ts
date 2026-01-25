/**
 * Tests for SQL Snapshot Testing Utilities
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	assertSqlSnapshot,
	compareSql,
	formatSqlForSnapshot,
	getSnapshotDir,
	getSnapshotPath,
	normalizeSql,
	readSqlSnapshot,
	sanitizeTestName,
	writeSqlSnapshot,
} from './sql-snapshot.js';
import { setupSqlSnapshotMatcher } from './vitest-matchers.js';

// Initialize matcher for this test file
setupSqlSnapshotMatcher(import.meta.url);

describe('SQL Snapshot Utilities', () => {
	describe('normalizeSql', () => {
		it('should collapse multiple whitespace to single space', () => {
			const input = 'SELECT   *   FROM    users';
			expect(normalizeSql(input)).toBe('SELECT * FROM users');
		});

		it('should trim leading and trailing whitespace', () => {
			const input = '  SELECT * FROM users  ';
			expect(normalizeSql(input)).toBe('SELECT * FROM users');
		});

		it('should normalize multi-line SQL', () => {
			const input = `
        SELECT *
        FROM users
        WHERE id = $1
      `;
			expect(normalizeSql(input)).toBe('SELECT * FROM users WHERE id = $1');
		});

		it('should remove trailing semicolons', () => {
			const input = 'SELECT * FROM users;';
			expect(normalizeSql(input)).toBe('SELECT * FROM users');
		});

		it('should handle empty string', () => {
			expect(normalizeSql('')).toBe('');
		});

		it('should handle SQL with EXISTS subquery', () => {
			const input = `
        SELECT "t0".* FROM "products" "t0"
        WHERE EXISTS (
          SELECT 1 FROM "product_images" "t1"
          WHERE "t1"."product_id" = "t0"."id"
        )
      `;
			const expected =
				'SELECT "t0".* FROM "products" "t0" WHERE EXISTS ( SELECT 1 FROM "product_images" "t1" WHERE "t1"."product_id" = "t0"."id" )';
			expect(normalizeSql(input)).toBe(expected);
		});

		it('should preserve parameter placeholders', () => {
			const input = 'SELECT * FROM users WHERE name = $1 AND age > $2';
			expect(normalizeSql(input)).toBe(
				'SELECT * FROM users WHERE name = $1 AND age > $2',
			);
		});
	});

	describe('formatSqlForSnapshot', () => {
		it('should add line breaks after major clauses', () => {
			const input = 'SELECT * FROM users WHERE id = $1 ORDER BY name LIMIT 10';
			const formatted = formatSqlForSnapshot(input);
			expect(formatted).toContain('\nFROM');
			expect(formatted).toContain('\nWHERE');
			expect(formatted).toContain('\nORDER BY');
			expect(formatted).toContain('\nLIMIT');
		});

		it('should handle SELECT with joins', () => {
			const input =
				'SELECT * FROM users LEFT JOIN orders ON orders.user_id = users.id WHERE users.active = true';
			const formatted = formatSqlForSnapshot(input);
			// Formatting adds structure - verify clauses are present
			expect(formatted).toContain('LEFT');
			expect(formatted).toContain('JOIN');
			expect(formatted).toContain('WHERE');
			// Should have line breaks for readability
			expect(formatted.split('\n').length).toBeGreaterThan(2);
		});
	});

	describe('sanitizeTestName', () => {
		it('should lowercase the name', () => {
			expect(sanitizeTestName('MyTestName')).toBe('mytestname');
		});

		it('should replace non-alphanumeric characters with hyphens', () => {
			expect(sanitizeTestName('test with spaces')).toBe('test-with-spaces');
		});

		it('should remove leading and trailing hyphens', () => {
			expect(sanitizeTestName('--test--')).toBe('test');
		});

		it('should truncate long names', () => {
			const longName = 'a'.repeat(150);
			expect(sanitizeTestName(longName).length).toBeLessThanOrEqual(100);
		});

		it('should handle special characters', () => {
			expect(sanitizeTestName('test: with (special) chars!')).toBe(
				'test-with-special-chars',
			);
		});
	});

	describe('getSnapshotDir', () => {
		it('should return __snapshots__ directory with test file name', () => {
			const testPath = '/path/to/my-feature.test.ts';
			expect(getSnapshotDir(testPath)).toBe(
				'/path/to/__snapshots__/my-feature',
			);
		});

		it('should strip .test suffix from directory name', () => {
			const testPath = '/path/to/compiler.test.ts';
			expect(getSnapshotDir(testPath)).toBe('/path/to/__snapshots__/compiler');
		});
	});

	describe('getSnapshotPath', () => {
		it('should return full path to snapshot file', () => {
			const testPath = '/path/to/compiler.test.ts';
			const testName = 'select with exists';
			const snapshotPath = getSnapshotPath(testPath, testName);
			expect(snapshotPath).toBe(
				'/path/to/__snapshots__/compiler/select-with-exists.sql',
			);
		});
	});

	describe('compareSql', () => {
		it('should match identical SQL', () => {
			const sql = 'SELECT * FROM users';
			const result = compareSql(sql, sql);
			expect(result.match).toBe(true);
			expect(result.diff).toBeUndefined();
		});

		it('should match SQL with different whitespace', () => {
			const expected = 'SELECT * FROM users';
			const actual = 'SELECT   *   FROM   users';
			const result = compareSql(expected, actual);
			expect(result.match).toBe(true);
		});

		it('should match SQL with different line breaks', () => {
			const expected = 'SELECT * FROM users WHERE id = $1';
			const actual = `SELECT *
        FROM users
        WHERE id = $1`;
			const result = compareSql(expected, actual);
			expect(result.match).toBe(true);
		});

		it('should not match different SQL', () => {
			const expected = 'SELECT * FROM users';
			const actual = 'SELECT * FROM products';
			const result = compareSql(expected, actual);
			expect(result.match).toBe(false);
			expect(result.diff).toBeDefined();
			expect(result.diff).toContain('Expected:');
			expect(result.diff).toContain('Actual:');
		});

		it('should include diff with position information', () => {
			const expected = 'SELECT * FROM users WHERE active = true';
			const actual = 'SELECT * FROM users WHERE active = false';
			const result = compareSql(expected, actual);
			expect(result.match).toBe(false);
			expect(result.diff).toContain('First difference at position');
		});
	});

	describe('Snapshot File Operations', () => {
		const testTmpDir = join(tmpdir(), `sql-snapshot-test-${Date.now()}`);
		const fakeTestFile = join(testTmpDir, 'fake.test.ts');

		beforeEach(() => {
			mkdirSync(testTmpDir, { recursive: true });
		});

		afterEach(() => {
			if (existsSync(testTmpDir)) {
				rmSync(testTmpDir, { recursive: true, force: true });
			}
		});

		describe('readSqlSnapshot', () => {
			it('should return null for non-existent snapshot', () => {
				const result = readSqlSnapshot(fakeTestFile, 'non-existent');
				expect(result).toBeNull();
			});

			it('should read existing snapshot', () => {
				// Create snapshot manually
				const snapshotDir = getSnapshotDir(fakeTestFile);
				mkdirSync(snapshotDir, { recursive: true });
				const snapshotPath = getSnapshotPath(fakeTestFile, 'my-test');
				writeFileSync(snapshotPath, 'SELECT * FROM users\n');

				const result = readSqlSnapshot(fakeTestFile, 'my-test');
				expect(result).toBe('SELECT * FROM users\n');
			});
		});

		describe('writeSqlSnapshot', () => {
			it('should create snapshot directory if missing', () => {
				const snapshotDir = getSnapshotDir(fakeTestFile);
				expect(existsSync(snapshotDir)).toBe(false);

				writeSqlSnapshot(fakeTestFile, 'new-test', 'SELECT 1');

				expect(existsSync(snapshotDir)).toBe(true);
			});

			it('should write formatted SQL with header', () => {
				writeSqlSnapshot(
					fakeTestFile,
					'my-query',
					'SELECT * FROM users WHERE id = $1',
				);

				const snapshotPath = getSnapshotPath(fakeTestFile, 'my-query');
				const content = readFileSync(snapshotPath, 'utf-8');

				expect(content).toContain('-- Snapshot: my-query');
				expect(content).toContain('-- Generated:');
				expect(content).toContain('SELECT');
			});
		});

		describe('assertSqlSnapshot', () => {
			it('should create snapshot on first run', () => {
				const snapshotPath = getSnapshotPath(fakeTestFile, 'first-run');
				expect(existsSync(snapshotPath)).toBe(false);

				// Should not throw
				assertSqlSnapshot('SELECT * FROM users', {
					testFilePath: fakeTestFile,
					testName: 'first-run',
				});

				expect(existsSync(snapshotPath)).toBe(true);
			});

			it('should pass when SQL matches snapshot', () => {
				// Create initial snapshot
				assertSqlSnapshot('SELECT * FROM users', {
					testFilePath: fakeTestFile,
					testName: 'match-test',
				});

				// Should pass with same SQL
				expect(() => {
					assertSqlSnapshot('SELECT * FROM users', {
						testFilePath: fakeTestFile,
						testName: 'match-test',
					});
				}).not.toThrow();
			});

			it('should pass when SQL matches after normalization', () => {
				// Create initial snapshot
				assertSqlSnapshot('SELECT * FROM users', {
					testFilePath: fakeTestFile,
					testName: 'normalize-test',
				});

				// Should pass with different whitespace
				expect(() => {
					assertSqlSnapshot('SELECT   *   FROM   users', {
						testFilePath: fakeTestFile,
						testName: 'normalize-test',
					});
				}).not.toThrow();
			});

			it('should fail when SQL differs', () => {
				// Create initial snapshot
				assertSqlSnapshot('SELECT * FROM users', {
					testFilePath: fakeTestFile,
					testName: 'fail-test',
				});

				// Should fail with different SQL
				expect(() => {
					assertSqlSnapshot('SELECT * FROM products', {
						testFilePath: fakeTestFile,
						testName: 'fail-test',
					});
				}).toThrow(/SQL Snapshot Mismatch/);
			});

			it('should update snapshot when update option is true', () => {
				// Create initial snapshot
				assertSqlSnapshot('SELECT * FROM users', {
					testFilePath: fakeTestFile,
					testName: 'update-test',
				});

				// Should update instead of fail
				expect(() => {
					assertSqlSnapshot('SELECT * FROM products', {
						testFilePath: fakeTestFile,
						testName: 'update-test',
						update: true,
					});
				}).not.toThrow();

				// Verify snapshot was updated
				const content = readSqlSnapshot(fakeTestFile, 'update-test');
				expect(content).toContain('products');
			});
		});
	});

	describe('Vitest Custom Matchers', () => {
		// Note: Custom matchers are registered at runtime via expect.extend()
		// TypeScript doesn't see them statically, so we use @ts-expect-error

		describe('toMatchSql', () => {
			it('should match identical SQL', () => {
				const sql = 'SELECT * FROM users';
				// @ts-expect-error - toMatchSql is a custom matcher registered at runtime
				expect(sql).toMatchSql('SELECT * FROM users');
			});

			it('should match SQL with different whitespace', () => {
				const sql = 'SELECT   *   FROM   users';
				// @ts-expect-error - toMatchSql is a custom matcher registered at runtime
				expect(sql).toMatchSql('SELECT * FROM users');
			});

			it('should match multi-line SQL', () => {
				const sql = `
          SELECT *
          FROM users
          WHERE id = $1
        `;
				// @ts-expect-error - toMatchSql is a custom matcher registered at runtime
				expect(sql).toMatchSql('SELECT * FROM users WHERE id = $1');
			});

			it('should fail for different SQL', () => {
				expect(() => {
					// @ts-expect-error - toMatchSql is a custom matcher registered at runtime
					expect('SELECT * FROM users').toMatchSql('SELECT * FROM products');
				}).toThrow();
			});
		});

		describe('toMatchSqlSnapshot (unit behavior)', () => {
			// Note: Full integration tests for toMatchSqlSnapshot would create
			// actual snapshot files. These tests verify the matcher is properly set up.

			it('should be defined on expect', () => {
				// @ts-expect-error - toMatchSqlSnapshot is a custom matcher registered at runtime
				expect(typeof expect('').toMatchSqlSnapshot).toBe('function');
			});

			it('should be defined on expect (toMatchSql)', () => {
				// @ts-expect-error - toMatchSql is a custom matcher registered at runtime
				expect(typeof expect('').toMatchSql).toBe('function');
			});
		});
	});
});
