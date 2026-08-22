import { describe, expect, it } from 'vitest';
import {
	isMatrixCi,
	matrixDatabaseConfig,
	normalizeMatrixDatabaseUrl,
	requireMatrixDatabaseUrl,
} from './catalogue-matrix-config.js';

describe('catalogue matrix environment gating', () => {
	it('normalizes omitted, blank, and whitespace URLs to absent', () => {
		expect(normalizeMatrixDatabaseUrl(undefined)).toBeUndefined();
		expect(normalizeMatrixDatabaseUrl('')).toBeUndefined();
		expect(normalizeMatrixDatabaseUrl(' \t\n ')).toBeUndefined();
		expect(normalizeMatrixDatabaseUrl(' postgres://dbsp@localhost/dbsp ')).toBe(
			'postgres://dbsp@localhost/dbsp',
		);
	});

	it('keeps a missing local URL as a loud skip', () => {
		for (const CI of [undefined, '', '0', 'false', 'FALSE']) {
			const config = matrixDatabaseConfig({ CI });
			expect(config.databaseUrl).toBeUndefined();
			expect(config.requiresDatabaseUrl).toBe(false);
			expect(config.suiteName).toContain('skipped');
			expect(() => requireMatrixDatabaseUrl(config)).not.toThrow();
		}
	});

	it.each([
		['unset', undefined, false],
		['empty', '', false],
		['zero', '0', false],
		['false', 'false', false],
		['one', '1', true],
		['true', 'true', true],
		['uppercase true', 'TRUE', true],
	])('parses CI value %s explicitly', (_label, value, expected) => {
		expect(isMatrixCi(value)).toBe(expected);
	});

	it('refuses a missing CI URL unless the explicit skip override is set', () => {
		const required = matrixDatabaseConfig({
			CI: '1',
			MATRIX_DATABASE_URL: ' ',
		});
		expect(() => requireMatrixDatabaseUrl(required)).toThrow(
			'MATRIX_DATABASE_URL is required in CI',
		);
		const allowed = matrixDatabaseConfig({
			CI: '1',
			MATRIX_ALLOW_SKIP: '1',
			MATRIX_DATABASE_URL: '',
		});
		expect(() => requireMatrixDatabaseUrl(allowed)).not.toThrow();
	});
});
