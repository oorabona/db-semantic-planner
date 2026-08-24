import {
	CanonicalJsonError,
	canonicalJson,
	canonicalJsonDigest,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';

describe('canonical durable JSON payloads', () => {
	it('keeps a payload digest stable across a jsonb-style key reorder', () => {
		const minted = {
			zebra: { second: 2, first: 1 },
			alpha: [{ later: true, earlier: false }],
		};
		const loaded = {
			alpha: [{ earlier: false, later: true }],
			zebra: { first: 1, second: 2 },
		};

		expect(canonicalJson(minted)).toBe(
			'{"alpha":[{"earlier":false,"later":true}],"zebra":{"first":1,"second":2}}',
		);
		expect(canonicalJsonDigest(loaded)).toBe(canonicalJsonDigest(minted));
	});

	it.each([
		['an undefined-valued own member', { retained: true, dropped: undefined }],
		['a bigint', { value: 1n }],
	] as const)('refuses %s with its named error', (_label, value) => {
		expect(() => canonicalJsonDigest(value)).toThrow(CanonicalJsonError);
	});
});
