import { createOrm, eq, param, schema } from '@dbsp/core';
import { deparseSync } from 'pgsql-deparser';
import { describe, expect, it } from 'vitest';
import { createCompilerState } from '../handlers/types.js';
import { compileUpsert } from '../index.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { queryLocal } from '../sql-identifier.js';

const db = schema({
	t: { id: { type: 'integer', primaryKey: true }, j: 'jsonb' },
});
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});

// Mutation payload types do not yet admit ExpressionRef; exercise the runtime contract.
describe('explicit null mutation parameters (#891)', () => {
	it.each([null, undefined])('update binds param(%s)', (value) => {
		const result = orm
			.modify(orm.tables.t)
			.set({ j: param(value) as never })
			.where(eq('id', 1))
			.dump();
		expect(result.sql).toBe('UPDATE t SET j = $1 WHERE t.id = $2');
		expect(result.parameters).toEqual([null, 1]);
	});
	it.each([null, undefined])('insert binds param(%s)', (value) => {
		const result = orm
			.insert('t')
			.values({ id: 1, j: param(value) as never })
			.dump();
		expect(result.sql).toBe('INSERT INTO t (id, j) VALUES ($1, $2)');
		expect(result.parameters).toEqual([1, null]);
	});
	it.each([null, undefined])('upsert binds param(%s) in VALUES', (value) => {
		const result = orm
			.upsert('t')
			.values({ id: 1, j: param(value) as never })
			.onConflict(['id'])
			.doUpdate()
			.dump();
		expect(result.sql).toBe(
			'INSERT INTO t (id, j) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET j = excluded.j',
		);
		expect(result.parameters).toEqual([1, null]);
	});
	it('upsert preserves bare undefined as NULL through the ORM', () => {
		const result = orm
			.upsert('t')
			.values({ id: 1, j: undefined as never })
			.onConflict(['id'])
			.doUpdate()
			.dump();
		expect(result.sql).toBe(
			'INSERT INTO t (id, j) VALUES ($1, NULL) ON CONFLICT (id) DO UPDATE SET j = excluded.j',
		);
		expect(result.parameters).toEqual([1]);
	});
	it.each([true, false])(
		'public compileUpsert binds every placeholder with useExcluded=%s',
		(useExcluded) => {
			const state = createCompilerState();
			const ast = compileUpsert(
				{
					table: queryLocal('t'),
					columns: ['id', 'j'].map(queryLocal),
					values: [[1, undefined]],
					conflictTarget: { columns: [queryLocal('id')] },
					conflictAction: 'update',
					updateColumns: [queryLocal('j')],
					useExcluded,
				},
				{ rootTable: 't', maxRecursiveDepth: 100 },
				state,
			);
			expect(deparseSync(ast, { pretty: false })).toBe(
				`INSERT INTO t (id, j) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET j = ${useExcluded ? 'excluded.j' : '$3'}`,
			);
			expect(state.parameters).toEqual(
				useExcluded ? [1, null] : [1, null, null],
			);
			expect(state.paramIndex).toBe(state.parameters.length);
		},
	);
	it('bare null preserves existing mutation SQL', () => {
		const update = orm
			.modify(orm.tables.t)
			.set({ j: null })
			.where(eq('id', 1))
			.dump();
		expect(update.sql).toBe('UPDATE t SET j = NULL WHERE t.id = $1');
		expect(update.parameters).toEqual([1]);
		const insert = orm.insert('t').values({ id: 1, j: null }).dump();
		expect(insert.sql).toBe('INSERT INTO t (id, j) VALUES ($1, NULL)');
		expect(insert.parameters).toEqual([1]);
		const upsert = orm
			.upsert('t')
			.values({ id: 1, j: null })
			.onConflict(['id'])
			.doUpdate({ j: null })
			.dump();
		expect(upsert.sql).toBe(
			'INSERT INTO t (id, j) VALUES ($1, NULL) ON CONFLICT (id) DO UPDATE SET j = $2',
		);
		expect(upsert.parameters).toEqual([1, null]);
	});
});

it('reads a public param wrapper intent getter once', () => {
	const db = schema({ t: { v: 'integer' } });
	const orm = createOrm({
		schema: db,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
	let reads = 0;
	const obj = {
		__expr: true,
		get intent() {
			return ++reads === 1
				? { kind: 'param', value: 17 }
				: { kind: 'fieldRef', scope: 'inner', column: 'id' };
		},
	};
	const result = orm.select('t').where(eq('v', obj)).dump();
	expect(result.sql).toBe('SELECT t.* FROM t WHERE t.v = $1');
	expect(result.params).toEqual([17]);
	expect(reads).toBe(1);
});
