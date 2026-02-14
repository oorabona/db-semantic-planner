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
		it('queues calls when not ready and flushes after connect', async () => {
			// Call before connect
			const callPromise = client.call('introspect', { connectionId: 'abc' });

			// Now connect
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

			// The queued call should now be sent
			expect(transport.sent.length).toBe(2);
			const req = JSON.parse(transport.sent[1]!);
			expect(req.method).toBe('introspect');

			// Respond to flush
			transport.simulateMessage(
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
