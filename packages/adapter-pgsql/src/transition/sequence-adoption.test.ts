import { describe, expect, it, vi } from 'vitest';
import { pgDeclaredSequenceAdoptionShapeMatches } from './sequence-adoption.js';

const declared = { name: 'union_group_seq' };
const matchingRow = {
	start_with: '1',
	increment_by: '1',
	min_value: '1',
	max_value: '9223372036854775807',
	cycle: false,
};

describe('pgDeclaredSequenceAdoptionShapeMatches', () => {
	it('matches exact standalone bigint sequence options without reading state', async () => {
		const sql: string[] = [];
		const query = vi.fn(async (statement: string) => {
			sql.push(statement);
			return { rows: [matchingRow] };
		});
		await expect(
			pgDeclaredSequenceAdoptionShapeMatches(
				{ query },
				'tenant',
				'union_group_seq',
				declared,
			),
		).resolves.toBe(true);
		expect(sql).toHaveLength(1);
		expect(sql[0]).not.toContain('last_value');
		expect(sql[0]).not.toContain('is_called');
	});

	it.each([
		['start', { ...matchingRow, start_with: '2' }],
		['increment', { ...matchingRow, increment_by: '2' }],
		['minimum', { ...matchingRow, min_value: '0' }],
		['maximum', { ...matchingRow, max_value: '8' }],
		['cycle', { ...matchingRow, cycle: true }],
		['non-bigint type', undefined],
		['cache greater than one', undefined],
		['OWNED BY sequence', undefined],
		['identity sequence', undefined],
	])('refuses %s', async (_reason, row) => {
		await expect(
			pgDeclaredSequenceAdoptionShapeMatches(
				{
					query: vi.fn(async () => ({ rows: row === undefined ? [] : [row] })),
				},
				'tenant',
				'union_group_seq',
				declared,
			),
		).resolves.toBe(false);
	});
});
