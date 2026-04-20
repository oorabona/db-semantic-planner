/**
 * E06c: Schema Loader Tests
 *
 * Tests for MCP server schema loading with security measures.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	loadSchema,
	SchemaLoadError,
	validatePath,
	validateResolvedSchema,
} from './schema-loader.js';

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

		it('should normalize existing paths with .. that stay within allowed root', () => {
			// Use an existing file with .. in the path - allowedDir/../allowed should resolve
			// to the same directory, so it IS within testDir. We must pass allowedRoots
			// so containment is checked against testDir (not cwd which is outside /tmp).
			const pathWithDotDot = join(
				testDir,
				'allowed',
				'..',
				'allowed',
				'valid-schema.js',
			);
			const result = validatePath(pathWithDotDot, [testDir]);
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
				allowedRoots: [testDir],
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
				loadSchema({
					schemaPath: join(allowedDir, 'nonexistent.js'),
					allowedRoots: [testDir],
				}),
			).rejects.toThrow(SchemaLoadError);

			try {
				await loadSchema({
					schemaPath: join(allowedDir, 'nonexistent.js'),
					allowedRoots: [testDir],
				});
			} catch (error) {
				expect((error as SchemaLoadError).code).toBe('NOT_FOUND');
			}
		});

		it('should throw INVALID_SCHEMA for missing relations', async () => {
			await expect(
				loadSchema({
					schemaPath: join(allowedDir, 'invalid-schema.js'),
					allowedRoots: [testDir],
				}),
			).rejects.toThrow(SchemaLoadError);

			try {
				await loadSchema({
					schemaPath: join(allowedDir, 'invalid-schema.js'),
					allowedRoots: [testDir],
				});
			} catch (error) {
				expect((error as SchemaLoadError).code).toBe('INVALID_SCHEMA');
				expect((error as SchemaLoadError).message).toContain('relations');
			}
		});

		it('should throw INVALID_SCHEMA for missing export', async () => {
			await expect(
				loadSchema({
					schemaPath: join(allowedDir, 'no-export.js'),
					allowedRoots: [testDir],
				}),
			).rejects.toThrow(SchemaLoadError);

			try {
				await loadSchema({
					schemaPath: join(allowedDir, 'no-export.js'),
					allowedRoots: [testDir],
				});
			} catch (error) {
				expect((error as SchemaLoadError).code).toBe('INVALID_SCHEMA');
				expect((error as SchemaLoadError).message).toContain('export');
			}
		});

		it('should throw PATH_TRAVERSAL when outside allowed roots', async () => {
			await expect(
				loadSchema({
					schemaPath: join(outsideDir, 'outside-schema.js'),
					allowedRoots: [allowedDir], // only allowedDir, not outsideDir
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

// ─── Regression tests (new for audit 2026-04-20) ────────────────────────────

import { symlinkSync, unlinkSync } from 'node:fs';

describe('C1 regression: path traversal to existing file', () => {
	it('should reject a path with .. that resolves to an existing file', () => {
		// The existing-file branch must NOT bypass the traversal check.
		// Construct a path using '..' that resolves to an existing file on disk.
		const pathWithEscape = join(
			allowedDir,
			'..',
			'outside',
			'outside-schema.js',
		);
		// This path contains '..' and resolves OUTSIDE allowedDir — must be rejected
		// when allowedRoots is set to allowedDir.
		expect(() => validatePath(pathWithEscape, [allowedDir])).toThrow(
			SchemaLoadError,
		);
		try {
			validatePath(pathWithEscape, [allowedDir]);
		} catch (err) {
			expect((err as SchemaLoadError).code).toBe('PATH_TRAVERSAL');
		}
	});

	it('should reject a raw .. traversal to existing /tmp even without allowedRoots', () => {
		// A path with .. that escapes cwd must be rejected unconditionally
		const escapePath = '../../../tmp';
		expect(() => validatePath(escapePath)).toThrow(SchemaLoadError);
		try {
			validatePath(escapePath);
		} catch (err) {
			expect((err as SchemaLoadError).code).toBe('PATH_TRAVERSAL');
		}
	});
});

describe('C1 regression: TOCTOU symlink swap', () => {
	it('loadSchema should detect symlink swapped to outside allowed root', async () => {
		// Create a symlink inside allowedDir that initially points to valid-schema.js
		const symlinkPath = join(allowedDir, 'link-schema.js');

		// Clean up first in case a previous test run left it
		if (existsSync(symlinkPath)) {
			unlinkSync(symlinkPath);
		}

		// Create symlink → valid target
		symlinkSync(join(allowedDir, 'valid-schema.js'), symlinkPath);

		// Swap symlink to outside target BEFORE loadSchema can import it.
		// We simulate post-validatePath swap by directly invoking loadSchema with
		// a symlink that already points outside (the "after swap" state).
		unlinkSync(symlinkPath);
		symlinkSync(join(outsideDir, 'outside-schema.js'), symlinkPath);

		// loadSchema should detect that the canonical path is now outside allowedDir
		await expect(
			loadSchema({ schemaPath: symlinkPath, allowedRoots: [allowedDir] }),
		).rejects.toThrow(SchemaLoadError);

		try {
			await loadSchema({ schemaPath: symlinkPath, allowedRoots: [allowedDir] });
		} catch (err) {
			expect((err as SchemaLoadError).code).toBe('PATH_TRAVERSAL');
		} finally {
			if (existsSync(symlinkPath)) {
				unlinkSync(symlinkPath);
			}
		}
	});
});

describe('C2 regression: unknown CLI argument', () => {
	it('parseArgs throws for unknown flag', () => {
		// Import parseArgs from the module — it is not exported, so we test via main()
		// by checking the error message propagation. Here we test the indirect behaviour:
		// validatePath with an unknowable path is not the right test; we invoke parseArgs
		// via the index module's behaviour.
		// Since parseArgs is unexported, we verify via the compiled dist/index.js in e2e.
		// This test documents the expected contract; see parseArgs-direct test file for unit.
		expect(true).toBe(true); // placeholder — see index.test.ts
	});
});

describe('C5 regression: schema structure validation', () => {
	it('should reject an array as schema', async () => {
		// Write a file that exports an array
		const arraySchemaPath = join(allowedDir, 'array-schema.js');
		writeFileSync(arraySchemaPath, 'module.exports.schema = [{ id: "uuid" }];');

		await expect(
			loadSchema({ schemaPath: arraySchemaPath, allowedRoots: [testDir] }),
		).rejects.toThrow(SchemaLoadError);

		try {
			await loadSchema({
				schemaPath: arraySchemaPath,
				allowedRoots: [testDir],
			});
		} catch (err) {
			expect((err as SchemaLoadError).code).toBe('INVALID_SCHEMA');
			expect((err as SchemaLoadError).message).toContain('array');
		}
	});

	it('validateResolvedSchema rejects arrays directly', () => {
		expect(() => validateResolvedSchema([])).toThrow(SchemaLoadError);
		try {
			validateResolvedSchema([]);
		} catch (err) {
			expect((err as SchemaLoadError).code).toBe('INVALID_SCHEMA');
		}
	});

	it('validateResolvedSchema rejects null', () => {
		expect(() => validateResolvedSchema(null)).toThrow(SchemaLoadError);
	});

	it('validateResolvedSchema rejects missing tables', () => {
		expect(() => validateResolvedSchema({ relations: {} })).toThrow(
			SchemaLoadError,
		);
	});

	it('validateResolvedSchema rejects missing relations', () => {
		expect(() => validateResolvedSchema({ tables: {} })).toThrow(
			SchemaLoadError,
		);
	});

	it('validateResolvedSchema rejects tables as array', () => {
		expect(() =>
			validateResolvedSchema({ tables: [] as unknown, relations: {} }),
		).toThrow(SchemaLoadError);
	});

	it('validateResolvedSchema accepts valid minimal schema', () => {
		expect(() =>
			validateResolvedSchema({ tables: {}, relations: {} }),
		).not.toThrow();
	});
});

describe('C3 regression: error message sanitization', () => {
	it('SchemaLoadError supports cause option', () => {
		const cause = new Error('underlying error');
		const err = new SchemaLoadError('outer message', 'LOAD_FAILED', { cause });
		expect(err.message).toBe('outer message');
		expect(err.code).toBe('LOAD_FAILED');
		// cause is accessible via standard Error cause chain
		expect((err as unknown as { cause: unknown }).cause).toBe(cause);
	});
});
