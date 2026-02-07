import { describe, expect, it } from 'vitest';
import {
	expandDateRange,
	InvalidDateRangeError,
	isDateRangePattern,
} from './date-range-patterns.js';

describe('expandDateRange', () => {
	describe('YYYY — full year', () => {
		it('expands 2024 to [2024-01-01, 2025-01-01)', () => {
			// Arrange & Act
			const result = expandDateRange('2024');

			// Assert
			expect(result.start).toBe('2024-01-01');
			expect(result.end).toBe('2025-01-01');
		});

		it('expands 2000 (boundary year)', () => {
			const result = expandDateRange('2000');
			expect(result.start).toBe('2000-01-01');
			expect(result.end).toBe('2001-01-01');
		});
	});

	describe('YYYY-QN — quarter', () => {
		it('expands Q1 to [Jan 1, Apr 1)', () => {
			const result = expandDateRange('2024-Q1');
			expect(result.start).toBe('2024-01-01');
			expect(result.end).toBe('2024-04-01');
		});

		it('expands Q2 to [Apr 1, Jul 1)', () => {
			const result = expandDateRange('2024-Q2');
			expect(result.start).toBe('2024-04-01');
			expect(result.end).toBe('2024-07-01');
		});

		it('expands Q3 to [Jul 1, Oct 1)', () => {
			const result = expandDateRange('2024-Q3');
			expect(result.start).toBe('2024-07-01');
			expect(result.end).toBe('2024-10-01');
		});

		it('expands Q4 to [Oct 1, next Jan 1)', () => {
			const result = expandDateRange('2024-Q4');
			expect(result.start).toBe('2024-10-01');
			expect(result.end).toBe('2025-01-01');
		});
	});

	describe('YYYY-MM — month', () => {
		it('expands January', () => {
			const result = expandDateRange('2024-01');
			expect(result.start).toBe('2024-01-01');
			expect(result.end).toBe('2024-02-01');
		});

		it('expands June', () => {
			const result = expandDateRange('2024-06');
			expect(result.start).toBe('2024-06-01');
			expect(result.end).toBe('2024-07-01');
		});

		it('expands December (crosses year boundary)', () => {
			const result = expandDateRange('2024-12');
			expect(result.start).toBe('2024-12-01');
			expect(result.end).toBe('2025-01-01');
		});

		it('rejects month 00', () => {
			expect(() => expandDateRange('2024-00')).toThrow(InvalidDateRangeError);
			expect(() => expandDateRange('2024-00')).toThrow(/must be 01-12/);
		});

		it('rejects month 13', () => {
			expect(() => expandDateRange('2024-13')).toThrow(InvalidDateRangeError);
			expect(() => expandDateRange('2024-13')).toThrow(/must be 01-12/);
		});
	});

	describe('YYYY-WNN — ISO 8601 week', () => {
		it('expands W01 of 2024 (starts Dec 31 2023 — ISO week rule)', () => {
			const result = expandDateRange('2024-W01');
			// 2024-01-01 is Monday → W01 starts on 2024-01-01
			expect(result.start).toBe('2024-01-01');
			expect(result.end).toBe('2024-01-08');
		});

		it('expands W10', () => {
			const result = expandDateRange('2024-W10');
			// W10 of 2024: starts 2024-03-04
			expect(result.start).toBe('2024-03-04');
			expect(result.end).toBe('2024-03-11');
		});

		it('rejects W00', () => {
			expect(() => expandDateRange('2024-W00')).toThrow(InvalidDateRangeError);
		});

		it('rejects W54', () => {
			expect(() => expandDateRange('2024-W54')).toThrow(InvalidDateRangeError);
		});

		it('accepts W53 for years with 53 weeks', () => {
			// 2015 has 53 ISO weeks (Jan 1 is Thursday)
			const result = expandDateRange('2015-W53');
			expect(result.start).toBe('2015-12-28');
			expect(result.end).toBe('2016-01-04');
		});

		it('rejects W53 for years with only 52 weeks', () => {
			// 2024 has 52 ISO weeks
			expect(() => expandDateRange('2024-W53')).toThrow(InvalidDateRangeError);
			expect(() => expandDateRange('2024-W53')).toThrow(/52 ISO weeks/);
		});
	});

	describe('invalid patterns', () => {
		it('rejects non-date strings', () => {
			expect(() => expandDateRange('not-a-date')).toThrow(
				InvalidDateRangeError,
			);
		});

		it('rejects Q5', () => {
			// Q5 doesn't match DATE_RANGE_QUARTER regex (only 1-4)
			expect(() => expandDateRange('2024-Q5')).toThrow(InvalidDateRangeError);
		});

		it('rejects empty string', () => {
			expect(() => expandDateRange('')).toThrow(InvalidDateRangeError);
		});
	});
});

describe('isDateRangePattern', () => {
	it('matches YYYY', () => {
		expect(isDateRangePattern('2024')).toBe(true);
	});

	it('matches YYYY-QN', () => {
		expect(isDateRangePattern('2024-Q1')).toBe(true);
		expect(isDateRangePattern('2024-Q4')).toBe(true);
	});

	it('matches YYYY-MM', () => {
		expect(isDateRangePattern('2024-01')).toBe(true);
		expect(isDateRangePattern('2024-12')).toBe(true);
	});

	it('matches YYYY-WNN', () => {
		expect(isDateRangePattern('2024-W01')).toBe(true);
		expect(isDateRangePattern('2024-W53')).toBe(true);
	});

	it('rejects non-date strings', () => {
		expect(isDateRangePattern('pending')).toBe(false);
		expect(isDateRangePattern('hello')).toBe(false);
		expect(isDateRangePattern('')).toBe(false);
	});

	it('rejects Q5 (regex only allows 1-4)', () => {
		expect(isDateRangePattern('2024-Q5')).toBe(false);
	});
});
