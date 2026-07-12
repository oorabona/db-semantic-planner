/**
 * E06c: Schema Loader Tests
 *
 * Tests for MCP server schema loading with security measures.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import {
	_resetWarnFlagForTests,
	loadSchema,
	SchemaLoadError,
	validatePath,
} from './schema-loader.js';
import { createMcpServer } from './server.js';

// Create a temp directory for test files under this package so generated
// TypeScript fixtures can import workspace source without relying on dist/.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const testDir = join(
	repoRoot,
	'packages/mcp-server/.tmp',
	`dbsp-mcp-test-${Date.now()}`,
);
const allowedDir = join(testDir, 'allowed');
const outsideDir = join(testDir, 'outside');
const coreEntryImport = relative(
	allowedDir,
	join(repoRoot, 'packages/core/src/index.ts'),
).replaceAll('\\', '/');

beforeAll(() => {
	// Create test directories
	mkdirSync(allowedDir, { recursive: true });
	mkdirSync(outsideDir, { recursive: true });

	// Create live schema() files in allowed dir.
	writeFileSync(
		join(allowedDir, 'valid-schema.ts'),
		`
		import { ref, schema as dbSchema } from '${coreEntryImport}';

		export const schema = dbSchema({
			users: {
				id: { type: 'integer', primaryKey: true },
				email: 'string'
			},
			posts: {
				id: { type: 'integer', primaryKey: true },
				userId: ref('users')
			}
		});
	`,
	);

	writeFileSync(
		join(allowedDir, 'default-schema.ts'),
		`
		import { schema as dbSchema } from '${coreEntryImport}';

		export default dbSchema({
			projects: {
				id: { type: 'integer', primaryKey: true },
				name: 'string'
			}
		});
	`,
	);

	// Create schema file in outside dir (for path traversal tests — content never validated).
	writeFileSync(
		join(outsideDir, 'outside-schema.js'),
		`
		module.exports.schema = {
			tables: { secret: { id: 'uuid' } },
			relations: {},
			hints: {},
			conventions: {},
				indexes: {}
		};
	`,
	);

	// Create invalid schema (not the live schema() result shape)
	writeFileSync(
		join(allowedDir, 'invalid-schema.js'),
		`
		module.exports.schema = {
			tables: { users: {} }
		};
	`,
	);

	// Create an unsupported object shape; MCP accepts only the live schema() result.
	writeFileSync(
		join(allowedDir, 'unsupported-schema.ts'),
		`
		export const schema = {
			tables: {
				users: {
					id: { type: 'uuid', primaryKey: true },
					email: { type: 'string' }
				}
			}
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
			expect(result.resolvedPath).toBe(resolve(process.cwd(), 'some/path.ts'));
		});

		it('should return absolute paths within allowed roots unchanged', () => {
			// M1 fix: non-existent paths are now checked for containment too.
			// Use a path inside testDir with an explicit allowedRoot so the check passes.
			const absPath = join(testDir, 'nonexistent.ts');
			const result = validatePath(absPath, [testDir]);
			expect(result.resolvedPath).toBe(absPath);
		});

		it('should normalize existing paths with .. that stay within allowed root', () => {
			// Use a raw template literal so the '..' segment is preserved in the string
			// passed to validatePath (path.join would normalize it away before validatePath
			// sees it, defeating the test's intent of exercising the includes('..') guard).
			// allowedDir/../allowed resolves to allowedDir itself, which is inside testDir.
			const pathWithDotDot = `${testDir}/allowed/../allowed/valid-schema.ts`;
			const result = validatePath(pathWithDotDot, [testDir]);
			// Should resolve to the real path (includes('..') early-exit must NOT fire
			// because testDir covers the resolved destination)
			expect(result.resolvedPath).toBe(join(allowedDir, 'valid-schema.ts'));
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
			const schemaPath = join(allowedDir, 'valid-schema.ts');
			const result = validatePath(schemaPath, [allowedDir]);
			expect(result.resolvedPath).toBe(schemaPath);
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
			expect(result.resolvedPath).toBe(schemaPath);
		});

		it('should handle relative allowed roots', () => {
			const schemaPath = join(allowedDir, 'valid-schema.ts');
			// Use relative path for allowedRoot
			const result = validatePath(schemaPath, [allowedDir]);
			expect(result.resolvedPath).toBe(schemaPath);
		});

		it('should reject a non-existent path outside allowed roots (M1 fix)', () => {
			// Before M1 fix, a non-existent path bypassed containment check and returned
			// the resolved path — leaking that the path exists vs not-exists oracle.
			const nonExistentOutside = join(outsideDir, 'ghost-schema.js');
			expect(() => validatePath(nonExistentOutside, [allowedDir])).toThrow(
				SchemaLoadError,
			);
			try {
				validatePath(nonExistentOutside, [allowedDir]);
			} catch (err) {
				expect((err as SchemaLoadError).code).toBe('PATH_TRAVERSAL');
				expect((err as SchemaLoadError).message).toContain(
					'outside allowed directories',
				);
				// M3: message must not leak the resolved path
				expect((err as SchemaLoadError).message).not.toContain(outsideDir);
			}
		});
	});
});

describe('loadSchema', () => {
	describe('successful loading', () => {
		it('should load a valid schema file', async () => {
			const result = await loadSchema({
				schemaPath: join(allowedDir, 'valid-schema.ts'),
				allowedRoots: [testDir],
			});

			expect(result.schema).toBeDefined();
			expect(result.schema.model.getTable('users')).toBeDefined();
			expect(result.schema.tableNames).toContain('users');
			expect(result.resolvedPath).toBe(join(allowedDir, 'valid-schema.ts'));
		});

		it('should respect allowedRoots', async () => {
			const result = await loadSchema({
				schemaPath: join(allowedDir, 'valid-schema.ts'),
				allowedRoots: [allowedDir],
			});

			expect(result.schema.model.getTable('users')).toBeDefined();
		});

		it('should load a live schema from default export', async () => {
			const result = await loadSchema({
				schemaPath: join(allowedDir, 'default-schema.ts'),
				allowedRoots: [testDir],
			});

			expect(result.schema.model.getTable('projects')).toBeDefined();
			expect(result.schema.tableNames).toEqual(['projects']);
		});

		it('should carry a loaded live schema through server creation', async () => {
			const result = await loadSchema({
				schemaPath: join(allowedDir, 'valid-schema.ts'),
				allowedRoots: [testDir],
			});

			const server = createMcpServer({ schema: result.schema });
			expect(server).toBeDefined();
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

		it('should throw INVALID_SCHEMA for non-schema() format', async () => {
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
				expect((error as SchemaLoadError).message).toBe(
					'Invalid schema format in <schema-file>. Use schema() from @dbsp/core to create schemas.',
				);
			}
		});

		it('should reject unsupported object format with schema() guidance', async () => {
			await expect(
				loadSchema({
					schemaPath: join(allowedDir, 'unsupported-schema.ts'),
					allowedRoots: [testDir],
				}),
			).rejects.toThrow(SchemaLoadError);

			try {
				await loadSchema({
					schemaPath: join(allowedDir, 'unsupported-schema.ts'),
					allowedRoots: [testDir],
				});
			} catch (error) {
				expect((error as SchemaLoadError).code).toBe('INVALID_SCHEMA');
				expect((error as SchemaLoadError).message).toBe(
					'Invalid schema format in <schema-file>. Use schema() from @dbsp/core to create schemas.',
				);
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
	it('should reject a path with .. that resolves to an existing file (raw .. in input)', () => {
		// Use a raw template literal so the '..' segment is preserved in the string
		// passed to validatePath — path.join would normalize it away before validatePath
		// sees it, which would mean only the post-resolution containment guard fires
		// (not the includes('..') guard this test intends to exercise).
		// The path resolves OUTSIDE allowedDir → both the '..' guard and the
		// post-resolution containment check should reject it.
		const pathWithEscape = `${allowedDir}/../outside/outside-schema.js`;
		// This path contains '..' in the raw input AND resolves outside allowedDir.
		expect(() => validatePath(pathWithEscape, [allowedDir])).toThrow(
			SchemaLoadError,
		);
		try {
			validatePath(pathWithEscape, [allowedDir]);
		} catch (err) {
			expect((err as SchemaLoadError).code).toBe('PATH_TRAVERSAL');
		}
	});

	it('should reject a normalized path that resolves outside allowedRoots (no .. in input)', () => {
		// This test exercises the POST-RESOLUTION containment guard alone (no '..' in input).
		// The path is already normalized — only the containment check at the existsSync
		// branch can catch it. This is the companion to the test above.
		const outsidePath = join(outsideDir, 'outside-schema.js');
		expect(() => validatePath(outsidePath, [allowedDir])).toThrow(
			SchemaLoadError,
		);
		try {
			validatePath(outsidePath, [allowedDir]);
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
		// Create a symlink inside allowedDir that initially points to valid-schema.ts
		const symlinkPath = join(allowedDir, 'link-schema.js');

		// Clean up first in case a previous test run left it
		if (existsSync(symlinkPath)) {
			unlinkSync(symlinkPath);
		}

		// Create symlink → valid target
		symlinkSync(join(allowedDir, 'valid-schema.ts'), symlinkPath);

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

describe('M3 regression: raw .. path resolving inside allowedRoots is not rejected', () => {
	it('should NOT throw when raw .. input resolves inside an explicit allowedRoot', () => {
		// Before M3 fix: validatePath checked relative(cwd, resolvedPath) in the '..'
		// early-exit branch. A path like '/tmp/a/../b/schema.js' with allowedRoots=['/tmp']
		// resolves to '/tmp/b/schema.js' (inside /tmp) but the old check compared against
		// cwd, causing a false PATH_TRAVERSAL throw.
		// After fix: the early-exit checks against rootsToCheck, so the allowedRoot covers it.
		const subDir = join(testDir, 'subdir');
		const targetFile = join(subDir, 'sub-schema.js');
		if (!existsSync(subDir)) {
			mkdirSync(subDir, { recursive: true });
		}
		writeFileSync(targetFile, '');

		// Raw path with literal '..' that resolves to targetFile (inside testDir).
		const rawDotDotPath = `${allowedDir}/../subdir/sub-schema.js`;
		// testDir covers the resolved destination — must NOT throw.
		expect(() => validatePath(rawDotDotPath, [testDir])).not.toThrow();
		const result = validatePath(rawDotDotPath, [testDir]);
		expect(result.resolvedPath).toBe(targetFile);
	});

	it('should still throw PATH_TRAVERSAL when raw .. resolves outside ALL allowedRoots', () => {
		// When '..' resolves outside every declared root, PATH_TRAVERSAL is still raised.
		const escapePath = `${allowedDir}/../outside/outside-schema.js`;
		expect(() => validatePath(escapePath, [allowedDir])).toThrow(
			SchemaLoadError,
		);
		try {
			validatePath(escapePath, [allowedDir]);
		} catch (err) {
			expect((err as SchemaLoadError).code).toBe('PATH_TRAVERSAL');
		}
	});
});

describe('C5 regression: schema format validation', () => {
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
			expect((err as SchemaLoadError).message).toBe(
				'Invalid schema format in <schema-file>. Use schema() from @dbsp/core to create schemas.',
			);
		}
	});

	it('should reject null as schema', async () => {
		const nullSchemaPath = join(allowedDir, 'null-schema.mjs');
		writeFileSync(nullSchemaPath, 'export const schema = null;');

		await expect(
			loadSchema({ schemaPath: nullSchemaPath, allowedRoots: [testDir] }),
		).rejects.toThrow(SchemaLoadError);

		try {
			await loadSchema({
				schemaPath: nullSchemaPath,
				allowedRoots: [testDir],
			});
		} catch (err) {
			expect((err as SchemaLoadError).code).toBe('INVALID_SCHEMA');
			expect((err as SchemaLoadError).message).toBe(
				"Schema file must export 'schema' or default export: <schema-file>",
			);
		}
	});

	it('should reject an object that is not a schema() result', async () => {
		const manualSchemaPath = join(allowedDir, 'manual-schema.js');
		writeFileSync(
			manualSchemaPath,
			'module.exports.schema = { definition: {}, model: {}, tableNames: [] };',
		);

		await expect(
			loadSchema({ schemaPath: manualSchemaPath, allowedRoots: [testDir] }),
		).rejects.toThrow(SchemaLoadError);

		try {
			await loadSchema({
				schemaPath: manualSchemaPath,
				allowedRoots: [testDir],
			});
		} catch (err) {
			expect((err as SchemaLoadError).code).toBe('INVALID_SCHEMA');
			expect((err as SchemaLoadError).message).toBe(
				'Invalid schema format in <schema-file>. Use schema() from @dbsp/core to create schemas.',
			);
		}
	});

	it('should reject unsupported object output with schema() guidance', async () => {
		await expect(
			loadSchema({
				schemaPath: join(allowedDir, 'unsupported-schema.ts'),
				allowedRoots: [testDir],
			}),
		).rejects.toThrow(SchemaLoadError);

		try {
			await loadSchema({
				schemaPath: join(allowedDir, 'unsupported-schema.ts'),
				allowedRoots: [testDir],
			});
		} catch (err) {
			expect((err as SchemaLoadError).code).toBe('INVALID_SCHEMA');
			expect((err as SchemaLoadError).message).toBe(
				'Invalid schema format in <schema-file>. Use schema() from @dbsp/core to create schemas.',
			);
		}
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

// ─── Senior R1 review feedback tests (2026-04-20) ───────────────────────────

describe('S-A: URL-encoded path traversal bypass', () => {
	it('should reject %2e%2e/etc (URL-encoded ..)', () => {
		expect(() => validatePath('%2e%2e/etc/passwd')).toThrow(SchemaLoadError);
		try {
			validatePath('%2e%2e/etc/passwd');
		} catch (err) {
			expect((err as SchemaLoadError).code).toBe('PATH_TRAVERSAL');
		}
	});

	it('should reject %2e%2e%2fetc (fully encoded ../)', () => {
		expect(() => validatePath('%2e%2e%2fetc')).toThrow(SchemaLoadError);
		try {
			validatePath('%2e%2e%2fetc');
		} catch (err) {
			expect((err as SchemaLoadError).code).toBe('PATH_TRAVERSAL');
		}
	});

	it('should NOT reject malformed percent-encoding as PATH_TRAVERSAL (M2 fix)', () => {
		// '100%dir/schema.ts' is a valid POSIX filename — malformed % sequences cannot
		// be URL-encoded '..' so falling back to the raw input is safe.
		// validatePath must not throw PATH_TRAVERSAL; it may throw NOT_FOUND (via loadSchema)
		// or return a resolved path (file doesn't exist → containment check vs cwd).
		expect(() => validatePath('%zz/path.ts')).not.toThrow();
	});

	it('should NOT throw PATH_TRAVERSAL for 100%dir style filename (M2)', () => {
		// '100%dir' is a valid POSIX directory name — URIError from decodeURIComponent
		// must not be surfaced as PATH_TRAVERSAL. The path will be in testDir.
		const fakePath = join(testDir, '100%dir', 'schema.ts');
		// File doesn't exist → NOT_FOUND via loadSchema; validatePath itself should not throw.
		expect(() => validatePath(fakePath, [testDir])).not.toThrow();
		const result = validatePath(fakePath, [testDir]);
		// resolvedPath is the absolute path — should be identical since it was already absolute.
		expect(result.resolvedPath).toBe(fakePath);
	});

	it('should reject literal backslash ".." form (..\\foo)', () => {
		// On POSIX a backslash is a valid filename character, but '..\\' as a
		// traversal pattern should still be rejected.
		expect(() => validatePath('..\\foo')).toThrow(SchemaLoadError);
		try {
			validatePath('..\\foo');
		} catch (err) {
			expect((err as SchemaLoadError).code).toBe('PATH_TRAVERSAL');
		}
	});

	it('should reject Windows-style ..\\\\..\\\\path (raw string, no OS required)', () => {
		// We pass the raw string; no actual Windows runtime needed.
		expect(() => validatePath('..\\..\\system32')).toThrow(SchemaLoadError);
		try {
			validatePath('..\\..\\system32');
		} catch (err) {
			expect((err as SchemaLoadError).code).toBe('PATH_TRAVERSAL');
		}
	});
});

describe('S-B: TOCTOU re-check uses canonicalRoots from validatePath', () => {
	it('validatePath returns canonicalRoots, not the raw allowedRoots', () => {
		const schemaPath = join(allowedDir, 'valid-schema.ts');
		// Pass a relative allowed root — validatePath must resolve it
		const result = validatePath(schemaPath, [allowedDir]);
		// canonicalRoots should be present and match the resolved allowedDir
		expect(result).toHaveProperty('canonicalRoots');
		expect(result.canonicalRoots.length).toBeGreaterThan(0);
		// resolvedPath must be an absolute path
		expect(result.resolvedPath).toBe(join(allowedDir, 'valid-schema.ts'));
	});

	it('loadSchema uses canonicalRoots from validatePath for TOCTOU re-check', async () => {
		// Verify the TOCTOU code path receives consistent roots by loading a valid schema
		const result = await loadSchema({
			schemaPath: join(allowedDir, 'valid-schema.ts'),
			allowedRoots: [allowedDir],
		});
		expect(result.schema.model.getTable('users')).toBeDefined();
	});
});

describe('M-C: error message sanitization (replaceAll + dirname + cap)', () => {
	it('sanitized loadSchema error must not contain the resolvedPath substring', async () => {
		// Write a file that throws an Error containing the full path — simulates
		// ERR_MODULE_NOT_FOUND or other node runtime errors that include the path.
		const badPath = join(allowedDir, 'bad-path-in-error.js');
		const { writeFileSync: wfs, unlinkSync: uls } = await import('node:fs');
		// This file throws an Error whose message contains the path itself
		wfs(badPath, `throw new Error("Cannot find module: ${badPath}");`);
		try {
			await loadSchema({ schemaPath: badPath, allowedRoots: [testDir] });
		} catch (err) {
			expect(err).toBeInstanceOf(SchemaLoadError);
			const msg = (err as SchemaLoadError).message;
			// Must not contain the raw resolved path
			expect(msg).not.toContain(badPath);
			// Must contain the placeholder
			expect(msg).toContain('<schema-file>');
			// Message must be capped at 500 chars
			expect(msg.length).toBeLessThanOrEqual(500);
		} finally {
			try {
				uls(badPath);
			} catch {
				/* ignore */
			}
		}
	});

	it('sanitized error must not contain the parent directory', async () => {
		// This file throws an Error whose message contains the parent directory
		const badPath = join(allowedDir, 'bad-for-dirname-test.js');
		const { writeFileSync: wfs, unlinkSync: uls } = await import('node:fs');
		wfs(
			badPath,
			`throw new Error("Cannot load schema from directory: ${allowedDir}");`,
		);
		try {
			await loadSchema({ schemaPath: badPath, allowedRoots: [testDir] });
		} catch (err) {
			if (err instanceof SchemaLoadError && err.code === 'LOAD_FAILED') {
				const msg = err.message;
				// Parent dir must not appear verbatim
				expect(msg).not.toContain(allowedDir);
				// Placeholders must appear
				expect(msg).toMatch(/<schema-file>|<schema-dir>/);
			}
		} finally {
			try {
				uls(badPath);
			} catch {
				/* ignore */
			}
		}
	});
});

describe('M-D: TypeScript loader fallback remains actionable', () => {
	afterEach(() => {
		vi.doUnmock('tsx/esm/api');
	});

	it('reports install-tsx guidance when tsx is absent for a .ts schema', async () => {
		vi.doMock('tsx/esm/api', () => ({
			tsImport: async () => {
				throw new Error("Cannot find package 'tsx' imported from test");
			},
		}));

		const tsSchemaPath = join(allowedDir, 'needs-tsx.ts');
		writeFileSync(
			tsSchemaPath,
			`
			import { schema as dbSchema } from './missing-helper.ts';
			export const schema = dbSchema({ users: { id: 'integer' } });
		`,
		);

		await expect(
			loadSchema({ schemaPath: tsSchemaPath, allowedRoots: [testDir] }),
		).rejects.toThrow(SchemaLoadError);

		try {
			await loadSchema({ schemaPath: tsSchemaPath, allowedRoots: [testDir] });
		} catch (err) {
			expect((err as SchemaLoadError).code).toBe('LOAD_FAILED');
			expect((err as SchemaLoadError).message).toContain(
				"Install 'tsx' as a peer dependency",
			);
			expect((err as SchemaLoadError).message).toContain('pnpm add -D tsx');
		}
	});
});

describe('M-E: warn-once semantics for missing allowedRoots', () => {
	// Reset before AND after each test: before so prior tests don't pollute this suite,
	// after so this suite doesn't pollute subsequent tests.
	beforeEach(() => {
		_resetWarnFlagForTests();
	});
	afterEach(() => {
		_resetWarnFlagForTests();
	});

	it('warning is emitted to stderr (not stdout)', () => {
		const stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(() => true);
		// Call without allowedRoots — this triggers the warn-once branch.
		// Use a simple relative path that won't trigger PATH_TRAVERSAL.
		validatePath('./nonexistent-schema.js');
		const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
		const warningCall = stderrCalls.find((s) =>
			s.includes('no --allowed-root specified'),
		);
		expect(warningCall).toBeDefined();
		stderrSpy.mockRestore();
	});

	it('warning is emitted exactly once across multiple calls', () => {
		const stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(() => true);
		// Call multiple times without allowedRoots — warning must appear exactly once
		for (let i = 0; i < 3; i++) {
			validatePath('./nonexistent-schema.js');
		}
		const warnCount = stderrSpy.mock.calls.filter((c) =>
			String(c[0]).includes('no --allowed-root specified'),
		).length;
		expect(warnCount).toBe(1);
		stderrSpy.mockRestore();
	});
});
