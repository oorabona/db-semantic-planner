import { describe, expect, it, vi } from 'vitest';

const { handleSchemaApply } = await import('./schema-apply-handler.js');

// ── Mock pool/client ────────────────────────────────────────

function createMockClient() {
	return {
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
	it('should return success with 0 applied for empty statements', async () => {
		const pool = createMockPool();
		const result = await handleSchemaApply(
			{ connectionId: 'c1', statements: [] },
			() => pool as never,
		);
		expect(result).toEqual({ applied: 0, success: true });
		expect(pool.connect).not.toHaveBeenCalled();
	});

	it('should execute statements within a transaction', async () => {
		const client = createMockClient();
		const pool = createMockPool(client);
		const statements = [
			'ALTER TABLE "users" ADD COLUMN "email" text;',
			'CREATE INDEX "idx_users_email" ON "users" ("email");',
		];

		const result = await handleSchemaApply(
			{ connectionId: 'c1', statements },
			() => pool as never,
		);

		expect(result).toEqual({ applied: 2, success: true });
		expect(client.query).toHaveBeenCalledWith('BEGIN');
		expect(client.query).toHaveBeenCalledWith(statements[0]);
		expect(client.query).toHaveBeenCalledWith(statements[1]);
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
				statements: ['ALTER TABLE "users" ADD COLUMN "email" text;'],
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
			{ connectionId: 'c1', statements: ['BAD SQL;'] },
			() => pool as never,
		);

		expect(result.success).toBe(false);
		expect(client.release).toHaveBeenCalledOnce();
	});
});
