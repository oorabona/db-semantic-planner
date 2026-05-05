import { validatePayload } from './sanitize';
import type { HashPayloadV1 } from './types';

export const HASH_PREFIX = 'h=';
export const HASH_VERSION = 1 as const;

/**
 * URL length cap for the *full hash content* (the bit after `#`, including
 * the `h=` prefix). 4000 chars is a conservative baseline below all
 * documented browser URL limits (Chrome ~32k, Firefox ~64k, Safari ~80k,
 * Edge ~2k legacy). Calibrate during implementation if real schemas push
 * past this; the encoder surfaces a banner + skips the write when exceeded.
 */
export const MAX_HASH_LENGTH = 4000;

export function isHashLengthOk(hash: string): boolean {
	return hash.length <= MAX_HASH_LENGTH;
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++)
		binary += String.fromCharCode(bytes[i]);
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

function fromBase64Url(b64url: string): Uint8Array {
	const padded = b64url.replace(/-/g, '+').replace(/_/g, '/');
	const padding = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
	const padRight = padded + '='.repeat(padding);
	const binary = atob(padRight);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

export async function encodeHash(payload: HashPayloadV1): Promise<string> {
	// Defensive: refuse to encode anything that wouldn't pass decode validation.
	const verdict = validatePayload(payload);
	if (!verdict.ok) {
		throw new Error(
			`encodeHash: payload failed validation (${verdict.reason})`,
		);
	}

	const json = JSON.stringify(payload);
	const stream = new CompressionStream('gzip');
	const writer = stream.writable.getWriter();
	await writer.write(new TextEncoder().encode(json));
	await writer.close();
	const bytes = new Uint8Array(
		await new Response(stream.readable).arrayBuffer(),
	);
	return HASH_PREFIX + toBase64Url(bytes);
}

export type DecodeResult =
	| { ok: true; payload: HashPayloadV1 }
	| {
			ok: false;
			reason:
				| 'no-hash'
				| 'no-compression-stream'
				| 'decode-error'
				| 'version'
				| 'size'
				| 'identifier'
				| 'shape';
	  };

export async function decodeHash(rawHash: string): Promise<DecodeResult> {
	// Strip leading '#'
	const hash = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
	if (!hash.startsWith(HASH_PREFIX)) {
		return { ok: false, reason: 'no-hash' };
	}

	if (!('CompressionStream' in globalThis)) {
		return { ok: false, reason: 'no-compression-stream' };
	}

	const b64url = hash.slice(HASH_PREFIX.length);
	let bytes: Uint8Array;
	try {
		bytes = fromBase64Url(b64url);
	} catch {
		return { ok: false, reason: 'decode-error' };
	}

	let json: string;
	try {
		const stream = new DecompressionStream('gzip');
		const writer = stream.writable.getWriter();
		await writer.write(bytes);
		await writer.close();
		json = await new Response(stream.readable).text();
	} catch {
		return { ok: false, reason: 'decode-error' };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return { ok: false, reason: 'decode-error' };
	}

	const verdict = validatePayload(parsed);
	if (verdict.ok) return { ok: true, payload: verdict.payload };
	return { ok: false, reason: verdict.reason };
}
