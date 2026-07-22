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

const typedCastSchema = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true, dbType: 'integer' },
		name: { type: 'string', dbType: 'text' },
		file_id: ref('files', { as: 'file', inverse: 'symbols' }),
	},
	files: {
		id: { type: 'integer', primaryKey: true, dbType: 'integer' },
		project_id: { type: 'integer', dbType: 'integer' },
	},
} as const);

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

function buildTypedCastOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({
		model: typedCastSchema.model,
	});
	return createOrm({ model: typedCastSchema.model, adapter });
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

describe('FIX-347: any() array casts use resolved column DB type', () => {
	it('casts string values to integer[] for an integer root column', () => {
		const orm = buildTypedCastOrm();
		const dump = orm
			.select('symbols')
			.where(any('id', ['1', '2']))
			.columns(['id'])
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.id FROM symbols WHERE symbols.id = ANY (CAST($1 AS integer[]))',
		);
		expect(dump.params).toEqual([['1', '2']]);
	});

	it('casts empty arrays to integer[] for an integer root column', () => {
		const orm = buildTypedCastOrm();
		const dump = orm
			.select('symbols')
			.where(any('id', []))
			.columns(['id'])
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.id FROM symbols WHERE symbols.id = ANY (CAST($1 AS integer[]))',
		);
		expect(dump.params).toEqual([[]]);
	});

	it('casts mixed-null arrays to integer[] for an integer root column', () => {
		const orm = buildTypedCastOrm();
		const values = [null, '1', undefined];
		const dump = orm
			.select('symbols')
			.where(any('id', values))
			.columns(['id'])
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.id FROM symbols WHERE symbols.id = ANY (CAST($1 AS integer[]))',
		);
		expect(dump.params).toEqual([values]);
	});

	it('keeps string values as text[] for a text root column', () => {
		const orm = buildTypedCastOrm();
		const dump = orm
			.select('symbols')
			.where(any('name', ['alpha', 'beta']))
			.columns(['name'])
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.name FROM symbols WHERE symbols.name = ANY (CAST($1 AS text[]))',
		);
		expect(dump.params).toEqual([['alpha', 'beta']]);
	});

	it('casts dotted relation string values by the related integer column type', () => {
		const orm = buildTypedCastOrm();
		const dump = orm
			.select('symbols')
			.where(any('file.project_id', ['1']))
			.columns(['id'])
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.id FROM symbols WHERE EXISTS (SELECT 1 FROM files AS files_exists_0 WHERE symbols.file_id = files_exists_0.id AND files_exists_0.project_id = ANY (CAST($1 AS integer[])))',
		);
		expect(dump.params).toEqual([['1']]);
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

describe('FIX-347: any() casts by the declared column type when dbType is absent', () => {
	// A manually defined schema declares `type` but not `dbType`, so no
	// originalDbType is populated (this is how astix defines its schema). The
	// array element type must come from the declared ColumnType, not runtime value
	// sniffing — otherwise ids that read back from PostgreSQL as JS strings emit
	// `col = ANY($1::text[])` and PostgreSQL rejects `integer = text`.
	const manualSchema = schema({
		rows: {
			id: { type: 'integer', primaryKey: true },
			big: { type: 'bigint' },
			label: { type: 'text' },
		},
	});
	function buildManualOrm() {
		const adapter = createPgsqlCompileOnlyAdapter({
			model: manualSchema.model,
		});
		return createOrm({ model: manualSchema.model, adapter });
	}

	it('casts string values to int4[] for an integer column declared without dbType', () => {
		const dump = buildManualOrm()
			.select('rows')
			.where(any('id', ['1', '2']))
			.columns(['id'])
			.dump();
		expect(ws(dump.sql)).toEqual(
			'SELECT rows.id FROM rows WHERE rows.id = ANY (CAST($1 AS int4[]))',
		);
		expect(dump.params).toEqual([['1', '2']]);
	});

	it('casts string values to int8[] for a bigint column declared without dbType', () => {
		const dump = buildManualOrm()
			.select('rows')
			.where(any('big', ['1', '2']))
			.columns(['id'])
			.dump();
		expect(ws(dump.sql)).toEqual(
			'SELECT rows.id FROM rows WHERE rows.big = ANY (CAST($1 AS int8[]))',
		);
	});

	it('keeps text[] for a text column declared without dbType', () => {
		const dump = buildManualOrm()
			.select('rows')
			.where(any('label', ['a', 'b']))
			.columns(['id'])
			.dump();
		expect(ws(dump.sql)).toEqual(
			'SELECT rows.id FROM rows WHERE rows.label = ANY (CAST($1 AS text[]))',
		);
	});
});
