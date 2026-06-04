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

	it('returns false when model is null (isolated branch — definition + tableNames present)', () => {
		expect(
			isValidSchema({
				definition: {},
				model: null,
				tableNames: [],
			}),
		).toBe(false);
	});

	it('returns false when model lacks tables/relations (isolated branch — definition + tableNames present)', () => {
		expect(
			isValidSchema({
				definition: {},
				model: {},
				tableNames: [],
			}),
		).toBe(false);
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

	it('returns false when model has tables+relations but is missing required ModelIR methods', () => {
		expect(
			isValidSchema({
				definition: {},
				model: { tables: {}, relations: {} },
				tableNames: [],
			}),
		).toBe(false);
	});

	it('returns false when model is missing getTable method', () => {
		expect(
			isValidSchema({
				definition: {},
				model: {
					tables: new Map(),
					relations: new Map(),
					getRelation: () => undefined,
					getRelationsFrom: () => [],
					getRelationsTo: () => [],
					isAmbiguous: () => ({ ambiguous: false }),
				},
				tableNames: [],
			}),
		).toBe(false);
	});

	it('returns false when model is missing getRelation method', () => {
		expect(
			isValidSchema({
				definition: {},
				model: {
					tables: new Map(),
					relations: new Map(),
					getTable: () => undefined,
					getRelationsFrom: () => [],
					getRelationsTo: () => [],
					isAmbiguous: () => ({ ambiguous: false }),
				},
				tableNames: [],
			}),
		).toBe(false);
	});

	it('returns false when model is missing getRelationsFrom method', () => {
		expect(
			isValidSchema({
				definition: {},
				model: {
					tables: new Map(),
					relations: new Map(),
					getTable: () => undefined,
					getRelation: () => undefined,
					getRelationsTo: () => [],
					isAmbiguous: () => ({ ambiguous: false }),
				},
				tableNames: [],
			}),
		).toBe(false);
	});

	it('returns false when model is missing getRelationsTo method', () => {
		expect(
			isValidSchema({
				definition: {},
				model: {
					tables: new Map(),
					relations: new Map(),
					getTable: () => undefined,
					getRelation: () => undefined,
					getRelationsFrom: () => [],
					isAmbiguous: () => ({ ambiguous: false }),
				},
				tableNames: [],
			}),
		).toBe(false);
	});

	it('returns false when model is missing isAmbiguous method', () => {
		expect(
			isValidSchema({
				definition: {},
				model: {
					tables: new Map(),
					relations: new Map(),
					getTable: () => undefined,
					getRelation: () => undefined,
					getRelationsFrom: () => [],
					getRelationsTo: () => [],
				},
				tableNames: [],
			}),
		).toBe(false);
	});

	it('returns true for a full ModelIR-conformant schema shape', () => {
		const valid = {
			definition: {},
			model: {
				tables: new Map(),
				relations: new Map(),
				getTable: () => undefined,
				getRelation: () => undefined,
				getRelationsFrom: () => [],
				getRelationsTo: () => [],
				isAmbiguous: () => ({ ambiguous: false as const }),
			},
			tableNames: [] as string[],
		};
		expect(isValidSchema(valid)).toBe(true);
	});

	it('narrows the type — .model.tables is accessible after guard', () => {
		const x: unknown = {
			definition: {},
			model: {
				tables: new Map([['users', {}]]),
				relations: new Map(),
				getTable: () => undefined,
				getRelation: () => undefined,
				getRelationsFrom: () => [],
				getRelationsTo: () => [],
				isAmbiguous: () => ({ ambiguous: false as const }),
			},
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
