import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcClient, type IpcTransport } from './ipc-transport.js';

/** Create a mock transport for testing. */
function createMockTransport(): IpcTransport & {
	messageCallback: ((message: string) => void) | null;
	closeCallback: ((code: number | null) => void) | null;
	sent: string[];
	simulateMessage: (msg: string) => void;
	simulateClose: (code: number | null) => void;
} {
	const transport = {
		messageCallback: null as ((message: string) => void) | null,
		closeCallback: null as ((code: number | null) => void) | null,
		sent: [] as string[],

		send(message: string) {
			transport.sent.push(message);
		},
		onMessage(callback: (message: string) => void) {
			transport.messageCallback = callback;
		},
		onClose(callback: (code: number | null) => void) {
			transport.closeCallback = callback;
		},
		close() {
			/* noop */
		},

		simulateMessage(msg: string) {
			transport.messageCallback?.(msg);
		},
		simulateClose(code: number | null) {
			transport.closeCallback?.(code);
		},
	};
	return transport;
}

describe('IpcClient', () => {
	let client: IpcClient;
	let transport: ReturnType<typeof createMockTransport>;

	beforeEach(() => {
		client = new IpcClient();
		transport = createMockTransport();
	});

	describe('status lifecycle', () => {
		it('starts as stopped', () => {
			expect(client.status).toBe('stopped');
		});

		it('transitions through spawning → handshaking → ready on connect', async () => {
			const statuses: string[] = [];
			client.onStatusChange((s: string) => statuses.push(s));

			const connectPromise = client.connect(transport, '1.0.0');

			// Simulate handshake response
			const handshakeReq = JSON.parse(transport.sent[0]!);
			transport.simulateMessage(
				JSON.stringify({
					jsonrpc: '2.0',
					id: handshakeReq.id,
					result: { version: '1.0.0', capabilities: ['sql'] },
				}),
			);

			await connectPromise;

			expect(statuses).toEqual(['spawning', 'handshaking', 'ready']);
			expect(client.status).toBe('ready');
		});
	});

	describe('call', () => {
		it('sends JSON-RPC request and resolves with result', async () => {
			// Connect first
			const connectPromise = client.connect(transport, '1.0.0');
			const handshakeReq = JSON.parse(transport.sent[0]!);
			transport.simulateMessage(
				JSON.stringify({
					jsonrpc: '2.0',
					id: handshakeReq.id,
					result: { version: '1.0.0', capabilities: [] },
				}),
			);
			await connectPromise;

			// Make a call
			const resultPromise = client.call('introspect', { connectionId: 'abc' });
			const req = JSON.parse(transport.sent[1]!);
			expect(req.method).toBe('introspect');
			expect(req.params).toEqual({ connectionId: 'abc' });

			// Simulate response
			transport.simulateMessage(
				JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tables: [] } }),
			);

			const result = await resultPromise;
			expect(result).toEqual({ tables: [] });
		});

		it('rejects on error response', async () => {
			const connectPromise = client.connect(transport, '1.0.0');
			const handshakeReq = JSON.parse(transport.sent[0]!);
			transport.simulateMessage(
				JSON.stringify({
					jsonrpc: '2.0',
					id: handshakeReq.id,
					result: { version: '1.0.0', capabilities: [] },
				}),
			);
			await connectPromise;

			const callPromise = client.call('executeSQL', {
				connectionId: 'abc',
				sql: 'BAD',
			});
			const req = JSON.parse(transport.sent[1]!);

			transport.simulateMessage(
				JSON.stringify({
					jsonrpc: '2.0',
					id: req.id,
					error: { code: -32000, message: 'Not connected' },
				}),
			);

			await expect(callPromise).rejects.toThrow('Not connected');
		});
	});

	describe('queuing', () => {
		it('rejects immediately when sidecar is stopped', async () => {
			// Client starts as stopped — calls should reject, not queue forever
			await expect(
				client.call('introspect', { connectionId: 'abc' }),
			).rejects.toThrow('Sidecar is not running');
		});

		it('queues calls during restart and flushes after reconnect', async () => {
			// Connect first
			const connectPromise = client.connect(transport, '1.0.0');
			const handshakeReq = JSON.parse(transport.sent[0]!);
			transport.simulateMessage(
				JSON.stringify({
					jsonrpc: '2.0',
					id: handshakeReq.id,
					result: { version: '1.0.0', capabilities: [] },
				}),
			);
			await connectPromise;

			// Simulate crash → status becomes 'restarting'
			transport.simulateClose(1);
			expect(client.status).toBe('restarting');

			// Call while restarting — should be queued (not rejected)
			const transport2 = createMockTransport();
			const callPromise = client.call('introspect', { connectionId: 'abc' });

			// Reconnect
			const reconnectPromise = client.connect(transport2, '1.0.0');
			const handshakeReq2 = JSON.parse(transport2.sent[0]!);
			transport2.simulateMessage(
				JSON.stringify({
					jsonrpc: '2.0',
					id: handshakeReq2.id,
					result: { version: '1.0.0', capabilities: [] },
				}),
			);
			await reconnectPromise;

			// The queued call should now be sent
			const req = JSON.parse(transport2.sent[1]!);
			expect(req.method).toBe('introspect');

			// Respond
			transport2.simulateMessage(
				JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tables: [] } }),
			);

			await expect(callPromise).resolves.toEqual({ tables: [] });
		});
	});

	describe('notifications', () => {
		it('calls notification handler for heartbeat', async () => {
			const handler = vi.fn();
			client.onNotification('heartbeat', handler);

			const connectPromise = client.connect(transport, '1.0.0');
			const handshakeReq = JSON.parse(transport.sent[0]!);
			transport.simulateMessage(
				JSON.stringify({
					jsonrpc: '2.0',
					id: handshakeReq.id,
					result: { version: '1.0.0', capabilities: [] },
				}),
			);
			await connectPromise;

			transport.simulateMessage('{"jsonrpc":"2.0","method":"heartbeat"}');
			expect(handler).toHaveBeenCalledOnce();
		});
	});

	describe('crash handling', () => {
		it('rejects pending requests on transport close', async () => {
			const connectPromise = client.connect(transport, '1.0.0');
			const handshakeReq = JSON.parse(transport.sent[0]!);
			transport.simulateMessage(
				JSON.stringify({
					jsonrpc: '2.0',
					id: handshakeReq.id,
					result: { version: '1.0.0', capabilities: [] },
				}),
			);
			await connectPromise;

			const callPromise = client.call('executeSQL', {
				connectionId: 'abc',
				sql: 'SELECT 1',
			});
			transport.simulateClose(1);

			await expect(callPromise).rejects.toThrow('Engine restarting');
			expect(client.status).toBe('restarting');
		});

		it('ignores stale exit event during handshake (reload scenario)', async () => {
			const connectPromise = client.connect(transport, '1.0.0');

			// Simulate a stale sidecar-exit from the old process killed by sidecar_spawn
			// This arrives while status is 'handshaking' — must be ignored
			transport.simulateClose(null);

			// Complete the handshake normally
			const handshakeReq = JSON.parse(transport.sent[0]!);
			transport.simulateMessage(
				JSON.stringify({
					jsonrpc: '2.0',
					id: handshakeReq.id,
					result: { version: '1.0.0', capabilities: [] },
				}),
			);
			await connectPromise;

			// Should reach ready state despite the stale exit event
			expect(client.status).toBe('ready');
		});
	});

	describe('disconnect', () => {
		it('rejects pending and sets status to stopped', async () => {
			const connectPromise = client.connect(transport, '1.0.0');
			const handshakeReq = JSON.parse(transport.sent[0]!);
			transport.simulateMessage(
				JSON.stringify({
					jsonrpc: '2.0',
					id: handshakeReq.id,
					result: { version: '1.0.0', capabilities: [] },
				}),
			);
			await connectPromise;

			const callPromise = client.call('executeSQL', {
				connectionId: 'abc',
				sql: 'SELECT 1',
			});
			client.disconnect();

			await expect(callPromise).rejects.toThrow('Disconnected');
			expect(client.status).toBe('stopped');
		});
	});

	describe('setLogger', () => {
		async function connectClient() {
			const connectPromise = client.connect(transport, '1.0.0');
			const req = JSON.parse(transport.sent[0]!);
			transport.simulateMessage(
				JSON.stringify({
					jsonrpc: '2.0',
					id: req.id,
					result: { version: '1.0.0', capabilities: [] },
				}),
			);
			await connectPromise;
		}

		it('logs request and response with duration', async () => {
			const logs: Array<{ type: string; method: string; durationMs?: number }> =
				[];
			client.setLogger((type, method, durationMs) => {
				logs.push({ type, method, durationMs });
			});

			await connectClient();

			// handshake produced request + response
			expect(logs).toHaveLength(2);
			expect(logs[0]).toMatchObject({ type: 'request', method: 'handshake' });
			expect(logs[1]).toMatchObject({ type: 'response', method: 'handshake' });
			expect(logs[1]!.durationMs).toBeGreaterThanOrEqual(0);
		});

		it('logs error with duration on rejection', async () => {
			const logs: Array<{
				type: string;
				method: string;
				durationMs?: number;
				error?: Error;
			}> = [];
			client.setLogger((type, method, durationMs, error) => {
				logs.push({ type, method, durationMs, error });
			});

			// Call without connect → stopped → rejects
			await expect(client.call('foo')).rejects.toThrow('not running');

			expect(logs).toHaveLength(2);
			expect(logs[0]).toMatchObject({ type: 'request', method: 'foo' });
			expect(logs[1]).toMatchObject({ type: 'error', method: 'foo' });
			expect(logs[1]!.durationMs).toBeGreaterThanOrEqual(0);
			expect(logs[1]!.error).toBeInstanceOf(Error);
		});

		it('logs response for successful call after connect', async () => {
			const logs: Array<{ type: string; method: string; durationMs?: number }> =
				[];
			client.setLogger((type, method, durationMs) => {
				logs.push({ type, method, durationMs });
			});

			await connectClient();
			logs.length = 0; // Clear handshake logs

			const callPromise = client.call('executeNQL', { nql: 'select from users' });
			const req = JSON.parse(transport.sent[1]!);
			transport.simulateMessage(
				JSON.stringify({
					jsonrpc: '2.0',
					id: req.id,
					result: { rows: [], columns: [] },
				}),
			);
			await callPromise;

			expect(logs).toHaveLength(2);
			expect(logs[0]).toMatchObject({ type: 'request', method: 'executeNQL' });
			expect(logs[1]).toMatchObject({ type: 'response', method: 'executeNQL' });
			expect(logs[1]!.durationMs).toBeGreaterThanOrEqual(0);
		});

		it('can be cleared by passing null', async () => {
			const logs: string[] = [];
			client.setLogger((type) => logs.push(type));

			await connectClient();
			expect(logs.length).toBeGreaterThan(0);

			client.setLogger(null);
			logs.length = 0;

			const callPromise = client.call('test');
			const req = JSON.parse(transport.sent[1]!);
			transport.simulateMessage(
				JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 'ok' }),
			);
			await callPromise;

			expect(logs).toHaveLength(0);
		});
	});

	describe('CRLF handling', () => {
		it('handles CRLF in response messages', async () => {
			const connectPromise = client.connect(transport, '1.0.0');
			const handshakeReq = JSON.parse(transport.sent[0]!);
			// Simulate response with CRLF
			transport.simulateMessage(
				`{"jsonrpc":"2.0","id":${handshakeReq.id},"result":{"version":"1.0.0","capabilities":[]}}\r\n`,
			);
			await connectPromise;
			expect(client.status).toBe('ready');
		});
	});
});
