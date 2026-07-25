import { describe, expect, it, vi } from 'vitest';

const { handleSchemaApply } = await import('./schema-apply-handler.js');

// ── Mock pool/client ────────────────────────────────────────

function createMockClient() {
	return {
		_txStatus: 'I' as const,
		query: vi.fn().mockResolvedValue({ rows: [] }),
		release: vi.fn(),
	};
}

function createMockPool(client = createMockClient()) {
	return {
		connect: vi.fn().mockResolvedValue(client),
	};
}

describe('handleSchemaApply', () => {
	it('should return success with an empty phased plan', async () => {
		const pool = createMockPool();
		const result = await handleSchemaApply(
			{ connectionId: 'c1', autocommit: [], main: [] },
			() => pool as never,
		);
		expect(result).toEqual({ applied: 0, success: true });
		expect(pool.connect).not.toHaveBeenCalled();
	});

	it('executes autocommit and main phases separately', async () => {
		const client = createMockClient();
		const pool = createMockPool(client);
		const main = [
			'ALTER TABLE "users" ADD COLUMN "email" text;',
			'CREATE INDEX "idx_users_email" ON "users" ("email");',
		];

		const result = await handleSchemaApply(
			{
				connectionId: 'c1',
				autocommit: [
					'ALTER TYPE "status" ADD VALUE IF NOT EXISTS \'pending\';',
				],
				main,
			},
			() => pool as never,
		);

		expect(result).toEqual({ applied: 3, success: true });
		expect(client.query).toHaveBeenNthCalledWith(
			1,
			'ALTER TYPE "status" ADD VALUE IF NOT EXISTS \'pending\';',
		);
		expect(client.query).toHaveBeenCalledWith('BEGIN');
		expect(client.query).toHaveBeenCalledWith(main[0]);
		expect(client.query).toHaveBeenCalledWith(main[1]);
		expect(client.query).toHaveBeenCalledWith('COMMIT');
		expect(client.release).toHaveBeenCalledOnce();
	});

	it('should rollback and return error on failure', async () => {
		const client = createMockClient();
		let callCount = 0;
		client.query.mockImplementation(() => {
			callCount++;
			if (callCount === 2) {
				// First actual SQL statement (after BEGIN)
				return Promise.reject(new Error('column "email" already exists'));
			}
			return Promise.resolve({ rows: [] });
		});
		const pool = createMockPool(client);

		const result = await handleSchemaApply(
			{
				connectionId: 'c1',
				autocommit: [],
				main: ['ALTER TABLE "users" ADD COLUMN "email" text;'],
			},
			() => pool as never,
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('column "email" already exists');
		expect(client.query).toHaveBeenCalledWith('ROLLBACK');
		expect(client.release).toHaveBeenCalledOnce();
	});

	it('should release client even if rollback fails', async () => {
		const client = createMockClient();
		let callCount = 0;
		client.query.mockImplementation(() => {
			callCount++;
			if (callCount === 2) return Promise.reject(new Error('syntax error'));
			if (callCount === 3) return Promise.reject(new Error('rollback failed'));
			return Promise.resolve({ rows: [] });
		});
		const pool = createMockPool(client);

		const result = await handleSchemaApply(
			{ connectionId: 'c1', autocommit: [], main: ['BAD SQL;'] },
			() => pool as never,
		);

		expect(result.success).toBe(false);
		expect(client.release).toHaveBeenCalledOnce();
	});

	it('rejects non-canonical autocommit SQL instead of trusting renderer phase labels', async () => {
		const client = createMockClient();
		const result = await handleSchemaApply(
			{
				connectionId: 'c1',
				autocommit: ['DROP TABLE "users";'],
				main: [],
			},
			() => createMockPool(client) as never,
		);

		expect(result).toMatchObject({ applied: 0, success: false });
		expect(result.error).toContain('Invalid enum sidecar');
		expect(client.query).not.toHaveBeenCalled();
	});

	it('reports durable autocommit work when the main phase fails', async () => {
		const client = createMockClient();
		client.query
			.mockResolvedValueOnce({ rows: [] }) // autocommit
			.mockResolvedValueOnce({ rows: [] }) // BEGIN
			.mockRejectedValueOnce(new Error('main failure')) // main SQL
			.mockResolvedValueOnce({ rows: [] }); // ROLLBACK
		const result = await handleSchemaApply(
			{
				connectionId: 'c1',
				autocommit: [
					'ALTER TYPE "status" ADD VALUE IF NOT EXISTS \'pending\';',
				],
				main: ['ALTER TABLE "jobs" ADD COLUMN "status" text;'],
			},
			() => createMockPool(client) as never,
		);

		expect(result).toMatchObject({
			applied: 1,
			success: false,
			partial: true,
			error: 'main failure',
		});
	});
});
