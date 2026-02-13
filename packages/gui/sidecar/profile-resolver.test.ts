import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	parseEnvFile,
	parsePostgresUrl,
	resolveProfileUri,
} from './profile-resolver.js';

// ── parseEnvFile ─────────────────────────────────────────────────

describe('parseEnvFile', () => {
	it('parses KEY=VALUE lines', () => {
		const result = parseEnvFile(
			'DATABASE_URL=postgresql://localhost/mydb\nPORT=3000',
		);
		expect(result).toEqual({
			DATABASE_URL: 'postgresql://localhost/mydb',
			PORT: '3000',
		});
	});

	it('ignores comments and empty lines', () => {
		const result = parseEnvFile('# this is a comment\n\nKEY=value\n');
		expect(result).toEqual({ KEY: 'value' });
	});

	it('strips double quotes', () => {
		const result = parseEnvFile('KEY="some value"');
		expect(result).toEqual({ KEY: 'some value' });
	});

	it('strips single quotes', () => {
		const result = parseEnvFile("KEY='some value'");
		expect(result).toEqual({ KEY: 'some value' });
	});

	it('handles values with = signs', () => {
		const result = parseEnvFile('URL=postgresql://user:p=ss@host/db');
		expect(result).toEqual({ URL: 'postgresql://user:p=ss@host/db' });
	});

	it('trims whitespace around key and value', () => {
		const result = parseEnvFile('  KEY  =  value  ');
		expect(result).toEqual({ KEY: 'value' });
	});

	it('returns empty for blank content', () => {
		expect(parseEnvFile('')).toEqual({});
	});
});

// ── parsePostgresUrl ─────────────────────────────────────────────

describe('parsePostgresUrl', () => {
	it('parses full postgresql:// URL', () => {
		const result = parsePostgresUrl(
			'postgresql://user:pass@localhost:5432/mydb',
		);
		expect(result).toEqual({
			host: 'localhost',
			port: 5432,
			database: 'mydb',
			user: 'user',
			password: 'pass',
		});
	});

	it('parses postgres:// (without ql)', () => {
		const result = parsePostgresUrl(
			'postgres://admin:secret@db.example.com:5433/prod',
		);
		expect(result).toEqual({
			host: 'db.example.com',
			port: 5433,
			database: 'prod',
			user: 'admin',
			password: 'secret',
		});
	});

	it('uses defaults for missing parts', () => {
		const result = parsePostgresUrl('postgresql:///');
		expect(result.host).toBe('localhost');
		expect(result.port).toBe(5432);
		expect(result.user).toBe('postgres');
		expect(result.password).toBe('');
		expect(result.database).toBe('postgres');
	});

	it('extracts schema from search_path param', () => {
		const result = parsePostgresUrl(
			'postgresql://u:p@h/db?search_path=tenant_1',
		);
		expect(result.schema).toBe('tenant_1');
	});

	it('extracts schema from schema param', () => {
		const result = parsePostgresUrl('postgresql://u:p@h/db?schema=public');
		expect(result.schema).toBe('public');
	});

	it('extracts sslmode param', () => {
		const result = parsePostgresUrl('postgresql://u:p@h/db?sslmode=require');
		expect(result.sslMode).toBe('require');
	});

	it('decodes percent-encoded credentials', () => {
		const result = parsePostgresUrl('postgresql://my%40user:p%40ss@h/db');
		expect(result.user).toBe('my@user');
		expect(result.password).toBe('p@ss');
	});

	it('throws for non-postgres URLs', () => {
		expect(() => parsePostgresUrl('mysql://user:pass@host/db')).toThrow(
			'Expected postgresql:// or postgres://',
		);
	});

	it('throws for invalid URLs', () => {
		expect(() => parsePostgresUrl('not-a-url')).toThrow(
			'Invalid connection URL',
		);
	});
});

// ── resolveProfileUri ────────────────────────────────────────────

describe('resolveProfileUri', () => {
	it('throws for unsupported scheme', async () => {
		await expect(resolveProfileUri('http://example.com')).rejects.toThrow(
			'Unsupported or invalid URI scheme',
		);
	});

	describe('env:// scheme', () => {
		beforeEach(() => {
			vi.unstubAllEnvs();
		});

		it('resolves env var to connection params', async () => {
			// Arrange
			vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/mydb');

			// Act
			const result = await resolveProfileUri('env://DATABASE_URL');

			// Assert
			expect(result).toEqual({
				host: 'localhost',
				port: 5432,
				database: 'mydb',
				user: 'user',
				password: 'pass',
			});
		});

		it('throws when env var is not set', async () => {
			// Arrange — ensure the var doesn't exist
			delete process.env.NONEXISTENT_VAR;

			// Act & Assert
			await expect(resolveProfileUri('env://NONEXISTENT_VAR')).rejects.toThrow(
				'Environment variable NONEXISTENT_VAR is not set',
			);
		});
	});

	describe('file:// scheme', () => {
		it('rejects path traversal attempts (SEC-01)', async () => {
			await expect(
				resolveProfileUri('file://../../etc/passwd', '/project'),
			).rejects.toThrow('Path traversal blocked');
		});
	});
});
