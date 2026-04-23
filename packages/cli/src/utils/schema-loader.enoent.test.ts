/**
 * L-4: ENOENT narrowing in the realpath symlink-check catch block.
 *
 * Non-ENOENT filesystem errors (EACCES, EPERM, ELOOP, EIO) must be re-thrown
 * so real infrastructure problems surface instead of being swallowed.
 *
 * Kept in a separate file so vi.mock hoisting works correctly with ESM.
 */

import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Top-level vi.mock is hoisted by Vitest before any imports — ESM-compatible.
vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>();
	return {
		...actual,
		realpathSync: vi.fn(actual.realpathSync),
		existsSync: vi.fn(actual.existsSync),
	};
});

describe('loadSchema — ENOENT narrowing (L-4)', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('re-throws EACCES from realpathSync (non-ENOENT must not be swallowed)', async () => {
		const fs = await import('node:fs');
		const { loadSchema } = await import('./schema-loader.js');

		const permError = Object.assign(new Error('permission denied'), {
			code: 'EACCES',
		});

		vi.mocked(fs.realpathSync).mockImplementationOnce(() => {
			throw permError;
		});

		const insidePath = join(process.cwd(), 'fake-schema.ts');
		// Must propagate the original error, NOT a SchemaLoadError or silent swallow
		await expect(loadSchema(insidePath)).rejects.toMatchObject({
			code: 'EACCES',
		});
	});

	it('does NOT re-throw ENOENT (file-not-found falls through to existsSync check)', async () => {
		const fs = await import('node:fs');
		const { loadSchema, SchemaLoadError } = await import('./schema-loader.js');

		const enoentError = Object.assign(new Error('no such file'), {
			code: 'ENOENT',
		});

		vi.mocked(fs.realpathSync).mockImplementationOnce(() => {
			throw enoentError;
		});
		// After realpathSync throws ENOENT, existsSync is called next.
		// Make it return false → SchemaLoadError("Schema file not found")
		vi.mocked(fs.existsSync).mockReturnValueOnce(false);

		const insidePath = join(process.cwd(), 'nonexistent-schema.ts');
		await expect(loadSchema(insidePath)).rejects.toThrow(SchemaLoadError);
	});
});
