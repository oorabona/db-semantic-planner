import { describe, expect, it } from 'vitest';
import {
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
		const config = matrixDatabaseConfig({});
		expect(config.databaseUrl).toBeUndefined();
		expect(config.requiresDatabaseUrl).toBe(false);
		expect(config.suiteName).toContain('skipped');
		expect(() => requireMatrixDatabaseUrl(config)).not.toThrow();
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
