import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for connection-manager.ts logic.
 * We mock `pg` and `@dbsp/adapter-pgsql` since these are unit tests.
 */

// Mock pg Pool
const mockQuery = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
const mockRelease = vi.fn();
const mockConnect = vi
	.fn()
	.mockResolvedValue({ query: mockQuery, release: mockRelease });
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock('pg', () => ({
	// biome-ignore lint/complexity/useArrowFunction: regular function required for `new Pool()` constructor
	Pool: vi.fn(function () {
		return { connect: mockConnect, end: mockEnd };
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
} = await import('./connection-manager.js');

const baseParams = {
	host: 'localhost',
	port: 5432,
	database: 'testdb',
	user: 'testuser',
	password: 'secret',
};

beforeEach(() => {
	vi.clearAllMocks();
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

describe('connect', () => {
	it('returns connectionId, database, and schema', async () => {
		const result = await connect(baseParams);
		expect(result.connectionId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(result.database).toBe('testdb');
		expect(result.schema).toBe('public');
	});

	it('uses custom schema when provided', async () => {
		const result = await connect({ ...baseParams, schema: 'tenant_1' });
		expect(result.schema).toBe('tenant_1');
	});

	it('tests connection with SELECT 1', async () => {
		await connect(baseParams);
		expect(mockConnect).toHaveBeenCalled();
		expect(mockQuery).toHaveBeenCalledWith('SELECT 1');
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
