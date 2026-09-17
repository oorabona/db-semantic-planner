import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for connection-manager.ts logic.
 * We mock `pg` and `@dbsp/adapter-pgsql` since these are unit tests.
 */

// Mock pg Pool
const mockQuery = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
const mockPoolQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockRelease = vi.fn();
const mockConnect = vi
	.fn()
	.mockResolvedValue({ query: mockQuery, release: mockRelease });
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock('pg', () => ({
	// biome-ignore lint/complexity/useArrowFunction: regular function required for `new Pool()` constructor
	Pool: vi.fn(function () {
		return { connect: mockConnect, query: mockPoolQuery, end: mockEnd };
	}),
}));

// Mock introspect
vi.mock('@dbsp/adapter-pgsql', () => ({
	introspect: vi.fn().mockResolvedValue({ tables: {}, enums: {} }),
}));

// Import AFTER mocks
const {
	connect,
	disconnect,
	disconnectAll,
	getConnectionInfo,
	getPool,
	introspectConnection,
	isConnected,
	listDatabases,
	listSchemas,
} = await import('./connection-manager.js');

const baseParams = {
	host: 'localhost',
	port: 5432,
	database: 'testdb',
	user: 'testuser',
	password: 'secret',
};

const fallbackOperations: ReadonlyArray<
	readonly [string, () => Promise<unknown>]
> = [
	['connect', () => connect(baseParams)],
	[
		'listDatabases',
		() =>
			listDatabases({
				host: baseParams.host,
				port: baseParams.port,
				user: baseParams.user,
				password: baseParams.password,
			}),
	],
	['listSchemas', () => listSchemas({ ...baseParams })],
];

const allowOperations: ReadonlyArray<
	readonly [string, () => Promise<unknown>]
> = [
	['connect', () => connect({ ...baseParams, sslMode: 'allow' })],
	[
		'listDatabases',
		() =>
			listDatabases({
				host: baseParams.host,
				port: baseParams.port,
				user: baseParams.user,
				password: baseParams.password,
				sslMode: 'allow',
			}),
	],
	['listSchemas', () => listSchemas({ ...baseParams, sslMode: 'allow' })],
];

beforeEach(async () => {
	await disconnectAll();
	vi.clearAllMocks();
	mockQuery.mockReset().mockResolvedValue({ rows: [{ '?column?': 1 }] });
	mockPoolQuery.mockReset().mockResolvedValue({ rows: [] });
	mockRelease.mockReset();
	mockConnect
		.mockReset()
		.mockResolvedValue({ query: mockQuery, release: mockRelease });
	mockEnd.mockReset().mockResolvedValue(undefined);
});

describe('sslConfig mapping', () => {
	it('connects with disable ssl', async () => {
		const { Pool } = await import('pg');
		await connect({ ...baseParams, sslMode: 'disable' });
		expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ ssl: false }));
	});

	it('connects with prefer ssl (default)', async () => {
		const { Pool } = await import('pg');
		await connect({ ...baseParams });
		expect(Pool).toHaveBeenCalledWith(
			expect.objectContaining({ ssl: { rejectUnauthorized: false } }),
		);
	});

	it('connects with verify-full ssl', async () => {
		const { Pool } = await import('pg');
		await connect({ ...baseParams, sslMode: 'verify-full' });
		expect(Pool).toHaveBeenCalledWith(
			expect.objectContaining({ ssl: { rejectUnauthorized: true } }),
		);
	});
});

describe('sslmode fallback', () => {
	const noSslError = new Error('The server does not support SSL connections');

	it.each(fallbackOperations)(
		'%s retries in plaintext only when pg reports no SSL support',
		async (operation, run) => {
			const { Pool } = await import('pg');
			mockConnect.mockRejectedValueOnce(noSslError);

			const result = await run();

			expect(Pool).toHaveBeenCalledTimes(2);
			expect(Pool).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({ ssl: { rejectUnauthorized: false } }),
			);
			expect(Pool).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({ ssl: false }),
			);
			expect(mockEnd).toHaveBeenCalled();
			expect(result).toEqual(
				expect.objectContaining({ transport: 'fallback-plaintext' }),
			);
			if (operation === 'listDatabases') {
				expect(result).toEqual(expect.objectContaining({ databases: [] }));
			} else if (operation === 'listSchemas') {
				expect(result).toEqual(expect.objectContaining({ schemas: [] }));
			}
		},
	);

	it('rethrows a non-negotiation error without a plaintext retry', async () => {
		const { Pool } = await import('pg');
		const noEncryptionError = Object.assign(new Error('no encryption'), {
			code: '28000',
		});
		mockConnect.mockRejectedValueOnce(noEncryptionError);

		await expect(connect(baseParams)).rejects.toBe(noEncryptionError);
		expect(Pool).toHaveBeenCalledTimes(1);
		expect(mockEnd).toHaveBeenCalledTimes(1);
	});

	it.each(['disable', 'require', 'verify-full'] as const)(
		'%s rethrows the no-SSL error without fallback',
		async (sslMode) => {
			const { Pool } = await import('pg');
			mockConnect.mockRejectedValueOnce(noSslError);

			await expect(connect({ ...baseParams, sslMode })).rejects.toBe(
				noSslError,
			);
			expect(Pool).toHaveBeenCalledTimes(1);
		},
	);

	it.each(allowOperations)(
		'%s refuses allow before creating a pool',
		async (_, run) => {
			const { Pool } = await import('pg');

			await expect(run()).rejects.toThrow(
				'sslmode "allow" is not supported. Choose disable, prefer, require, or verify-full.',
			);
			expect(Pool).not.toHaveBeenCalled();
		},
	);
});

describe('connect', () => {
	it('returns connectionId, database, and schema', async () => {
		const result = await connect(baseParams);
		expect(result.connectionId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(result.database).toBe('testdb');
		expect(result.schema).toBe('public');
		expect(result.transport).toBe('tls');
	});

	it('uses custom schema when provided', async () => {
		const result = await connect({ ...baseParams, schema: 'tenant_1' });
		expect(result.schema).toBe('tenant_1');
	});

	it('proves the pool can connect before testing connection with SELECT 1', async () => {
		await connect(baseParams);
		expect(mockConnect).toHaveBeenCalled();
		expect(mockQuery).toHaveBeenCalledWith('SELECT 1');
		expect(mockQuery).toHaveBeenCalledTimes(1);
		expect(mockRelease).toHaveBeenCalled();
	});

	it('releases client even when SELECT 1 fails', async () => {
		mockQuery.mockRejectedValueOnce(new Error('connection refused'));
		await expect(connect(baseParams)).rejects.toThrow('connection refused');
		expect(mockRelease).toHaveBeenCalled();
	});
});

describe('disconnect', () => {
	it('disconnects an existing connection', async () => {
		const { connectionId } = await connect(baseParams);
		await disconnect(connectionId);
		expect(mockEnd).toHaveBeenCalled();
		expect(isConnected(connectionId)).toBe(false);
	});

	it('no-ops for unknown connectionId', async () => {
		await disconnect('nonexistent-id');
		expect(mockEnd).not.toHaveBeenCalled();
	});
});

describe('getConnectionInfo', () => {
	it('returns connection metadata', async () => {
		const { connectionId } = await connect(baseParams);
		const info = getConnectionInfo(connectionId);
		expect(info).toEqual({
			database: 'testdb',
			host: 'localhost',
			port: 5432,
			user: 'testuser',
			schema: 'public',
			transport: 'tls',
		});
	});

	it('returns null for unknown connectionId', () => {
		expect(getConnectionInfo('unknown')).toBeNull();
	});
});

describe('getPool', () => {
	it('returns the pool for a valid connection', async () => {
		const { connectionId } = await connect(baseParams);
		const pool = getPool(connectionId);
		expect(pool).toBeDefined();
		expect(pool.connect).toBe(mockConnect);
	});

	it('throws for unknown connectionId', () => {
		expect(() => getPool('unknown')).toThrow('Not connected');
	});
});

describe('introspectConnection', () => {
	it('calls introspect with pool and schema', async () => {
		const { connectionId } = await connect(baseParams);
		const { introspect } = await import('@dbsp/adapter-pgsql');
		await introspectConnection(connectionId);
		expect(introspect).toHaveBeenCalledWith(expect.anything(), {
			schema: 'public',
		});
	});

	it('uses override schema when provided', async () => {
		const { connectionId } = await connect({ ...baseParams, schema: 'main' });
		const { introspect } = await import('@dbsp/adapter-pgsql');
		await introspectConnection(connectionId, 'override_schema');
		expect(introspect).toHaveBeenCalledWith(expect.anything(), {
			schema: 'override_schema',
		});
	});

	it('throws for unknown connectionId', async () => {
		await expect(introspectConnection('unknown')).rejects.toThrow(
			'Not connected',
		);
	});
});

describe('isConnected', () => {
	it('returns true for active connection', async () => {
		const { connectionId } = await connect(baseParams);
		expect(isConnected(connectionId)).toBe(true);
	});

	it('returns false for unknown id', () => {
		expect(isConnected('nope')).toBe(false);
	});
});

describe('disconnectAll', () => {
	it('disconnects all active connections', async () => {
		const c1 = await connect(baseParams);
		const c2 = await connect({ ...baseParams, database: 'db2' });
		await disconnectAll();
		expect(isConnected(c1.connectionId)).toBe(false);
		expect(isConnected(c2.connectionId)).toBe(false);
	});
});
