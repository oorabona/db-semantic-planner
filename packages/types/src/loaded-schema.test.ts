import { describe, expect, it } from 'vitest';
import type { LoadedSchema } from './loaded-schema.js';
import { isValidSchema } from './loaded-schema.js';

describe('isValidSchema', () => {
	it('returns false for null', () => {
		expect(isValidSchema(null)).toBe(false);
	});

	it('returns false for undefined', () => {
		expect(isValidSchema(undefined)).toBe(false);
	});

	it('returns false for empty object', () => {
		expect(isValidSchema({})).toBe(false);
	});

	it('returns false when model is null', () => {
		expect(isValidSchema({ model: null })).toBe(false);
	});

	it('returns false when model lacks tables/relations', () => {
		expect(isValidSchema({ definition: {}, model: {} })).toBe(false);
	});

	it('returns false when tableNames is missing', () => {
		expect(
			isValidSchema({
				definition: {},
				model: { tables: {}, relations: {} },
			}),
		).toBe(false);
	});

	it('returns false when tableNames is not an array', () => {
		expect(
			isValidSchema({
				definition: {},
				model: { tables: {}, relations: {} },
				tableNames: 'not-an-array',
			}),
		).toBe(false);
	});

	it('returns true for a valid schema shape', () => {
		const valid = {
			definition: {},
			model: { tables: {}, relations: {} },
			tableNames: [],
		};
		expect(isValidSchema(valid)).toBe(true);
	});

	it('narrows the type — .model.tables is accessible after guard', () => {
		const x: unknown = {
			definition: {},
			model: { tables: { users: {} }, relations: {} },
			tableNames: ['users'],
		};
		if (isValidSchema(x)) {
			// TypeScript must not error on .model.tables access
			const tables: LoadedSchema['model']['tables'] = x.model.tables;
			expect(tables).toBeDefined();
		} else {
			// Should not reach here for valid input
			expect.fail('isValidSchema returned false for valid input');
		}
	});
});
