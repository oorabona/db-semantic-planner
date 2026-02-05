/**
 * E06c: Schema Loader Tests
 *
 * Tests for MCP server schema loading with security measures.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSchema, SchemaLoadError, validatePath } from './schema-loader.js';

// Create a temp directory for test files
const testDir = join(tmpdir(), `dbsp-mcp-test-${Date.now()}`);
const allowedDir = join(testDir, 'allowed');
const outsideDir = join(testDir, 'outside');

beforeAll(() => {
	// Create test directories
	mkdirSync(allowedDir, { recursive: true });
	mkdirSync(outsideDir, { recursive: true });

	// Create valid schema file in allowed dir
	writeFileSync(
		join(allowedDir, 'valid-schema.js'),
		`
		module.exports.schema = {
			tables: { users: { id: 'uuid', name: 'text' } },
			relations: {}
		};
	`,
	);

	// Create schema file in outside dir (for path traversal tests)
	writeFileSync(
		join(outsideDir, 'outside-schema.js'),
		`
		module.exports.schema = {
			tables: { secret: { id: 'uuid' } },
			relations: {}
		};
	`,
	);

	// Create invalid schema (missing relations)
	writeFileSync(
		join(allowedDir, 'invalid-schema.js'),
		`
		module.exports.schema = {
			tables: { users: {} }
			// missing relations
		};
	`,
	);

	// Create schema with no export
	writeFileSync(
		join(allowedDir, 'no-export.js'),
		`
		const schema = { tables: {}, relations: {} };
		// not exported
	`,
	);
});

afterAll(() => {
	// Cleanup test directories
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true });
	}
});

describe('validatePath', () => {
	describe('basic path resolution', () => {
		it('should resolve relative paths to absolute', () => {
			const result = validatePath('./some/path.ts');
			expect(result).toBe(resolve(process.cwd(), 'some/path.ts'));
		});

		it('should return absolute paths unchanged', () => {
			const result = validatePath('/absolute/path.ts');
			expect(result).toBe('/absolute/path.ts');
		});

		it('should normalize existing paths with ..', () => {
			// Use an existing file with .. in the path - allowedDir/../allowed should resolve
			const pathWithDotDot = join(
				testDir,
				'allowed',
				'..',
				'allowed',
				'valid-schema.js',
			);
			const result = validatePath(pathWithDotDot);
			// Should resolve to the real path
			expect(result).toBe(join(allowedDir, 'valid-schema.js'));
		});
	});

	describe('path traversal detection', () => {
		it('should detect suspicious .. patterns for non-existent files', () => {
			expect(() => validatePath('../../../etc/passwd')).toThrow(
				SchemaLoadError,
			);
			expect(() => validatePath('../../../etc/passwd')).toThrow(
				'Suspicious path pattern',
			);
		});

		it('should have PATH_TRAVERSAL error code', () => {
			try {
				validatePath('../../../nonexistent/file.ts');
			} catch (error) {
				expect(error).toBeInstanceOf(SchemaLoadError);
				expect((error as SchemaLoadError).code).toBe('PATH_TRAVERSAL');
			}
		});
	});

	describe('allowedRoots validation', () => {
		it('should allow paths within allowed roots', () => {
			const schemaPath = join(allowedDir, 'valid-schema.js');
			const result = validatePath(schemaPath, [allowedDir]);
			expect(result).toBe(schemaPath);
		});

		it('should reject paths outside allowed roots', () => {
			const schemaPath = join(outsideDir, 'outside-schema.js');
			expect(() => validatePath(schemaPath, [allowedDir])).toThrow(
				SchemaLoadError,
			);
			expect(() => validatePath(schemaPath, [allowedDir])).toThrow(
				'outside allowed directories',
			);
		});

		it('should check against multiple allowed roots', () => {
			const schemaPath = join(outsideDir, 'outside-schema.js');
			// Now outside dir is in allowed roots
			const result = validatePath(schemaPath, [allowedDir, outsideDir]);
			expect(result).toBe(schemaPath);
		});

		it('should handle relative allowed roots', () => {
			const schemaPath = join(allowedDir, 'valid-schema.js');
			// Use relative path for allowedRoot
			const result = validatePath(schemaPath, [allowedDir]);
			expect(result).toBe(schemaPath);
		});
	});
});

describe('loadSchema', () => {
	describe('successful loading', () => {
		it('should load a valid schema file', async () => {
			const result = await loadSchema({
				schemaPath: join(allowedDir, 'valid-schema.js'),
			});

			expect(result.schema).toBeDefined();
			expect(result.schema.tables).toHaveProperty('users');
			expect(result.resolvedPath).toBe(join(allowedDir, 'valid-schema.js'));
		});

		it('should respect allowedRoots', async () => {
			const result = await loadSchema({
				schemaPath: join(allowedDir, 'valid-schema.js'),
				allowedRoots: [allowedDir],
			});

			expect(result.schema.tables).toHaveProperty('users');
		});
	});

	describe('error handling', () => {
		it('should throw NOT_FOUND for missing files', async () => {
			await expect(
				loadSchema({ schemaPath: join(allowedDir, 'nonexistent.js') }),
			).rejects.toThrow(SchemaLoadError);

			try {
				await loadSchema({ schemaPath: join(allowedDir, 'nonexistent.js') });
			} catch (error) {
				expect((error as SchemaLoadError).code).toBe('NOT_FOUND');
			}
		});

		it('should throw INVALID_SCHEMA for missing relations', async () => {
			await expect(
				loadSchema({ schemaPath: join(allowedDir, 'invalid-schema.js') }),
			).rejects.toThrow(SchemaLoadError);

			try {
				await loadSchema({ schemaPath: join(allowedDir, 'invalid-schema.js') });
			} catch (error) {
				expect((error as SchemaLoadError).code).toBe('INVALID_SCHEMA');
				expect((error as SchemaLoadError).message).toContain('relations');
			}
		});

		it('should throw INVALID_SCHEMA for missing export', async () => {
			await expect(
				loadSchema({ schemaPath: join(allowedDir, 'no-export.js') }),
			).rejects.toThrow(SchemaLoadError);

			try {
				await loadSchema({ schemaPath: join(allowedDir, 'no-export.js') });
			} catch (error) {
				expect((error as SchemaLoadError).code).toBe('INVALID_SCHEMA');
				expect((error as SchemaLoadError).message).toContain('export');
			}
		});

		it('should throw PATH_TRAVERSAL when outside allowed roots', async () => {
			await expect(
				loadSchema({
					schemaPath: join(outsideDir, 'outside-schema.js'),
					allowedRoots: [allowedDir],
				}),
			).rejects.toThrow(SchemaLoadError);

			try {
				await loadSchema({
					schemaPath: join(outsideDir, 'outside-schema.js'),
					allowedRoots: [allowedDir],
				});
			} catch (error) {
				expect((error as SchemaLoadError).code).toBe('PATH_TRAVERSAL');
			}
		});
	});
});

describe('SchemaLoadError', () => {
	it('should have correct name and code', () => {
		const error = new SchemaLoadError('Test error', 'NOT_FOUND');
		expect(error.name).toBe('SchemaLoadError');
		expect(error.code).toBe('NOT_FOUND');
		expect(error.message).toBe('Test error');
	});

	it('should support all error codes', () => {
		const codes = [
			'PATH_TRAVERSAL',
			'NOT_FOUND',
			'INVALID_SCHEMA',
			'LOAD_FAILED',
		] as const;
		for (const code of codes) {
			const error = new SchemaLoadError(`Error: ${code}`, code);
			expect(error.code).toBe(code);
		}
	});
});
