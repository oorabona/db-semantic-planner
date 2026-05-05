import { describe, expect, it } from 'vitest';
import {
	decodeHash,
	encodeHash,
	HASH_PREFIX,
	HASH_VERSION,
	isHashLengthOk,
	MAX_HASH_LENGTH,
} from './hash-codec';
import type { HashPayloadV1 } from './types';

const sample: HashPayloadV1 = {
	v: 1,
	s: 'table users {\n  id: uuid pk\n  name: string\n  email: string unique\n}\n',
	n: 'users {| name, email |}',
	m: 'nql',
};

describe('encodeHash + decodeHash roundtrip', () => {
	it('produces a base64url string with the prefix', async () => {
		const encoded = await encodeHash(sample);
		expect(encoded.startsWith(HASH_PREFIX)).toBe(true);
		// base64url alphabet only — no `+`, `/`, or `=`.
		expect(encoded.slice(HASH_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('decodes back to the same payload', async () => {
		const encoded = await encodeHash(sample);
		const decoded = await decodeHash(encoded);
		expect(decoded).toEqual({ ok: true, payload: sample });
	});

	it('decodes from a hash that includes the leading "#"', async () => {
		const encoded = await encodeHash(sample);
		const decoded = await decodeHash(`#${encoded}`);
		expect(decoded).toEqual({ ok: true, payload: sample });
	});
});

describe('decodeHash failure modes', () => {
	it('reports "no-hash" when input is empty / has no h= prefix', async () => {
		expect(await decodeHash('')).toEqual({ ok: false, reason: 'no-hash' });
		expect(await decodeHash('foo=bar')).toEqual({
			ok: false,
			reason: 'no-hash',
		});
	});

	it('reports "decode-error" when the base64url is corrupt', async () => {
		expect(await decodeHash(`${HASH_PREFIX}not-valid-base64-!!!`)).toEqual({
			ok: false,
			reason: 'decode-error',
		});
	});

	it('reports "decode-error" when the gzipped payload is invalid', async () => {
		// 'AAAA' decodes to 3 bytes that aren't a valid gzip stream.
		expect(await decodeHash(`${HASH_PREFIX}AAAA`)).toEqual({
			ok: false,
			reason: 'decode-error',
		});
	});

	it('reports "no-compression-stream" when CompressionStream is missing', async () => {
		const original = (globalThis as { CompressionStream?: unknown })
			.CompressionStream;
		// @ts-expect-error temporary delete to simulate old browser
		delete (globalThis as { CompressionStream?: unknown }).CompressionStream;
		try {
			const encoded = `${HASH_PREFIX}anything`;
			expect(await decodeHash(encoded)).toEqual({
				ok: false,
				reason: 'no-compression-stream',
			});
		} finally {
			(globalThis as { CompressionStream?: unknown }).CompressionStream =
				original;
		}
	});
});

describe('encodeHash sanitization integration', () => {
	it('refuses to encode payloads that fail validation', async () => {
		// Bad identifier in schema.
		await expect(
			encodeHash({
				v: 1,
				s: 'table 1users { id: uuid pk }',
				n: 'users {| name |}',
				m: 'nql',
			}),
		).rejects.toThrow();
	});

	it('refuses payloads larger than MAX_NQL_BYTES', async () => {
		await expect(
			encodeHash({
				v: 1,
				s: 'table users { id: uuid pk }',
				n: 'a'.repeat(3 * 1024),
				m: 'nql',
			}),
		).rejects.toThrow();
	});
});

describe('isHashLengthOk', () => {
	it('returns true below cap', () => {
		expect(isHashLengthOk('a'.repeat(MAX_HASH_LENGTH - 1))).toBe(true);
	});

	it('returns false above cap', () => {
		expect(isHashLengthOk('a'.repeat(MAX_HASH_LENGTH + 1))).toBe(false);
	});
});

describe('HASH_VERSION constant', () => {
	it('is 1 in v1 of the spec', () => {
		expect(HASH_VERSION).toBe(1);
	});
});
