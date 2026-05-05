import { describe, expect, it } from 'vitest';
import {
	rejectsOversizeSchema,
	rejectsOversizeNql,
	validateIdentifier,
	validatePayload,
} from './sanitize';
import type { HashPayloadV1 } from './types';

describe('validateIdentifier', () => {
	it('accepts standard SQL identifiers', () => {
		expect(validateIdentifier('users')).toBe(true);
		expect(validateIdentifier('user_id')).toBe(true);
		expect(validateIdentifier('UsersTable')).toBe(true);
		expect(validateIdentifier('_private')).toBe(true);
	});

	it('rejects identifiers with unsafe characters', () => {
		expect(validateIdentifier('1users')).toBe(false); // starts with digit
		expect(validateIdentifier('users; DROP TABLE')).toBe(false);
		expect(validateIdentifier('<script>')).toBe(false);
		expect(validateIdentifier('users-table')).toBe(false); // hyphen
		expect(validateIdentifier('')).toBe(false);
	});
});

describe('rejectsOversizeSchema', () => {
	it('returns false (=accepts) up to the cap', () => {
		const small = 'a'.repeat(100);
		expect(rejectsOversizeSchema(small)).toBe(false);
		const atCap = 'a'.repeat(8 * 1024);
		expect(rejectsOversizeSchema(atCap)).toBe(false);
	});

	it('returns true (=rejects) above the cap', () => {
		const oversize = 'a'.repeat(8 * 1024 + 1);
		expect(rejectsOversizeSchema(oversize)).toBe(true);
	});
});

describe('rejectsOversizeNql', () => {
	it('accepts up to the cap', () => {
		expect(rejectsOversizeNql('users {| name |}')).toBe(false);
		expect(rejectsOversizeNql('a'.repeat(2048))).toBe(false);
	});

	it('rejects above the cap', () => {
		expect(rejectsOversizeNql('a'.repeat(2049))).toBe(true);
	});
});

describe('validatePayload', () => {
	const baseValid: HashPayloadV1 = {
		v: 1,
		s: 'table users {\n  id: uuid pk\n  name: string\n}\n',
		n: 'users {| name |}',
		m: 'nql',
	};

	it('accepts a well-formed v1 payload', () => {
		expect(validatePayload(baseValid)).toEqual({ ok: true, payload: baseValid });
	});

	it('rejects unknown version with reason "version"', () => {
		const result = validatePayload({ ...baseValid, v: 99 } as unknown as HashPayloadV1);
		expect(result).toEqual({ ok: false, reason: 'version' });
	});

	it('rejects unknown mode with reason "version"', () => {
		const result = validatePayload({
			...baseValid,
			m: 'ts',
		} as unknown as HashPayloadV1);
		expect(result).toEqual({ ok: false, reason: 'version' });
	});

	it('rejects oversize schema with reason "size"', () => {
		const result = validatePayload({
			...baseValid,
			s: 'a'.repeat(9 * 1024),
		});
		expect(result).toEqual({ ok: false, reason: 'size' });
	});

	it('rejects oversize NQL with reason "size"', () => {
		const result = validatePayload({
			...baseValid,
			n: 'a'.repeat(3 * 1024),
		});
		expect(result).toEqual({ ok: false, reason: 'size' });
	});

	it('rejects schema with unsafe identifier with reason "identifier"', () => {
		const result = validatePayload({
			...baseValid,
			s: 'table users {\n  1id: uuid pk\n  name: string\n}\n',
		});
		expect(result).toEqual({ ok: false, reason: 'identifier' });
	});

	it('rejects schema with bad table name with reason "identifier"', () => {
		const result = validatePayload({
			...baseValid,
			s: 'table users; DROP {\n  id: uuid pk\n}\n',
		});
		expect(result).toEqual({ ok: false, reason: 'identifier' });
	});

	it('rejects non-object input with reason "shape"', () => {
		expect(validatePayload(null)).toEqual({ ok: false, reason: 'shape' });
		expect(validatePayload('string')).toEqual({ ok: false, reason: 'shape' });
		expect(validatePayload(42)).toEqual({ ok: false, reason: 'shape' });
	});

	it('rejects missing fields with reason "shape"', () => {
		expect(validatePayload({ v: 1, s: 'x' })).toEqual({ ok: false, reason: 'shape' });
	});
});
