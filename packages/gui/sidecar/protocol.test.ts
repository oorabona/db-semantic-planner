import { describe, expect, it } from 'vitest';
import {
	decode,
	ErrorCode,
	encode,
	error,
	notification,
	ProtocolError,
	success,
} from './protocol';

describe('protocol codec', () => {
	describe('encode', () => {
		it('encodes a success response with trailing newline', () => {
			const msg = success(1, { ok: true });
			const encoded = encode(msg);
			expect(encoded).toBe('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
		});

		it('encodes an error response', () => {
			const msg = error(1, ErrorCode.NotConnected, 'Not connected');
			const encoded = encode(msg);
			expect(encoded).toContain('"error"');
			expect(encoded).toContain('-32000');
			expect(encoded.endsWith('\n')).toBe(true);
		});

		it('encodes a notification (no id)', () => {
			const msg = notification('heartbeat');
			const encoded = encode(msg);
			expect(encoded).toBe('{"jsonrpc":"2.0","method":"heartbeat"}\n');
		});

		it('serializes BigInt as string', () => {
			const msg = success(1, { count: BigInt('9007199254740993') });
			const encoded = encode(msg);
			expect(encoded).toContain('"9007199254740993"');
			// BigInt should be serialized as quoted string, not as 9007199254740993n
			expect(encoded).not.toMatch(/\d+n/);
		});

		it('encodes notification with params', () => {
			const msg = notification('progress', { percent: 50 });
			expect(encode(msg)).toContain('"percent":50');
		});
	});

	describe('decode', () => {
		it('decodes a valid JSON-RPC request', () => {
			const line =
				'{"jsonrpc":"2.0","id":1,"method":"handshake","params":{"version":"1.0.0"}}';
			const req = decode(line);
			expect(req.jsonrpc).toBe('2.0');
			expect(req.id).toBe(1);
			expect(req.method).toBe('handshake');
			expect(req.params).toEqual({ version: '1.0.0' });
		});

		it('normalizes CRLF to LF before parsing', () => {
			const line = '{"jsonrpc":"2.0","id":2,"method":"ping"}\r\n';
			const req = decode(line);
			expect(req.method).toBe('ping');
			expect(req.id).toBe(2);
		});

		it('throws ProtocolError on empty message', () => {
			expect(() => decode('')).toThrow(ProtocolError);
			expect(() => decode('   ')).toThrow(ProtocolError);
		});

		it('throws ProtocolError on invalid JSON', () => {
			expect(() => decode('{not json')).toThrow(ProtocolError);
		});

		it('throws ProtocolError on non-2.0 version', () => {
			expect(() => decode('{"jsonrpc":"1.0","id":1,"method":"x"}')).toThrow(
				ProtocolError,
			);
		});

		it('throws ProtocolError on missing method', () => {
			expect(() => decode('{"jsonrpc":"2.0","id":1}')).toThrow(ProtocolError);
		});

		it('defaults id to null if missing', () => {
			const req = decode('{"jsonrpc":"2.0","method":"notify"}');
			expect(req.id).toBeNull();
		});

		it('handles params being undefined', () => {
			const req = decode('{"jsonrpc":"2.0","id":1,"method":"test"}');
			expect(req.params).toBeUndefined();
		});
	});

	describe('helper constructors', () => {
		it('success creates valid response', () => {
			const resp = success(42, 'hello');
			expect(resp.jsonrpc).toBe('2.0');
			expect(resp.id).toBe(42);
			expect(resp.result).toBe('hello');
		});

		it('error creates valid error response', () => {
			const resp = error(1, -32600, 'Bad request', { detail: 'missing field' });
			expect(resp.error.code).toBe(-32600);
			expect(resp.error.message).toBe('Bad request');
			expect(resp.error.data).toEqual({ detail: 'missing field' });
		});

		it('error without data omits data field', () => {
			const resp = error(1, -32600, 'Bad');
			expect('data' in resp.error).toBe(false);
		});
	});
});
