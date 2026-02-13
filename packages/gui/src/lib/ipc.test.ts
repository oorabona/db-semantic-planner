/**
 * Tests for typed JSON-RPC method wrappers (ipc.ts)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	createSidecarApi,
	type ConnectParams,
	type ExecuteSqlParams,
	type CompileNqlParams,
	type ExecuteNqlParams,
	type FetchMoreParams,
	type DiscoverParams,
	type ListSchemasParams,
	ipcClient,
	sidecarApi,
} from './ipc.js';

describe('createSidecarApi', () => {
	const mockCall = vi.fn();
	const mockClient = { call: mockCall } as any;
	let api: ReturnType<typeof createSidecarApi>;

	beforeEach(() => {
		mockCall.mockClear();
		api = createSidecarApi(mockClient);
	});

	describe('handshake', () => {
		it('calls client.call with correct method and params', async () => {
			const mockResponse = { version: '1.0.0', capabilities: ['sql', 'nql'] };
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.handshake('1.0.0');

			expect(mockCall).toHaveBeenCalledWith('handshake', { version: '1.0.0' });
			expect(result).toEqual(mockResponse);
		});

		it('forwards the return value', async () => {
			const expected = { version: '2.0.0', capabilities: ['advanced'] };
			mockCall.mockResolvedValue(expected);

			const result = await api.handshake('2.0.0');

			expect(result).toBe(expected);
		});
	});

	describe('connect', () => {
		it('calls client.call with correct method and params', async () => {
			const params: ConnectParams = {
				host: 'localhost',
				port: 5432,
				database: 'testdb',
				user: 'testuser',
				password: 'testpass',
				schema: 'public',
				sslMode: 'prefer',
			};
			const mockResponse = {
				connectionId: 'conn-123',
				database: 'testdb',
				schema: 'public',
			};
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.connect(params);

			expect(mockCall).toHaveBeenCalledWith('connect', params);
			expect(result).toEqual(mockResponse);
		});

		it('handles minimal params', async () => {
			const params: ConnectParams = {
				host: 'localhost',
				port: 5432,
				database: 'testdb',
				user: 'testuser',
				password: 'testpass',
			};
			const mockResponse = {
				connectionId: 'conn-456',
				database: 'testdb',
				schema: 'public',
			};
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.connect(params);

			expect(mockCall).toHaveBeenCalledWith('connect', params);
			expect(result).toEqual(mockResponse);
		});
	});

	describe('disconnect', () => {
		it('calls client.call with correct method and params', async () => {
			const mockResponse = { ok: true };
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.disconnect({ connectionId: 'conn-123' });

			expect(mockCall).toHaveBeenCalledWith('disconnect', {
				connectionId: 'conn-123',
			});
			expect(result).toEqual(mockResponse);
		});
	});

	describe('introspect', () => {
		it('calls client.call with connectionId only', async () => {
			const mockResponse = { tables: [], schemas: [] };
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.introspect('conn-123');

			expect(mockCall).toHaveBeenCalledWith('introspect', {
				connectionId: 'conn-123',
				schema: undefined,
			});
			expect(result).toEqual(mockResponse);
		});

		it('calls client.call with connectionId and schema', async () => {
			const mockResponse = { tables: ['users'] };
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.introspect('conn-123', 'public');

			expect(mockCall).toHaveBeenCalledWith('introspect', {
				connectionId: 'conn-123',
				schema: 'public',
			});
			expect(result).toEqual(mockResponse);
		});
	});

	describe('executeSQL', () => {
		it('calls client.call with correct method and params', async () => {
			const params: ExecuteSqlParams = {
				connectionId: 'conn-123',
				sql: 'SELECT * FROM users',
				params: [1, 'test'],
				maxRows: 100,
				timeoutMs: 5000,
			};
			const mockResponse = {
				rows: [[1, 'Alice']],
				columns: [
					{ name: 'id', type: 'integer' },
					{ name: 'name', type: 'text' },
				],
				rowCount: 1,
				timeMs: 42,
				truncated: false,
			};
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.executeSQL(params);

			expect(mockCall).toHaveBeenCalledWith('executeSQL', params);
			expect(result).toEqual(mockResponse);
		});

		it('handles minimal params', async () => {
			const params: ExecuteSqlParams = {
				connectionId: 'conn-123',
				sql: 'SELECT 1',
			};
			const mockResponse = {
				rows: [[1]],
				columns: [{ name: '?column?', type: 'integer' }],
				rowCount: 1,
				timeMs: 10,
				truncated: false,
			};
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.executeSQL(params);

			expect(mockCall).toHaveBeenCalledWith('executeSQL', params);
			expect(result).toEqual(mockResponse);
		});
	});

	describe('compileNQL', () => {
		it('calls client.call with correct method and params', async () => {
			const params: CompileNqlParams = {
				connectionId: 'conn-123',
				nql: 'users { id, name }',
			};
			const mockResponse = {
				sql: 'SELECT id, name FROM users',
				params: [],
				plan: { type: 'select' },
				warnings: [],
			};
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.compileNQL(params);

			expect(mockCall).toHaveBeenCalledWith('compileNQL', params);
			expect(result).toEqual(mockResponse);
		});

		it('includes warnings in result', async () => {
			const params: CompileNqlParams = {
				connectionId: 'conn-123',
				nql: 'users { * }',
			};
			const mockResponse = {
				sql: 'SELECT * FROM users',
				params: [],
				warnings: [{ code: 'W001', message: 'Avoid SELECT *' }],
			};
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.compileNQL(params);

			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]).toEqual({
				code: 'W001',
				message: 'Avoid SELECT *',
			});
		});
	});

	describe('executeNQL', () => {
		it('calls client.call with correct method and params', async () => {
			const params: ExecuteNqlParams = {
				connectionId: 'conn-123',
				nql: 'users { id, name }',
				maxRows: 50,
				timeoutMs: 3000,
			};
			const mockResponse = {
				rows: [[1, 'Alice']],
				columns: [
					{ name: 'id', type: 'integer' },
					{ name: 'name', type: 'text' },
				],
				rowCount: 1,
				timeMs: 25,
				truncated: false,
				plan: { type: 'select' },
			};
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.executeNQL(params);

			expect(mockCall).toHaveBeenCalledWith('executeNQL', params);
			expect(result).toEqual(mockResponse);
		});

		it('handles minimal params', async () => {
			const params: ExecuteNqlParams = {
				connectionId: 'conn-123',
				nql: 'users',
			};
			const mockResponse = {
				rows: [],
				columns: [],
				rowCount: 0,
				timeMs: 5,
				truncated: false,
				plan: {},
			};
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.executeNQL(params);

			expect(mockCall).toHaveBeenCalledWith('executeNQL', params);
			expect(result).toEqual(mockResponse);
		});
	});

	describe('fetchMore', () => {
		it('calls client.call with correct method and params', async () => {
			const params: FetchMoreParams = {
				cursorId: 'cursor-789',
				maxRows: 100,
			};
			const mockResponse = {
				rows: [[2, 'Bob']],
				columns: [
					{ name: 'id', type: 'integer' },
					{ name: 'name', type: 'text' },
				],
				rowCount: 1,
				timeMs: 15,
				truncated: false,
			};
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.fetchMore(params);

			expect(mockCall).toHaveBeenCalledWith('fetchMore', params);
			expect(result).toEqual(mockResponse);
		});

		it('handles cursorId only', async () => {
			const params: FetchMoreParams = {
				cursorId: 'cursor-999',
			};
			const mockResponse = {
				rows: [],
				columns: [],
				rowCount: 0,
				timeMs: 2,
				truncated: false,
			};
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.fetchMore(params);

			expect(mockCall).toHaveBeenCalledWith('fetchMore', params);
			expect(result).toEqual(mockResponse);
		});
	});

	describe('cancel', () => {
		it('calls client.call with string requestId', async () => {
			const mockResponse = { ok: true };
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.cancel('req-123');

			expect(mockCall).toHaveBeenCalledWith('cancel', { requestId: 'req-123' });
			expect(result).toEqual(mockResponse);
		});

		it('calls client.call with numeric requestId', async () => {
			const mockResponse = { ok: true };
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.cancel(42);

			expect(mockCall).toHaveBeenCalledWith('cancel', { requestId: 42 });
			expect(result).toEqual(mockResponse);
		});
	});

	describe('getCompletions', () => {
		it('calls client.call with sql language', async () => {
			const mockResponse = {
				items: [
					{ label: 'SELECT', kind: 'keyword' },
					{ label: 'FROM', kind: 'keyword' },
				],
			};
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.getCompletions('conn-123', 'SEL', 3, 'sql');

			expect(mockCall).toHaveBeenCalledWith('getCompletions', {
				connectionId: 'conn-123',
				text: 'SEL',
				position: 3,
				language: 'sql',
			});
			expect(result).toEqual(mockResponse);
		});

		it('calls client.call with nql language', async () => {
			const mockResponse = {
				items: [
					{ label: 'users', kind: 'table', detail: 'Table' },
					{ label: 'posts', kind: 'table', detail: 'Table' },
				],
			};
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.getCompletions('conn-123', 'us', 2, 'nql');

			expect(mockCall).toHaveBeenCalledWith('getCompletions', {
				connectionId: 'conn-123',
				text: 'us',
				position: 2,
				language: 'nql',
			});
			expect(result).toEqual(mockResponse);
		});

		it('includes optional completion properties', async () => {
			const mockResponse = {
				items: [
					{
						label: 'users',
						kind: 'table',
						detail: 'Public table',
						insertText: 'users',
					},
				],
			};
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.getCompletions('conn-123', 'u', 1, 'nql');

			expect(result.items[0]).toHaveProperty('insertText');
			expect(result.items[0].insertText).toBe('users');
		});
	});

	describe('listDatabases', () => {
		it('calls client.call with correct method and params', async () => {
			const params: DiscoverParams = {
				host: 'localhost',
				port: 5432,
				user: 'admin',
				password: 'secret',
				sslMode: 'require',
			};
			const mockResponse = { databases: ['postgres', 'testdb', 'proddb'] };
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.listDatabases(params);

			expect(mockCall).toHaveBeenCalledWith('listDatabases', params);
			expect(result).toEqual(mockResponse);
		});

		it('handles params without sslMode', async () => {
			const params: DiscoverParams = {
				host: 'localhost',
				port: 5432,
				user: 'admin',
				password: 'secret',
			};
			const mockResponse = { databases: ['postgres'] };
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.listDatabases(params);

			expect(mockCall).toHaveBeenCalledWith('listDatabases', params);
			expect(result).toEqual(mockResponse);
		});
	});

	describe('listSchemas', () => {
		it('calls client.call with correct method and params', async () => {
			const params: ListSchemasParams = {
				host: 'localhost',
				port: 5432,
				user: 'admin',
				password: 'secret',
				database: 'testdb',
				sslMode: 'prefer',
			};
			const mockResponse = { schemas: ['public', 'private', 'analytics'] };
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.listSchemas(params);

			expect(mockCall).toHaveBeenCalledWith('listSchemas', params);
			expect(result).toEqual(mockResponse);
		});

		it('handles params without sslMode', async () => {
			const params: ListSchemasParams = {
				host: 'localhost',
				port: 5432,
				user: 'admin',
				password: 'secret',
				database: 'testdb',
			};
			const mockResponse = { schemas: ['public'] };
			mockCall.mockResolvedValue(mockResponse);

			const result = await api.listSchemas(params);

			expect(mockCall).toHaveBeenCalledWith('listSchemas', params);
			expect(result).toEqual(mockResponse);
		});
	});
});

describe('singleton exports', () => {
	it('exports ipcClient instance', () => {
		expect(ipcClient).toBeDefined();
		expect(ipcClient).toHaveProperty('call');
	});

	it('exports sidecarApi instance', () => {
		expect(sidecarApi).toBeDefined();
		expect(sidecarApi).toHaveProperty('handshake');
		expect(sidecarApi).toHaveProperty('connect');
		expect(sidecarApi).toHaveProperty('disconnect');
		expect(sidecarApi).toHaveProperty('introspect');
		expect(sidecarApi).toHaveProperty('executeSQL');
		expect(sidecarApi).toHaveProperty('compileNQL');
		expect(sidecarApi).toHaveProperty('executeNQL');
		expect(sidecarApi).toHaveProperty('fetchMore');
		expect(sidecarApi).toHaveProperty('cancel');
		expect(sidecarApi).toHaveProperty('getCompletions');
		expect(sidecarApi).toHaveProperty('listDatabases');
		expect(sidecarApi).toHaveProperty('listSchemas');
	});

	it('sidecarApi is created from ipcClient', () => {
		expect(typeof sidecarApi.handshake).toBe('function');
		expect(typeof sidecarApi.connect).toBe('function');
		expect(typeof sidecarApi.disconnect).toBe('function');
		expect(typeof sidecarApi.introspect).toBe('function');
		expect(typeof sidecarApi.executeSQL).toBe('function');
		expect(typeof sidecarApi.compileNQL).toBe('function');
		expect(typeof sidecarApi.executeNQL).toBe('function');
		expect(typeof sidecarApi.fetchMore).toBe('function');
		expect(typeof sidecarApi.cancel).toBe('function');
		expect(typeof sidecarApi.getCompletions).toBe('function');
		expect(typeof sidecarApi.listDatabases).toBe('function');
		expect(typeof sidecarApi.listSchemas).toBe('function');
	});
});
