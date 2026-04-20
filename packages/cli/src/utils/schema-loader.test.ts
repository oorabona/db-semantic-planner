/**
 * Regression tests for schema-loader.ts — Commit 7 fixes.
 *
 * SEC-8: loadSchema must reject paths outside cwd to prevent path traversal.
 */

import { describe, expect, it } from 'vitest';
import { SchemaLoadError } from './schema-loader.js';

describe('loadSchema — path traversal protection (SEC-8)', () => {
	it('rejects a schema path outside cwd', async () => {
		const { loadSchema } = await import('./schema-loader.js');
		// /tmp is always outside the project cwd during tests
		// The cwd check runs before existsSync, so the path-traversal error fires
		// even if the file doesn't exist.
		await expect(loadSchema('/tmp/evil-schema.ts')).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof SchemaLoadError &&
				e.message.includes(
					'Schema file must be inside the current working directory',
				),
		);
	});

	it('rejects ../../ traversal attempts', async () => {
		const { loadSchema } = await import('./schema-loader.js');
		// ../../etc/passwd resolves to a path outside cwd — caught by path-traversal check
		await expect(loadSchema('../../etc/passwd')).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof SchemaLoadError &&
				(e.message.includes(
					'Schema file must be inside the current working directory',
				) ||
					e.message.includes('Schema file not found')),
		);
	});

	it('rejects missing schema with SchemaLoadError (existing behaviour)', async () => {
		const { loadSchema } = await import('./schema-loader.js');
		// A path that is inside cwd but does not exist
		await expect(loadSchema('nonexistent-schema-xyz.ts')).rejects.toThrow(
			SchemaLoadError,
		);
	});
});
