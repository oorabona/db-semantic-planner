import { describe, expect, it } from 'vitest';
import { ErrorCode } from './protocol.js';
import { Router } from './router.js';

describe('Router', () => {
	it('dispatches handshake and returns capabilities', async () => {
		const router = new Router();
		const response = await router.dispatch({
			jsonrpc: '2.0',
			id: 0,
			method: 'handshake',
			params: { version: '1.0.0' },
		});

		expect(response).toMatchObject({
			jsonrpc: '2.0',
			id: 0,
			result: {
				version: '1.0.0',
				capabilities: expect.arrayContaining(['sql', 'nql']),
			},
		});
	});

	it('returns MethodNotFound for unknown methods', async () => {
		const router = new Router();
		const response = await router.dispatch({
			jsonrpc: '2.0',
			id: 1,
			method: 'unknownMethod',
		});

		expect(response).toMatchObject({
			id: 1,
			error: { code: ErrorCode.MethodNotFound },
		});
	});

	it('returns InvalidParams for bad handshake params', async () => {
		const router = new Router();
		const response = await router.dispatch({
			jsonrpc: '2.0',
			id: 1,
			method: 'handshake',
			params: { version: 123 }, // should be string
		});

		expect(response).toMatchObject({
			id: 1,
			error: { code: ErrorCode.InvalidParams },
		});
	});

	it('returns NotConnected for stub methods', async () => {
		const router = new Router();
		const response = await router.dispatch({
			jsonrpc: '2.0',
			id: 1,
			method: 'executeSQL',
			params: { connectionId: 'test', sql: 'SELECT 1' },
		});

		expect(response).toMatchObject({
			id: 1,
			error: { code: ErrorCode.NotConnected },
		});
	});

	it('validates connect params (invalid port)', async () => {
		const router = new Router();
		const response = await router.dispatch({
			jsonrpc: '2.0',
			id: 1,
			method: 'connect',
			params: {
				host: 'localhost',
				port: -1,
				database: 'test',
				user: 'user',
				password: 'pass',
			},
		});

		expect(response).toMatchObject({
			id: 1,
			error: { code: ErrorCode.InvalidParams },
		});
	});

	it('allows replacing stub handlers', async () => {
		const router = new Router();
		router.setHandler('connect', () => ({
			ok: true,
			connectionId: 'abc-123',
			tables: 5,
		}));

		const response = await router.dispatch({
			jsonrpc: '2.0',
			id: 1,
			method: 'connect',
			params: {
				host: 'localhost',
				port: 5432,
				database: 'test',
				user: 'user',
				password: 'pass',
			},
		});

		expect(response).toMatchObject({
			id: 1,
			result: { ok: true, connectionId: 'abc-123', tables: 5 },
		});
	});

	it('catches handler errors and returns InternalError', async () => {
		const router = new Router();
		router.setHandler('connect', () => {
			throw new Error('Boom!');
		});

		const response = await router.dispatch({
			jsonrpc: '2.0',
			id: 1,
			method: 'connect',
			params: {
				host: 'localhost',
				port: 5432,
				database: 'test',
				user: 'user',
				password: 'pass',
			},
		});

		expect(response).toMatchObject({
			id: 1,
			error: { code: ErrorCode.InternalError, message: 'Boom!' },
		});
	});
});
