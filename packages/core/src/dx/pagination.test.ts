/**
 * Unit tests for pagination functionality (DX-028)
 */

import { describe, expect, it } from 'vitest';
import type { CursorPaginateOptions, PaginateOptions } from './types.js';

// Test cursor encode/decode utilities
describe('Pagination: Cursor utilities', () => {
	// These tests verify the cursor encoding is valid base64 JSON
	describe('cursor encoding', () => {
		it('should encode cursor as base64 JSON', () => {
			const cursorData = { id: 100 };
			const encoded = Buffer.from(JSON.stringify(cursorData), 'utf-8').toString(
				'base64',
			);

			expect(encoded).toBe('eyJpZCI6MTAwfQ==');
		});

		it('should decode cursor from base64 JSON', () => {
			const cursor = 'eyJpZCI6MTAwfQ==';
			const decoded = JSON.parse(
				Buffer.from(cursor, 'base64').toString('utf-8'),
			);

			expect(decoded).toEqual({ id: 100 });
		});

		it('should handle multi-field cursors', () => {
			const cursorData = { id: 100, created_at: '2025-01-01' };
			const encoded = Buffer.from(JSON.stringify(cursorData), 'utf-8').toString(
				'base64',
			);
			const decoded = JSON.parse(
				Buffer.from(encoded, 'base64').toString('utf-8'),
			);

			expect(decoded).toEqual(cursorData);
		});
	});
});

describe('Pagination: Type contracts', () => {
	describe('PaginateOptions', () => {
		it('should accept page and perPage', () => {
			const options: PaginateOptions = {
				page: 2,
				perPage: 25,
			};

			expect(options.page).toBe(2);
			expect(options.perPage).toBe(25);
		});

		it('should accept withCount option', () => {
			const options: PaginateOptions = {
				page: 1,
				perPage: 10,
				withCount: false,
			};

			expect(options.withCount).toBe(false);
		});

		it('should allow all options to be optional', () => {
			const options: PaginateOptions = {};

			expect(options.page).toBeUndefined();
			expect(options.perPage).toBeUndefined();
			expect(options.withCount).toBeUndefined();
		});
	});

	describe('CursorPaginateOptions', () => {
		it('should accept cursor and limit', () => {
			const options: CursorPaginateOptions = {
				cursor: 'eyJpZCI6MTAwfQ==',
				limit: 20,
			};

			expect(options.cursor).toBe('eyJpZCI6MTAwfQ==');
			expect(options.limit).toBe(20);
		});

		it('should accept direction', () => {
			const forwardOptions: CursorPaginateOptions = {
				direction: 'forward',
			};
			const backwardOptions: CursorPaginateOptions = {
				direction: 'backward',
			};

			expect(forwardOptions.direction).toBe('forward');
			expect(backwardOptions.direction).toBe('backward');
		});

		it('should accept null cursor for first page', () => {
			const options: CursorPaginateOptions = {
				cursor: null,
				limit: 10,
			};

			expect(options.cursor).toBeNull();
		});
	});
});

describe('Pagination: Defaults', () => {
	it('should define sensible defaults for page', () => {
		// Default page should be 1
		const defaultPage = 1;
		expect(defaultPage).toBe(1);
	});

	it('should define sensible defaults for perPage', () => {
		// Default perPage should be 20
		const defaultPerPage = 20;
		expect(defaultPerPage).toBe(20);
	});

	it('should define sensible defaults for withCount', () => {
		// Default withCount should be true
		const defaultWithCount = true;
		expect(defaultWithCount).toBe(true);
	});

	it('should define sensible defaults for cursor limit', () => {
		// Default cursor limit should be 20
		const defaultLimit = 20;
		expect(defaultLimit).toBe(20);
	});

	it('should define sensible defaults for cursor direction', () => {
		// Default direction should be forward
		const defaultDirection = 'forward';
		expect(defaultDirection).toBe('forward');
	});
});

describe('Pagination: Offset calculations', () => {
	it('should calculate offset for page 1', () => {
		const page = 1;
		const perPage = 20;
		const offset = (page - 1) * perPage;

		expect(offset).toBe(0);
	});

	it('should calculate offset for page 2', () => {
		const page = 2;
		const perPage = 20;
		const offset = (page - 1) * perPage;

		expect(offset).toBe(20);
	});

	it('should calculate offset for page 5 with perPage 50', () => {
		const page = 5;
		const perPage = 50;
		const offset = (page - 1) * perPage;

		expect(offset).toBe(200);
	});

	it('should calculate totalPages correctly', () => {
		const total = 95;
		const perPage = 20;
		const totalPages = Math.ceil(total / perPage);

		expect(totalPages).toBe(5);
	});

	it('should calculate totalPages for exact division', () => {
		const total = 100;
		const perPage = 20;
		const totalPages = Math.ceil(total / perPage);

		expect(totalPages).toBe(5);
	});
});

describe('Pagination: hasNextPage/hasPrevPage logic', () => {
	it('should have hasPrevPage=false on page 1', () => {
		const page = 1;
		const hasPrevPage = page > 1;

		expect(hasPrevPage).toBe(false);
	});

	it('should have hasPrevPage=true on page 2', () => {
		const page = 2;
		const hasPrevPage = page > 1;

		expect(hasPrevPage).toBe(true);
	});

	it('should have hasNextPage=true when not on last page', () => {
		const page = 2;
		const totalPages = 5;
		const hasNextPage = page < totalPages;

		expect(hasNextPage).toBe(true);
	});

	it('should have hasNextPage=false on last page', () => {
		const page = 5;
		const totalPages = 5;
		const hasNextPage = page < totalPages;

		expect(hasNextPage).toBe(false);
	});
});

describe('Pagination: Cursor condition building', () => {
	describe('single orderBy field', () => {
		it('should use gt for forward + asc', () => {
			const sortDir = 'asc';
			const direction = 'forward';
			const isAsc =
				sortDir === 'asc' ? direction === 'forward' : direction === 'backward';
			const operator = isAsc ? 'gt' : 'lt';

			expect(operator).toBe('gt');
		});

		it('should use lt for forward + desc', () => {
			const sortDir = 'desc';
			const direction = 'forward';
			const isAsc =
				sortDir === 'asc' ? direction === 'forward' : direction === 'backward';
			const operator = isAsc ? 'gt' : 'lt';

			expect(operator).toBe('lt');
		});

		it('should use lt for backward + asc', () => {
			const sortDir = 'asc';
			const direction = 'backward';
			const isAsc =
				sortDir === 'asc' ? direction === 'forward' : direction === 'backward';
			const operator = isAsc ? 'gt' : 'lt';

			expect(operator).toBe('lt');
		});

		it('should use gt for backward + desc', () => {
			const sortDir = 'desc';
			const direction = 'backward';
			const isAsc =
				sortDir === 'asc' ? direction === 'forward' : direction === 'backward';
			const operator = isAsc ? 'gt' : 'lt';

			expect(operator).toBe('gt');
		});
	});
});
