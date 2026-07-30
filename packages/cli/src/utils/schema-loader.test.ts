/**
 * Regression tests for schema-loader.ts — Commit 7 fixes.
 *
 * SEC-8: loadSchema must reject paths outside cwd to prevent path traversal.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SchemaLoadError } from './schema-loader.js';

const tempDirs: string[] = [];

function writeTempSchema(source: string): string {
	const tempRoot = join(process.cwd(), '.tmp');
	mkdirSync(tempRoot, { recursive: true });
	const dir = mkdtempSync(join(tempRoot, 'schema-loader-'));
	tempDirs.push(dir);
	const schemaPath = join(dir, 'dbsp.schema.ts');
	writeFileSync(schemaPath, source, 'utf8');
	return schemaPath;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

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

	it('reads an optional dbCasing export', async () => {
		const { loadSchema } = await import('./schema-loader.js');
		const schemaPath = writeTempSchema(`
			import { schema } from '@dbsp/core';

			export const dbSchema = schema({
				users: {
					id: { type: 'integer', primaryKey: true },
					fullName: 'string',
				},
			});

			export default dbSchema;
			export const dbCasing = 'snake_case' as const;
		`);

		const loaded = await loadSchema(schemaPath);

		expect(loaded.dbCasing).toBe('snake_case');
	});

	it('leaves schemas without dbCasing export unchanged', async () => {
		const { loadSchema } = await import('./schema-loader.js');
		const schemaPath = writeTempSchema(`
			import { schema } from '@dbsp/core';

			export default schema({
				users: {
					id: { type: 'integer', primaryKey: true },
				},
			});
		`);

		const loaded = await loadSchema(schemaPath);

		expect(loaded.dbCasing).toBeUndefined();
		expect(loaded.tableNames).toEqual(['users']);
	});
});

// L-4 ENOENT narrowing: tested in schema-loader.enoent.test.ts (requires
// top-level vi.mock for ESM compatibility).
