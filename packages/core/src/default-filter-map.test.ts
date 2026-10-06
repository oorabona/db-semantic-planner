import { describe, expect, it } from 'vitest';
import { copyDefaultFilters, getDefaultFilter } from './default-filter-map.js';
import { isNull } from './dx/filters.js';

describe('default filter maps', () => {
	it('copies only own filters to a null-prototype map after exclusions', () => {
		const inherited = isNull('hidden');
		const posts = isNull('deletedAt');
		const filters = Object.assign(Object.create({ toString: inherited }), {
			posts,
			users: posts,
		});
		const copied = copyDefaultFilters(filters, (table) => table !== 'users');
		expect(Object.getPrototypeOf(copied)).toBeNull();
		expect(Object.keys(copied)).toEqual(['posts']);
		expect(getDefaultFilter(copied, 'posts')).toBe(posts);
		expect(getDefaultFilter(filters, 'toString')).toBeUndefined();
		expect(getDefaultFilter(copied, 'toString')).toBeUndefined();
	});
	it('retains deliberately configured prototype-named tables', () => {
		const filter = isNull('deletedAt');
		const copied = copyDefaultFilters({
			toString: filter,
			['__proto__']: filter,
		});
		expect(Object.getPrototypeOf(copied)).toBeNull();
		expect(getDefaultFilter(copied, 'toString')).toBe(filter);
		expect(getDefaultFilter(copied, '__proto__')).toBe(filter);
	});
});
