// @ts-nocheck — coverage test
/**
 * Coverage tests for ddl-executor.ts — targets uncovered branches.
 *
 * Branches covered:
 * - branch 3[1]: catch block when client is undefined (pool.connect fails)
 * - branch 4[1]: finally block when client is undefined (pool.connect fails)
 */

import { describe, expect, it, vi } from 'vitest';
import { executeDdl } from './ddl-executor.js';

describe('executeDdl coverage', () => {
	it('should propagate error when pool.connect() fails (no client to rollback)', async () => {
		const pool = {
			connect: vi.fn().mockRejectedValue(new Error('connection refused')),
		};

		await expect(
			executeDdl(pool as never, ['CREATE TABLE "t" ("id" int)']),
		).rejects.toThrow('connection refused');

		// connect was called but no client was acquired, so no rollback/release
		expect(pool.connect).toHaveBeenCalledOnce();
	});
});
