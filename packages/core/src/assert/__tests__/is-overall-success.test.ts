import { describe, expect, it } from 'vitest';
import { isOverallSuccess } from '../types.js';

describe('isOverallSuccess', () => {
	it('returns false when compile failed (dbSuccess undefined)', () => {
		expect(isOverallSuccess({ success: false })).toBe(false);
	});
	it('returns false when compile failed (dbSuccess true)', () => {
		expect(isOverallSuccess({ success: false, dbSuccess: true })).toBe(false);
	});
	it('returns false when compile failed (dbSuccess false)', () => {
		expect(isOverallSuccess({ success: false, dbSuccess: false })).toBe(false);
	});
	it('returns true when compile succeeded and dbSuccess undefined (compile-only mode)', () => {
		expect(isOverallSuccess({ success: true })).toBe(true);
	});
	it('returns true when compile succeeded and DB executed cleanly', () => {
		expect(isOverallSuccess({ success: true, dbSuccess: true })).toBe(true);
	});
	it('returns false when compile succeeded but DB execution failed', () => {
		expect(isOverallSuccess({ success: true, dbSuccess: false })).toBe(false);
	});
	it('does not throw when fed `null` dbSuccess (contract: producers must omit or use real boolean — null is undefined behavior)', () => {
		// Hardening guard: the helper must remain safe to call even if a
		// non-conforming producer passes null. We do NOT lock the truthiness
		// verdict — a future tightening (e.g. treating null as failure) is
		// allowed. See JSDoc on isOverallSuccess for the contract.
		expect(() =>
			isOverallSuccess({ success: true, dbSuccess: null as unknown as undefined }),
		).not.toThrow();
	});
});
