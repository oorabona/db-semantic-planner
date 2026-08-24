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

	it('refuses cycles with CanonicalJsonError while allowing completed aliases', () => {
		const shared = { value: 1 };
		expect(canonicalJson({ left: shared, right: shared })).toBe(
			'{"left":{"value":1},"right":{"value":1}}',
		);
		const cycle: { self?: unknown } = {};
		cycle.self = cycle;
		expect(() => canonicalJson(cycle)).toThrow(CanonicalJsonError);
	});

	it.each([
		() => {
			const value: unknown[] = [1];
			(value as unknown as Record<string, unknown>).extra = true;
			return value;
		},
		() => {
			const value = [1];
			Object.defineProperty(value, '0', { enumerable: true, get: () => 1 });
			return value;
		},
		() => {
			const value = [1];
			Object.defineProperty(value, Symbol('extra'), { value: true });
			return value;
		},
	] as const)('refuses non-data array surface', (create) => {
		expect(() => canonicalJson(create())).toThrow(CanonicalJsonError);
	});

	it('uses escaped bracket notation for hostile object-member paths', () => {
		const error = expect(() =>
			canonicalJson({ 'a.b\nkey': undefined }),
		).toThrow(CanonicalJsonError);
		void error;
		try {
			canonicalJson({ 'a.b\nkey': undefined });
		} catch (caught) {
			expect((caught as Error).message).toContain('$["a.b\\nkey"]');
			expect((caught as Error).message).not.toContain('a.b\nkey');
		}
	});

	it('translates reflection proxy traps into CanonicalJsonError with cause', () => {
		const trapped = new Error('proxy reflection trap');
		const value = new Proxy(
			{},
			{
				getPrototypeOf: () => {
					throw trapped;
				},
			},
		);
		try {
			canonicalJson(value);
			throw new Error('expected canonical JSON refusal');
		} catch (error) {
			expect(error).toBeInstanceOf(CanonicalJsonError);
			expect((error as Error).cause).toBe(trapped);
		}
	});
});
