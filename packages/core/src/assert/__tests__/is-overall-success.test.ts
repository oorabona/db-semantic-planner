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
	it('does not throw when fed `null` dbSuccess (non-conforming producer)', () => {
		expect(() =>
			isOverallSuccess({
				success: true,
				dbSuccess: null as unknown as undefined,
			}),
		).not.toThrow();
	});
	// @public defensive contract: malformed inputs return `false` rather
	// than throwing or returning a non-boolean. See JSDoc on isOverallSuccess.
	it('returns false (no throw) when fed null', () => {
		expect(isOverallSuccess(null as unknown as { success: boolean })).toBe(false);
	});
	it('returns false (no throw) when fed undefined', () => {
		expect(
			isOverallSuccess(undefined as unknown as { success: boolean }),
		).toBe(false);
	});
	it('returns false when `success` is missing', () => {
		expect(isOverallSuccess({} as { success: boolean })).toBe(false);
	});
	it('returns false when `success` is non-boolean (truthy)', () => {
		expect(
			isOverallSuccess({ success: 'yes' } as unknown as { success: boolean }),
		).toBe(false);
	});
});
