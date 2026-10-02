import { describe, expect, it, vi } from 'vitest';
import { createOrm } from './dx/orm.js';
import { schema } from './dx/schema.js';
import { createMockAdapter } from './dx/test-utils.js';
import { inspectMutationRows } from './mutation-rows.js';

describe('inspectMutationRows', () => {
	it('orders the union by first appearance without changing input rows', () => {
		const rows = [
			{ b: undefined, a: 1 },
			{ c: 2, a: 3 },
			{ d: 4, c: 5 },
		];
		expect(inspectMutationRows(rows, { operation: 'insert' })).toEqual({
			columns: ['b', 'a', 'c', 'd'],
			heterogeneous: true,
		});
		expect(Object.hasOwn(rows[1]!, 'b')).toBe(false);
	});
	it('ignores inherited keys', () => {
		const row = Object.assign(
			Object.create({ a: 2 }) as Record<string, unknown>,
			{ b: 3 },
		);
		expect(
			inspectMutationRows([{ a: 1 }, row], { operation: 'insert' }),
		).toEqual({ columns: ['a', 'b'], heterogeneous: true });
	});
	it('checks missing row-zero keys before extra keys', () => {
		expect(() =>
			inspectMutationRows([{ b: 1, a: 2 }, { c: 3 }], {
				operation: 'upsert',
				homogeneous: true,
			}),
		).toThrow("Invalid upsert: upsert: row 1 lacks key 'b' present in row 0");
	});
	for (const operation of ['insert', 'upsert', 'update'] as const) {
		it(`resolves model validation once per ${operation} builder call`, () => {
			const db = schema({ t: { id: 'integer', a: 'integer' } } as const);
			const orm = createOrm({ schema: db, adapter: createMockAdapter() });
			const lookup = vi.spyOn(db.model, 'getTable');
			lookup.mockClear();
			const rows = [
				{ id: 1, a: 2 },
				{ a: 3, id: 4 },
			];
			if (operation === 'insert') orm.insert('t').values(rows);
			else if (operation === 'upsert') orm.upsert('t').values(rows);
			else orm.update('t').batchSet('id', rows);
			expect(lookup).toHaveBeenCalledTimes(1);
			lookup.mockRestore();
		});
	}
});
