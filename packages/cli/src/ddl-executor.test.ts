/**
 * Tests for DDL Executor — Transaction-wrapped DDL execution.
 */

import { describe, expect, it, vi } from 'vitest';
import { executeDdl } from './ddl-executor.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockClient() {
	return {
		query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
		release: vi.fn(),
	};
}

function createMockPool(client = createMockClient()) {
	return {
		connect: vi.fn().mockResolvedValue(client),
	};
}

// ============================================================================
// Tests
// ============================================================================

describe('executeDdl', () => {
	it('should return 0 statements for empty array', async () => {
		const pool = createMockPool();
		const result = await executeDdl(pool as never, []);
		expect(result).toEqual({ statementsExecuted: 0, dryRun: false });
		expect(pool.connect).not.toHaveBeenCalled();
	});

	it('should return statement count in dry-run mode without executing', async () => {
		const pool = createMockPool();
		const result = await executeDdl(
			pool as never,
			['CREATE TABLE "a" ("id" serial)', 'CREATE TABLE "b" ("id" serial)'],
			{ dryRun: true },
		);
		expect(result).toEqual({ statementsExecuted: 2, dryRun: true });
		expect(pool.connect).not.toHaveBeenCalled();
	});

	it('should execute statements in a transaction', async () => {
		const client = createMockClient();
		const pool = createMockPool(client);

		const stmts = [
			'CREATE TABLE "users" ("id" serial)',
			'CREATE TABLE "posts" ("id" serial)',
		];

		const result = await executeDdl(pool as never, stmts);

		expect(result).toEqual({ statementsExecuted: 2, dryRun: false });
		expect(client.query).toHaveBeenCalledWith('BEGIN');
		expect(client.query).toHaveBeenCalledWith(stmts[0]);
		expect(client.query).toHaveBeenCalledWith(stmts[1]);
		expect(client.query).toHaveBeenCalledWith('COMMIT');
		expect(client.release).toHaveBeenCalled();
	});

	it('should rollback on error', async () => {
		const client = createMockClient();
		client.query
			.mockResolvedValueOnce({}) // BEGIN
			.mockRejectedValueOnce(new Error('syntax error')); // first statement

		const pool = createMockPool(client);

		await expect(
			executeDdl(pool as never, ['INVALID SQL']),
		).rejects.toThrow('syntax error');

		expect(client.query).toHaveBeenCalledWith('BEGIN');
		expect(client.query).toHaveBeenCalledWith('ROLLBACK');
		expect(client.release).toHaveBeenCalled();
	});

	it('should release client even after rollback error', async () => {
		const client = createMockClient();
		client.query
			.mockResolvedValueOnce({}) // BEGIN
			.mockRejectedValueOnce(new Error('connection lost')); // first statement fails

		const pool = createMockPool(client);

		await expect(
			executeDdl(pool as never, ['CREATE TABLE "x" ("id" int)']),
		).rejects.toThrow('connection lost');

		expect(client.release).toHaveBeenCalledTimes(1);
	});

	it('should handle single statement', async () => {
		const client = createMockClient();
		const pool = createMockPool(client);

		const result = await executeDdl(pool as never, [
			'CREATE INDEX "idx" ON "users" ("name")',
		]);

		expect(result.statementsExecuted).toBe(1);
		// BEGIN + statement + COMMIT = 3 calls
		expect(client.query).toHaveBeenCalledTimes(3);
	});

	it('should return dryRun: true for empty statements with dry-run', async () => {
		const pool = createMockPool();
		const result = await executeDdl(pool as never, [], { dryRun: true });
		expect(result).toEqual({ statementsExecuted: 0, dryRun: true });
	});
});
