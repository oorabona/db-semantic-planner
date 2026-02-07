/**
 * @module compiler/date-range-patterns
 * Date range pattern detection and expansion for IN (dateRange) clauses.
 *
 * Supports: YYYY, YYYY-QN, YYYY-MM, YYYY-WNN
 * Expansion: always half-open intervals [start, end) — >= start AND < end.
 */

export const DATE_RANGE_YEAR = /^(\d{4})$/;
export const DATE_RANGE_QUARTER = /^(\d{4})-Q([1-4])$/;
export const DATE_RANGE_MONTH = /^(\d{4})-(\d{2})$/;
export const DATE_RANGE_WEEK = /^(\d{4})-W(\d{2})$/;

/**
 * Check if a string matches any date range pattern (YYYY, YYYY-QN, YYYY-MM, YYYY-WNN).
 * Does NOT validate ranges (e.g., month 13 would return true).
 * Use `expandDateRange()` for full validation.
 */
export function isDateRangePattern(value: string): boolean {
	return (
		DATE_RANGE_YEAR.test(value) ||
		DATE_RANGE_QUARTER.test(value) ||
		DATE_RANGE_MONTH.test(value) ||
		DATE_RANGE_WEEK.test(value)
	);
}

export class InvalidDateRangeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidDateRangeError';
	}
}

/**
 * Expand a date range pattern into half-open interval [start, end).
 *
 * @returns `{ start, end }` where the interval is >= start AND < end.
 * @throws InvalidDateRangeError for invalid patterns.
 */
export function expandDateRange(pattern: string): {
	start: string;
	end: string;
} {
	let match: RegExpMatchArray | null;

	// YYYY → full year
	match = pattern.match(DATE_RANGE_YEAR);
	if (match) {
		const year = Number(match[1]);
		return {
			start: `${year}-01-01`,
			end: `${year + 1}-01-01`,
		};
	}

	// YYYY-QN → quarter
	match = pattern.match(DATE_RANGE_QUARTER);
	if (match) {
		const year = Number(match[1]);
		const quarter = Number(match[2]);
		const startMonth = (quarter - 1) * 3 + 1;
		const endMonth = startMonth + 3;
		if (endMonth > 12) {
			return {
				start: `${year}-${pad(startMonth)}-01`,
				end: `${year + 1}-01-01`,
			};
		}
		return {
			start: `${year}-${pad(startMonth)}-01`,
			end: `${year}-${pad(endMonth)}-01`,
		};
	}

	// YYYY-MM → month
	match = pattern.match(DATE_RANGE_MONTH);
	if (match) {
		const year = Number(match[1]);
		const month = Number(match[2]);
		if (month < 1 || month > 12) {
			throw new InvalidDateRangeError(
				`Invalid month '${match[2]}' in date range '${pattern}' — must be 01-12`,
			);
		}
		if (month === 12) {
			return {
				start: `${year}-12-01`,
				end: `${year + 1}-01-01`,
			};
		}
		return {
			start: `${year}-${pad(month)}-01`,
			end: `${year}-${pad(month + 1)}-01`,
		};
	}

	// YYYY-WNN → ISO 8601 week
	match = pattern.match(DATE_RANGE_WEEK);
	if (match) {
		const year = Number(match[1]);
		const week = Number(match[2]);
		const maxWeeks = getISOWeekCount(year);
		if (week < 1 || week > maxWeeks) {
			throw new InvalidDateRangeError(
				`Invalid week 'W${match[2]}' in date range '${pattern}' — year ${year} has ${maxWeeks} ISO weeks`,
			);
		}
		const start = isoWeekToDate(year, week);
		const end = addDays(start, 7);
		return {
			start: formatDate(start),
			end: formatDate(end),
		};
	}

	throw new InvalidDateRangeError(
		`Invalid date range '${pattern}' — expected YYYY, YYYY-QN, YYYY-MM, or YYYY-WNN`,
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pad(n: number): string {
	return n < 10 ? `0${n}` : `${n}`;
}

function formatDate(d: Date): string {
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function addDays(d: Date, days: number): Date {
	const result = new Date(d.getTime());
	result.setUTCDate(result.getUTCDate() + days);
	return result;
}

/**
 * ISO 8601 week-to-date: Monday of week W in year Y.
 * W01 contains the year's first Thursday (= contains January 4th).
 */
function isoWeekToDate(year: number, week: number): Date {
	// January 4th is always in ISO week 1
	const jan4 = new Date(Date.UTC(year, 0, 4));
	// Day of week (Mon=1..Sun=7 in ISO)
	const jan4Dow = jan4.getUTCDay() || 7; // Convert Sunday=0 to 7
	// Monday of week 1
	const mondayW1 = new Date(jan4.getTime());
	mondayW1.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1));
	// Monday of week N
	const result = new Date(mondayW1.getTime());
	result.setUTCDate(mondayW1.getUTCDate() + (week - 1) * 7);
	return result;
}

/**
 * Number of ISO 8601 weeks in a year.
 * A year has 53 weeks if Jan 1 is Thursday, or Dec 31 is Thursday.
 * (Leap years: Jan 1 is Thursday or Wednesday → 53 weeks)
 */
function getISOWeekCount(year: number): number {
	const jan1 = new Date(Date.UTC(year, 0, 1));
	const dec31 = new Date(Date.UTC(year, 11, 31));
	const jan1Dow = jan1.getUTCDay();
	const dec31Dow = dec31.getUTCDay();
	// Thursday = 4
	return jan1Dow === 4 || dec31Dow === 4 ? 53 : 52;
}
