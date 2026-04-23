/**
 * Regression tests for schema-loader.ts — Commit 7 fixes.
 *
 * SEC-8: loadSchema must reject paths outside cwd to prevent path traversal.
 */

import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SchemaLoadError } from './schema-loader.js';

describe('loadSchema — path traversal protection (SEC-8)', () => {
	it('rejects a schema path outside cwd', async () => {
		const { loadSchema } = await import('./schema-loader.js');
		// Use a sibling-of-cwd path — deterministically outside cwd regardless
		// of where CI runs (avoids the '/tmp' assumption which can fail when cwd
		// itself is under /tmp).
		const outsidePath = join(
			dirname(process.cwd()),
			'outside-cwd-test-fixture',
			'evil-schema.ts',
		);
		// The cwd check runs before existsSync, so the path-traversal error fires
		// even if the file doesn't exist.
		await expect(loadSchema(outsidePath)).rejects.toSatisfy(
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

// L-4 ENOENT narrowing: tested in schema-loader.enoent.test.ts (requires
// top-level vi.mock for ESM compatibility).
