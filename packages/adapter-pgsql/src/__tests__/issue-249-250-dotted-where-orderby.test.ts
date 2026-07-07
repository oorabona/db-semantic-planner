import { any, createOrm, inArray, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const testSchema = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		file_id: ref('files', { as: 'file', inverse: 'symbols' }),
		start_line: { type: 'integer' },
	},
	files: {
		id: { type: 'integer', primaryKey: true },
		project_id: { type: 'integer' },
	},
} as const);

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

describe('FIX-250: dotted relation WHERE with any()/inArray()', () => {
	it('any() against an include join lowers to EXISTS and preserves values', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.include('file', { join: 'inner' })
			.where(any('file.project_id', [1, 2, 3]))
			.columns(['id'])
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.id, file.id AS "file.id" FROM symbols JOIN files AS file ON symbols.file_id = file.id WHERE EXISTS (SELECT 1 FROM files AS files_exists_1 WHERE symbols.file_id = files_exists_1.id AND files_exists_1.project_id = ANY (CAST($1 AS int4[])))',
		);
		expect(dump.params).toEqual([[1, 2, 3]]);
	});

	it('inArray() against an include join lowers to EXISTS and preserves values', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.include('file', { join: 'inner' })
			.where(inArray('file.project_id', [1, 2, 3]))
			.columns(['id'])
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.id, file.id AS "file.id" FROM symbols JOIN files AS file ON symbols.file_id = file.id WHERE EXISTS (SELECT 1 FROM files AS files_exists_1 WHERE symbols.file_id = files_exists_1.id AND files_exists_1.project_id = ANY ($1))',
		);
		expect(dump.params).toEqual([[1, 2, 3]]);
	});

	it('implicit relation filter still lowers to EXISTS and preserves any() values', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.where(any('file.project_id', [1, 2, 3]))
			.columns(['id'])
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.id FROM symbols WHERE EXISTS (SELECT 1 FROM files AS files_exists_0 WHERE symbols.file_id = files_exists_0.id AND files_exists_0.project_id = ANY (CAST($1 AS int4[])))',
		);
		expect(dump.params).toEqual([[1, 2, 3]]);
	});

	it('root-column any() remains unchanged', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.where(any('file_id', [1, 2, 3]))
			.columns(['id'])
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.id FROM symbols WHERE symbols.file_id = ANY (CAST($1 AS int4[]))',
		);
		expect(dump.params).toEqual([[1, 2, 3]]);
	});

	it('root-column inArray() remains unchanged', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.where(inArray('file_id', [1, 2, 3]))
			.columns(['id'])
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.id FROM symbols WHERE symbols.file_id = ANY ($1)',
		);
		expect(dump.params).toEqual([[1, 2, 3]]);
	});
});

describe('FIX-249: orderBy dotted string', () => {
	it('orders by a dotted relation column through the join alias', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbols')
			.include('file', { join: 'inner' })
			.columns(['id'])
			.orderBy('file.project_id')
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.id, file.id AS "file.id" FROM symbols JOIN files AS file ON symbols.file_id = file.id ORDER BY file.project_id ASC',
		);
		expect(dump.params).toEqual([]);
	});

	it('root-column orderBy remains unchanged', () => {
		const orm = buildOrm();
		const dump = orm.select('symbols').columns(['id']).orderBy('id').dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.id FROM symbols ORDER BY symbols.id ASC',
		);
		expect(dump.params).toEqual([]);
	});
});
