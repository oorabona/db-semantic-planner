import type { IndexIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	hasDeclaredFkIndexAdmission,
	hasDeclaredFkIndexCoverage,
	shouldEmitAutoFkIndex,
} from './fk-index-coverage.js';

function table(overrides: Partial<TableIR> = {}): TableIR {
	return {
		name: 'files',
		columns: [
			{ name: 'id', type: 'integer', nullable: false },
			{ name: 'project_id', type: 'integer', nullable: false },
			{ name: 'path', type: 'string', nullable: false },
			{ name: 'metadata', type: 'string', nullable: true },
		],
		foreignKeys: [],
		indexes: [],
		...overrides,
	};
}

describe('hasDeclaredFkIndexCoverage', () => {
	it.each([
		[
			'leading primary-key column',
			table({ primaryKey: ['project_id', 'path'] }),
		],
		['single-column primary key', table({ primaryKey: 'project_id' })],
		[
			'leading composite index',
			table({ indexes: [{ columns: ['project_id', 'path'] }] }),
		],
		[
			'index with INCLUDE columns',
			table({ indexes: [{ columns: ['project_id'], include: ['metadata'] }] }),
		],
		[
			'unique index',
			table({ indexes: [{ columns: ['project_id'], unique: true }] }),
		],
		[
			'unique column',
			table({
				columns: [
					{
						name: 'project_id',
						type: 'integer',
						nullable: false,
						unique: true,
					},
				],
			}),
		],
	] as const)('covers by %s', (_reason, declared) => {
		expect(hasDeclaredFkIndexCoverage(declared, 'project_id')).toBe(true);
	});

	it.each([
		['non-leading composite index', { columns: ['path', 'project_id'] }],
		['partial index', { columns: ['project_id'], where: 'path IS NOT NULL' }],
		[
			'expression index',
			{ columns: ['project_id'], expressions: ['lower(path)'] },
		],
		['gin index', { columns: ['project_id'], method: 'gin' }],
		['hash index', { columns: ['project_id'], method: 'hash' }],
	] as const)('does not cover by %s', (_reason, index) => {
		expect(
			hasDeclaredFkIndexCoverage(
				table({ indexes: [index satisfies IndexIR] }),
				'project_id',
			),
		).toBe(false);
	});
});

describe('hasDeclaredFkIndexAdmission', () => {
	it.each([
		[
			'leading primary-key column',
			table({ primaryKey: ['project_id', 'path'] }),
		],
		['single-column primary key', table({ primaryKey: 'project_id' })],
		[
			'leading composite index',
			table({ indexes: [{ columns: ['project_id', 'path'] }] }),
		],
		[
			'index with INCLUDE columns',
			table({ indexes: [{ columns: ['project_id'], include: ['metadata'] }] }),
		],
		[
			'unique index',
			table({ indexes: [{ columns: ['project_id'], unique: true }] }),
		],
		[
			'unique column',
			table({
				columns: [
					{
						name: 'project_id',
						type: 'integer',
						nullable: false,
						unique: true,
					},
				],
			}),
		],
		[
			'non-leading composite index',
			table({ indexes: [{ columns: ['path', 'project_id'] }] }),
		],
		[
			'partial index',
			table({
				indexes: [{ columns: ['project_id'], where: 'path IS NOT NULL' }],
			}),
		],
		[
			'expression index',
			table({
				indexes: [{ columns: ['project_id'], expressions: ['lower(path)'] }],
			}),
		],
		[
			'gin index',
			table({ indexes: [{ columns: ['project_id'], method: 'gin' }] }),
		],
		[
			'hash index',
			table({ indexes: [{ columns: ['project_id'], method: 'hash' }] }),
		],
	] as const)(
		'matches automatic FK-index suppression for %s',
		(_reason, declared) => {
			expect(shouldEmitAutoFkIndex(declared, 'project_id') === false).toBe(
				hasDeclaredFkIndexAdmission(declared, 'project_id'),
			);
		},
	);
});
