/**
 * Tests for sidecar/index.ts — JSON-RPC over stdin/stdout entry point.
 *
 * Strategy: sidecar/index.ts has top-level side effects (console patching,
 * Router creation, readline, heartbeat). We use vi.hoisted() for mock values
 * that vi.mock factories reference, and vi.resetModules() to get fresh imports.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mocks (available at vi.mock hoist time) ───────────────
// NOTE: Cannot use `import { EventEmitter }` inside vi.hoisted() since
// imports aren't resolved yet. We use require() which is available at hoist.

const {
	mockDispatch,
	mockSetHandler,
	mockDisconnectAll,
	mockConnect,
	mockDisconnect,
	mockIntrospect,
	mockStdinEmitter,
} = vi.hoisted(() => {
	// biome-ignore lint/style/noCommaOperator: require available at hoist
	const { EventEmitter } =
		require('node:events') as typeof import('node:events');
	const emitter = new EventEmitter();
	return {
		mockDispatch: vi.fn(),
		mockSetHandler: vi.fn(),
		mockDisconnectAll: vi.fn(),
		mockConnect: vi.fn(),
		mockDisconnect: vi.fn(),
		mockIntrospect: vi.fn(),
		mockStdinEmitter: emitter,
	};
});

// ── Module mocks ──────────────────────────────────────────────────

vi.mock('./router.js', () => ({
	Router: class MockRouter {
		dispatch = mockDispatch;
		setHandler = mockSetHandler;
	},
}));

vi.mock('./connection-manager.js', () => ({
	connect: mockConnect,
	disconnect: mockDisconnect,
	disconnectAll: mockDisconnectAll,
	introspectConnection: mockIntrospect,
}));

vi.mock('node:readline', () => ({
	createInterface: vi.fn(() => {
		// Attach close/on/emit from the shared emitter
		const rl = Object.create(mockStdinEmitter);
		rl.close = vi.fn();
		return rl;
	}),
}));

// ── Test helpers ──────────────────────────────────────────────────

const stdoutCapture: string[] = [];
const stderrCapture: string[] = [];
let origStdout: typeof process.stdout.write;
let origStderr: typeof process.stderr.write;

describe('sidecar/index.ts', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		stdoutCapture.length = 0;
		stderrCapture.length = 0;

		origStdout = process.stdout.write;
		origStderr = process.stderr.write;
		process.stdout.write = ((data: string) => {
			stdoutCapture.push(data);
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((data: string) => {
			stderrCapture.push(data);
			return true;
		}) as typeof process.stderr.write;

		// Reset module cache so each test gets a fresh import
		vi.resetModules();
		await import('./index.js');
	});

	afterEach(() => {
		process.stdout.write = origStdout;
		process.stderr.write = origStderr;
		vi.restoreAllMocks();
		mockStdinEmitter.removeAllListeners();
	});

	// ── Console patching ──────────────────────────────────────────

	describe('console patching', () => {
		it('redirects console.log to stderr', () => {
			console.log('hello');
			expect(stderrCapture.some((s) => s.includes('hello'))).toBe(true);
		});

		it('redirects console.warn with [WARN] prefix', () => {
			console.warn('danger');
			expect(
				stderrCapture.some((s) => s.includes('[WARN]') && s.includes('danger')),
			).toBe(true);
		});

		it('redirects console.error with [ERROR] prefix', () => {
			console.error('boom');
			expect(
				stderrCapture.some((s) => s.includes('[ERROR]') && s.includes('boom')),
			).toBe(true);
		});
	});

	// ── Handler registration ──────────────────────────────────────

	describe('handler registration', () => {
		it('registers connect handler', () => {
			expect(mockSetHandler).toHaveBeenCalledWith(
				'connect',
				expect.any(Function),
			);
		});

		it('registers disconnect handler', () => {
			expect(mockSetHandler).toHaveBeenCalledWith(
				'disconnect',
				expect.any(Function),
			);
		});

		it('registers introspect handler', () => {
			expect(mockSetHandler).toHaveBeenCalledWith(
				'introspect',
				expect.any(Function),
			);
		});
	});

	// ── stdin line processing ─────────────────────────────────────

	describe('stdin line processing', () => {
		it('dispatches valid JSON-RPC request', async () => {
			const mockResponse = {
				jsonrpc: '2.0' as const,
				id: 1,
				result: { ok: true },
			};
			mockDispatch.mockResolvedValueOnce(mockResponse);

			const request = JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'test',
				params: { a: 1 },
			});
			mockStdinEmitter.emit('line', request);

			await vi.waitFor(() => {
				expect(mockDispatch).toHaveBeenCalledTimes(1);
			});

			expect(mockDispatch).toHaveBeenCalledWith({
				jsonrpc: '2.0',
				id: 1,
				method: 'test',
				params: { a: 1 },
			});
		});

		it('skips empty lines', async () => {
			mockStdinEmitter.emit('line', '');
			mockStdinEmitter.emit('line', '   ');
			mockStdinEmitter.emit('line', '\t');

			await new Promise((r) => setTimeout(r, 20));

			expect(mockDispatch).not.toHaveBeenCalled();
		});

		it('returns parse error for invalid JSON', async () => {
			mockStdinEmitter.emit('line', '{ broken }');

			await vi.waitFor(() => {
				expect(stdoutCapture.length).toBeGreaterThan(0);
			});

			const output = stdoutCapture.join('');
			const response = JSON.parse(output.trim());

			expect(response.jsonrpc).toBe('2.0');
			expect(response.id).toBeNull();
			expect(response.error).toBeDefined();
			expect(response.error.code).toBe(-32700); // ParseError
		});

		it('returns error for invalid request (missing method)', async () => {
			const invalidReq = JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				// No method field
			});
			mockStdinEmitter.emit('line', invalidReq);

			await vi.waitFor(() => {
				expect(stdoutCapture.length).toBeGreaterThan(0);
			});

			const response = JSON.parse(stdoutCapture.join('').trim());
			expect(response.error).toBeDefined();
			expect(response.error.code).toBe(-32600); // InvalidRequest
		});

		it('returns error when router dispatch rejects', async () => {
			const err = new Error('Method not found');
			(err as { code?: number }).code = -32601;
			mockDispatch.mockRejectedValueOnce(err);

			const request = JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'unknown',
			});
			mockStdinEmitter.emit('line', request);

			await vi.waitFor(() => {
				expect(stdoutCapture.length).toBeGreaterThan(0);
			});

			const response = JSON.parse(stdoutCapture.join('').trim());
			expect(response.error.code).toBe(-32601);
			expect(response.error.message).toContain('Method not found');
		});

		it('defaults to ParseError code for generic errors', async () => {
			mockDispatch.mockRejectedValueOnce(new Error('oops'));

			const request = JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				method: 'test',
			});
			mockStdinEmitter.emit('line', request);

			await vi.waitFor(() => {
				expect(stdoutCapture.length).toBeGreaterThan(0);
			});

			const response = JSON.parse(stdoutCapture.join('').trim());
			expect(response.error.code).toBe(-32700);
		});
	});

	// ── stdout output format ──────────────────────────────────────

	describe('stdout output format', () => {
		it('writes JSON-RPC responses as JSON lines (trailing newline)', async () => {
			const mockResponse = {
				jsonrpc: '2.0' as const,
				id: 1,
				result: { data: 'test' },
			};
			mockDispatch.mockResolvedValueOnce(mockResponse);

			const request = JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'test',
			});
			mockStdinEmitter.emit('line', request);

			await vi.waitFor(() => {
				expect(stdoutCapture.length).toBeGreaterThan(0);
			});

			const output = stdoutCapture[0]!;
			expect(output).toMatch(/\n$/); // Ends with newline
			const parsed = JSON.parse(output.trim());
			expect(parsed).toEqual(mockResponse);
		});
	});

	// ── Heartbeat ─────────────────────────────────────────────────

	describe('heartbeat', () => {
		// Heartbeat uses setInterval at module load time.
		// Fake timers must be active BEFORE the module import to capture it.
		beforeEach(async () => {
			vi.useFakeTimers();
			stdoutCapture.length = 0;
			vi.resetModules();
			await import('./index.js');
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('sends heartbeat notifications every 3 seconds', () => {
			stdoutCapture.length = 0; // Clear any output from import
			vi.advanceTimersByTime(3000);

			expect(stdoutCapture.length).toBeGreaterThanOrEqual(1);
			const notif = JSON.parse(stdoutCapture[0]!.trim());
			expect(notif.jsonrpc).toBe('2.0');
			expect(notif.method).toBe('heartbeat');
			expect(notif.id).toBeUndefined(); // Notifications have no id
		});

		it('sends multiple heartbeats over time', () => {
			stdoutCapture.length = 0;
			vi.advanceTimersByTime(9000);
			expect(stdoutCapture.length).toBeGreaterThanOrEqual(3);
		});
	});

	// ── Graceful shutdown ─────────────────────────────────────────

	describe('graceful shutdown', () => {
		it('disconnects all connections on stdin close', async () => {
			mockDisconnectAll.mockResolvedValueOnce(undefined);

			const exitSpy = vi
				.spyOn(process, 'exit')
				.mockImplementation((() => {}) as never);

			mockStdinEmitter.emit('close');

			await vi.waitFor(() => {
				expect(mockDisconnectAll).toHaveBeenCalled();
			});
			expect(mockDisconnectAll).toHaveBeenCalledTimes(1);

			exitSpy.mockRestore();
		});
	});
});
