import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Tauri APIs
const mockInvoke = vi.fn();
const mockListen = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
	listen: (event: string, handler: unknown) => mockListen(event, handler),
}));

import { createTauriTransport } from './tauri-transport.js';

describe('createTauriTransport', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockListen.mockResolvedValue(vi.fn());
	});

	it('returns an IpcTransport with send, onMessage, onClose, close', () => {
		const transport = createTauriTransport();

		expect(transport).toHaveProperty('send');
		expect(transport).toHaveProperty('onMessage');
		expect(transport).toHaveProperty('onClose');
		expect(transport).toHaveProperty('close');
	});

	describe('send', () => {
		it('invokes sidecar_send with the message', () => {
			mockInvoke.mockResolvedValue(undefined);
			const transport = createTauriTransport();

			transport.send('{"jsonrpc":"2.0","id":1}');

			expect(mockInvoke).toHaveBeenCalledWith('sidecar_send', {
				message: '{"jsonrpc":"2.0","id":1}',
			});
		});

		it('logs error on send failure (fire-and-forget)', async () => {
			const consoleSpy = vi
				.spyOn(console, 'error')
				.mockImplementation(() => {});
			mockInvoke.mockRejectedValue(new Error('send failed'));

			const transport = createTauriTransport();
			transport.send('msg');

			// Wait for the catch handler
			await vi.waitFor(() => {
				expect(consoleSpy).toHaveBeenCalledWith(
					'[TauriTransport] send error:',
					expect.any(Error),
				);
			});

			consoleSpy.mockRestore();
		});
	});

	describe('onMessage', () => {
		it('listens to sidecar-stdout events', () => {
			const transport = createTauriTransport();
			const callback = vi.fn();

			transport.onMessage(callback);

			expect(mockListen).toHaveBeenCalledWith(
				'sidecar-stdout',
				expect.any(Function),
			);
		});

		it('forwards event payload to callback', () => {
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			let capturedHandler: any = null;
			mockListen.mockImplementation((_event: string, handler: unknown) => {
				capturedHandler = handler;
				return Promise.resolve(vi.fn());
			});

			const transport = createTauriTransport();
			const callback = vi.fn();
			transport.onMessage(callback);

			// Simulate event
			capturedHandler?.({ payload: '{"jsonrpc":"2.0","result":true}' });

			expect(callback).toHaveBeenCalledWith('{"jsonrpc":"2.0","result":true}');
		});
	});

	describe('onClose', () => {
		it('listens to sidecar-exit events', () => {
			const transport = createTauriTransport();
			const callback = vi.fn();

			transport.onClose(callback);

			expect(mockListen).toHaveBeenCalledWith(
				'sidecar-exit',
				expect.any(Function),
			);
		});

		it('forwards exit code to callback', () => {
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			let capturedHandler: any = null;
			mockListen.mockImplementation((_event: string, handler: unknown) => {
				capturedHandler = handler;
				return Promise.resolve(vi.fn());
			});

			const transport = createTauriTransport();
			const callback = vi.fn();
			transport.onClose(callback);

			capturedHandler?.({ payload: 1 });
			expect(callback).toHaveBeenCalledWith(1);

			capturedHandler?.({ payload: null });
			expect(callback).toHaveBeenCalledWith(null);
		});
	});

	describe('close', () => {
		it('calls all unlisteners and invokes sidecar_kill', async () => {
			const unlisten1 = vi.fn();
			const unlisten2 = vi.fn();
			let listenCount = 0;
			mockListen.mockImplementation(() => {
				listenCount++;
				return Promise.resolve(listenCount === 1 ? unlisten1 : unlisten2);
			});
			mockInvoke.mockResolvedValue(undefined);

			const transport = createTauriTransport();
			transport.onMessage(vi.fn());
			transport.onClose(vi.fn());

			// Wait for listen promises to resolve
			await vi.waitFor(() => {
				expect(mockListen).toHaveBeenCalledTimes(2);
			});

			transport.close();

			expect(unlisten1).toHaveBeenCalled();
			expect(unlisten2).toHaveBeenCalled();
			expect(mockInvoke).toHaveBeenCalledWith('sidecar_kill');
		});

		it('ignores sidecar_kill errors', () => {
			mockListen.mockResolvedValue(vi.fn());
			mockInvoke.mockRejectedValue(new Error('already dead'));

			const transport = createTauriTransport();
			// Should not throw
			transport.close();
		});

		it('clears unlisteners array on close (no double-unlisten)', async () => {
			const unlisten = vi.fn();
			mockListen.mockResolvedValue(unlisten);
			mockInvoke.mockResolvedValue(undefined);

			const transport = createTauriTransport();
			transport.onMessage(vi.fn());

			await vi.waitFor(() => {
				expect(mockListen).toHaveBeenCalledTimes(1);
			});

			transport.close();
			expect(unlisten).toHaveBeenCalledTimes(1);

			// Second close should not call unlisten again
			unlisten.mockClear();
			mockInvoke.mockClear();
			transport.close();
			expect(unlisten).not.toHaveBeenCalled();
		});
	});
});
