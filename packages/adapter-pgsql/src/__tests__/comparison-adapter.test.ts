/**
 * ComparisonAdapter Tests
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
	type ComparisonMetrics,
	type ComparisonResult,
	compareParams,
	compareSql,
	createMetricsCollector,
	formatComparisonResult,
	generateMetricsSummary,
	generateSqlDiff,
	getComparisonMode,
	isComparisonEnabled,
	isStrictMode,
	resetMetrics,
	updateMetrics,
	validateSqlSyntax,
} from '../comparison-adapter.js';

describe('ComparisonAdapter', () => {
	describe('compareSql', () => {
		it('should match identical SQL', () => {
			const sql = 'SELECT * FROM users WHERE id = $1';
			expect(compareSql(sql, sql)).toBe(true);
		});

		it('should match SQL with different whitespace', () => {
			const sql1 = 'SELECT * FROM users WHERE id = $1';
			const sql2 = 'SELECT  *  FROM  users  WHERE  id  =  $1';
			expect(compareSql(sql1, sql2)).toBe(true);
		});

		it('should match SQL with different case', () => {
			const sql1 = 'SELECT * FROM users WHERE id = $1';
			const sql2 = 'select * from users where id = $1';
			expect(compareSql(sql1, sql2)).toBe(true);
		});

		it('should match SQL with whitespace around parentheses', () => {
			const sql1 = 'SELECT * FROM users WHERE (active = true)';
			const sql2 = 'SELECT * FROM users WHERE ( active = true )';
			expect(compareSql(sql1, sql2)).toBe(true);
		});

		it('should detect different SQL', () => {
			const sql1 = 'SELECT * FROM users';
			const sql2 = 'SELECT * FROM posts';
			expect(compareSql(sql1, sql2)).toBe(false);
		});
	});

	describe('compareParams', () => {
		it('should match identical params', () => {
			const params = [1, 'test', true];
			expect(compareParams(params, [...params])).toBe(true);
		});

		it('should match empty params', () => {
			expect(compareParams([], [])).toBe(true);
		});

		it('should detect different param count', () => {
			expect(compareParams([1, 2], [1])).toBe(false);
		});

		it('should detect different param values', () => {
			expect(compareParams([1, 2, 3], [1, 2, 4])).toBe(false);
		});

		it('should detect different param types', () => {
			expect(compareParams([1], ['1'])).toBe(false);
		});

		it('should compare dates correctly', () => {
			const date = new Date('2024-01-01');
			expect(compareParams([date], [new Date('2024-01-01')])).toBe(true);
			expect(compareParams([date], [new Date('2024-01-02')])).toBe(false);
		});
	});

	describe('generateSqlDiff', () => {
		it('should identify lines only in pgsql', () => {
			const pgsql = 'SELECT *\nFROM users\nWHERE active = true';
			const kysely = 'SELECT *\nFROM users';

			const diff = generateSqlDiff(pgsql, kysely);

			expect(diff.pgsqlOnly).toContain('WHERE active = true');
			expect(diff.kyselyOnly).toHaveLength(0);
		});

		it('should identify lines only in kysely', () => {
			const pgsql = 'SELECT *\nFROM users';
			const kysely = 'SELECT *\nFROM users\nORDER BY id';

			const diff = generateSqlDiff(pgsql, kysely);

			expect(diff.pgsqlOnly).toHaveLength(0);
			expect(diff.kyselyOnly).toContain('ORDER BY id');
		});

		it('should identify structural differences', () => {
			const pgsql = 'SELECT * FROM users WHERE id = $1';
			const kysely = 'SELECT * FROM users';

			const diff = generateSqlDiff(pgsql, kysely);

			expect(diff.structural).toContainEqual('WHERE: pgsql only');
		});

		it('should detect JOIN presence difference', () => {
			const pgsql =
				'SELECT * FROM users JOIN posts ON users.id = posts.user_id';
			const kysely = 'SELECT * FROM users';

			const diff = generateSqlDiff(pgsql, kysely);

			expect(diff.structural).toContainEqual('JOIN: pgsql only');
		});
	});

	describe('formatComparisonResult', () => {
		it('should format matching result', () => {
			const result: ComparisonResult = {
				match: true,
				pgsqlSql: 'SELECT * FROM users',
				pgsqlParams: [],
				pgsqlTimeMs: 1.5,
			};

			const formatted = formatComparisonResult(result);
			expect(formatted).toContain('✓');
			expect(formatted).toContain('1.50ms');
		});

		it('should format mismatch result', () => {
			const result: ComparisonResult = {
				match: false,
				pgsqlSql: 'SELECT * FROM users',
				kyselySql: 'SELECT * FROM posts',
				pgsqlParams: [],
				kyselyParams: [],
				pgsqlTimeMs: 1.5,
				kyselyTimeMs: 2.0,
				diff: {
					pgsqlOnly: ['FROM users'],
					kyselyOnly: ['FROM posts'],
					structural: [],
				},
			};

			const formatted = formatComparisonResult(result);
			expect(formatted).toContain('✗');
			expect(formatted).toContain('MISMATCH');
			expect(formatted).toContain('pgsql');
			expect(formatted).toContain('kysely');
		});
	});

	describe('Metrics', () => {
		let metrics: ComparisonMetrics;

		beforeEach(() => {
			metrics = createMetricsCollector();
		});

		it('should initialize with zero counts', () => {
			expect(metrics.totalComparisons).toBe(0);
			expect(metrics.matches).toBe(0);
			expect(metrics.mismatches).toBe(0);
		});

		it('should update on match', () => {
			const result: ComparisonResult = {
				match: true,
				pgsqlSql: 'SELECT 1',
				pgsqlParams: [],
				pgsqlTimeMs: 1.0,
			};

			updateMetrics(metrics, result, 'select');

			expect(metrics.totalComparisons).toBe(1);
			expect(metrics.matches).toBe(1);
			expect(metrics.mismatches).toBe(0);
		});

		it('should update on mismatch', () => {
			const result: ComparisonResult = {
				match: false,
				pgsqlSql: 'SELECT 1',
				pgsqlParams: [],
				pgsqlTimeMs: 1.0,
				diff: {
					pgsqlOnly: [],
					kyselyOnly: [],
					structural: ['test'],
				},
			};

			updateMetrics(metrics, result, 'select');

			expect(metrics.totalComparisons).toBe(1);
			expect(metrics.matches).toBe(0);
			expect(metrics.mismatches).toBe(1);
			expect(metrics.mismatchDetails).toHaveLength(1);
		});

		it('should calculate running average', () => {
			const result1: ComparisonResult = {
				match: true,
				pgsqlSql: 'SELECT 1',
				pgsqlParams: [],
				pgsqlTimeMs: 10.0,
			};
			const result2: ComparisonResult = {
				match: true,
				pgsqlSql: 'SELECT 2',
				pgsqlParams: [],
				pgsqlTimeMs: 20.0,
			};

			updateMetrics(metrics, result1, 'select');
			updateMetrics(metrics, result2, 'select');

			expect(metrics.avgPgsqlTimeMs).toBe(15.0);
		});

		it('should reset metrics', () => {
			updateMetrics(
				metrics,
				{
					match: true,
					pgsqlSql: 'SELECT 1',
					pgsqlParams: [],
					pgsqlTimeMs: 1.0,
				},
				'select',
			);

			resetMetrics(metrics);

			expect(metrics.totalComparisons).toBe(0);
			expect(metrics.matches).toBe(0);
			expect(metrics.mismatchDetails).toHaveLength(0);
		});

		it('should generate summary', () => {
			updateMetrics(
				metrics,
				{
					match: true,
					pgsqlSql: 'SELECT 1',
					pgsqlParams: [],
					pgsqlTimeMs: 1.0,
				},
				'select',
			);

			const summary = generateMetricsSummary(metrics);

			expect(summary).toContain('Total comparisons: 1');
			expect(summary).toContain('Matches: 1');
			expect(summary).toContain('100.0%');
		});
	});

	describe('Environment Mode', () => {
		it('should return pgsql by default', () => {
			const originalEnv = process.env.DBSP_COMPARISON_MODE;
			delete process.env.DBSP_COMPARISON_MODE;

			expect(getComparisonMode()).toBe('pgsql');

			if (originalEnv) {
				process.env.DBSP_COMPARISON_MODE = originalEnv;
			}
		});

		it('should parse environment variable', () => {
			const originalEnv = process.env.DBSP_COMPARISON_MODE;
			process.env.DBSP_COMPARISON_MODE = 'compare';

			expect(getComparisonMode()).toBe('compare');

			if (originalEnv) {
				process.env.DBSP_COMPARISON_MODE = originalEnv;
			} else {
				delete process.env.DBSP_COMPARISON_MODE;
			}
		});

		it('should detect comparison enabled', () => {
			const originalEnv = process.env.DBSP_COMPARISON_MODE;
			process.env.DBSP_COMPARISON_MODE = 'compare';

			expect(isComparisonEnabled()).toBe(true);

			delete process.env.DBSP_COMPARISON_MODE;
			expect(isComparisonEnabled()).toBe(false);

			if (originalEnv) {
				process.env.DBSP_COMPARISON_MODE = originalEnv;
			}
		});

		it('should detect strict mode', () => {
			const originalEnv = process.env.DBSP_COMPARISON_MODE;
			process.env.DBSP_COMPARISON_MODE = 'strict';

			expect(isStrictMode()).toBe(true);

			process.env.DBSP_COMPARISON_MODE = 'compare';
			expect(isStrictMode()).toBe(false);

			if (originalEnv) {
				process.env.DBSP_COMPARISON_MODE = originalEnv;
			} else {
				delete process.env.DBSP_COMPARISON_MODE;
			}
		});
	});

	describe('validateSqlSyntax', () => {
		it('should validate SELECT statement', () => {
			expect(validateSqlSyntax('SELECT * FROM users')).toBe(true);
		});

		it('should validate INSERT statement', () => {
			expect(validateSqlSyntax('INSERT INTO users (name) VALUES ($1)')).toBe(
				true,
			);
		});

		it('should validate UPDATE statement', () => {
			expect(validateSqlSyntax('UPDATE users SET name = $1')).toBe(true);
		});

		it('should validate DELETE statement', () => {
			expect(validateSqlSyntax('DELETE FROM users WHERE id = $1')).toBe(true);
		});

		it('should validate WITH statement', () => {
			expect(
				validateSqlSyntax('WITH cte AS (SELECT 1) SELECT * FROM cte'),
			).toBe(true);
		});

		it('should reject invalid SQL', () => {
			expect(validateSqlSyntax('INVALID SQL')).toBe(false);
		});

		it('should detect missing columns in SELECT', () => {
			expect(validateSqlSyntax('SELECT FROM users')).toBe(false);
		});

		it('should detect missing first condition in WHERE', () => {
			expect(
				validateSqlSyntax('SELECT * FROM users WHERE AND active = true'),
			).toBe(false);
		});

		it('should detect trailing comma before FROM', () => {
			expect(validateSqlSyntax('SELECT id, FROM users')).toBe(false);
		});
	});
});
