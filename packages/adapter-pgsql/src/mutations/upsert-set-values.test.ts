import { createOrm, eq, param, schema, sql } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { deparseQuoted } from '../deparse.js';
import { createCompilerState } from '../handlers/types.js';
import { compileUpsert } from '../index.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { queryLocal } from '../sql-identifier.js';

const model = schema({ t: { id: 'integer', n: 'text', extra: 'text' } }).model;
const adapter = createPgCompileOnlyAdapter({ model });
const orm = createOrm({ adapter, model });
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function check(
	query: { sql: string; parameters: readonly unknown[] },
	expected: string,
	params: unknown[],
) {
	expect(normalize(query.sql)).toBe(expected);
	expect(query.parameters).toEqual(params);
}

describe('#914 independent INSERT and conflict SET values', () => {
	it('inserts a and binds b on conflict', () => {
		check(
			orm
				.upsert('t')
				.values({ id: 1, n: 'a' })
				.onConflict(['id'])
				.doUpdate({ n: 'b' })
				.dump(),
			'INSERT INTO t (id, n) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET n = $3',
			[1, 'a', 'b'],
		);
	});
	it('does not insert a set-only column', () => {
		check(
			orm
				.upsert('t')
				.values({ id: 1, n: 'a' })
				.onConflict(['id'])
				.doUpdate({ extra: 'b' })
				.dump(),
			'INSERT INTO t (id, n) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET extra = $3',
			[1, 'a', 'b'],
		);
	});
	for (const [name, value] of [
		['param(null)', param(null)],
		['null', null],
		['param(b)', param('b')],
	] as const) {
		it(`binds ${name} in SET`, () => {
			check(
				orm
					.upsert('t')
					.values({ id: 1, n: 'a' })
					.onConflict(['id'])
					.doUpdate({ n: value })
					.dump(),
				'INSERT INTO t (id, n) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET n = $3',
				[1, 'a', name === 'param(b)' ? 'b' : null],
			);
		});
	}
	it('keeps raw SET expressions alongside bound SET values', () => {
		check(
			orm
				.upsert('t')
				.values({ id: 1, n: 'a' })
				.onConflict(['id'])
				.doUpdate({ n: 'b', extra: sql('upper(excluded.n)') })
				.dump(),
			'INSERT INTO t (id, n) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET n = $3, extra = upper(excluded.n)',
			[1, 'a', 'b'],
		);
	});
	it('binds SET once after each VALUES row', () => {
		check(
			orm
				.upsert('t')
				.values([
					{ id: 1, n: 'a' },
					{ id: 2, n: 'c' },
				])
				.onConflict(['id'])
				.doUpdate({ n: 'b' })
				.dump(),
			'INSERT INTO t (id, n) VALUES ($1, $2), ($3, $4) ON CONFLICT (id) DO UPDATE SET n = $5',
			[1, 'a', 2, 'c', 'b'],
		);
	});
	it('binds SET once after unnested column arrays', () => {
		check(
			adapter.compileUpsert(
				{
					type: 'upsert',
					table: 't',
					values: [
						{ id: 1, n: 'a' },
						{ id: 2, n: 'c' },
					],
					onConflict: { columns: ['id'] },
					action: { type: 'doUpdate', set: { n: 'b' } },
				},
				{ batchThreshold: 1 },
			),
			'INSERT INTO t (id, n) SELECT unnest(CAST($1 AS int4[])) AS id, unnest(CAST($2 AS text[])) AS n ON CONFLICT (id) DO UPDATE SET n = $3',
			[[1, 2], ['a', 'c'], 'b'],
		);
	});
	it('allocates action WHERE after SET and keeps RETURNING', () => {
		check(
			orm
				.upsert('t')
				.values({ id: 1, n: 'a' })
				.onConflict(['id'])
				.doUpdate({ n: 'b' }, eq('extra', 'guard'))
				.returning(['n'])
				.dump(),
			'INSERT INTO t (id, n) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET n = $3 WHERE t.extra = $4 RETURNING t.n AS n',
			[1, 'a', 'b', 'guard'],
		);
	});
	it('keeps doUpdate() using excluded', () => {
		check(
			orm
				.upsert('t')
				.values({ id: 1, n: 'a' })
				.onConflict(['id'])
				.doUpdate()
				.dump(),
			'INSERT INTO t (id, n) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET n = excluded.n',
			[1, 'a'],
		);
	});
});

describe('#914 physical names, casts and exported compiler', () => {
	it('keeps schema, constraint and dbCasing for a set-only range column', () => {
		const rangeModel = schema({
			priceTiers: {
				id: { type: 'integer', primaryKey: true },
				quantityRange: 'int4range',
			},
		}).model;
		const rangeAdapter = createPgCompileOnlyAdapter({
			model: rangeModel,
			dbCasing: 'snake_case',
		});
		const scoped = createOrm({
			model: rangeModel,
			adapter: rangeAdapter,
		}).withSchema('tenant');
		check(
			scoped
				.upsert('priceTiers')
				.values({ id: 1 })
				.onConflictConstraint('pk_priceTiers')
				.doUpdate({ quantityRange: param('[2,4)') })
				.dump(),
			'INSERT INTO tenant.price_tiers (id) VALUES ($1) ON CONFLICT ON CONSTRAINT pk_price_tiers DO UPDATE SET quantity_range = CAST($2 AS int4range)',
			[1, '[2,4)'],
		);
	});
	it('casts typed SET parameters without changing VALUES', () => {
		const rangeModel = schema({ t: { id: 'integer', n: 'int4range' } }).model;
		const rangeAdapter = createPgCompileOnlyAdapter({ model: rangeModel });
		check(
			rangeAdapter.compileUpsert({
				type: 'upsert',
				table: 't',
				values: [{ id: 1, n: '[1,3)' }],
				onConflict: { columns: ['id'] },
				action: {
					type: 'doUpdate',
					set: { n: { kind: 'param', value: '[2,4)' } },
				},
			}),
			'INSERT INTO t (id, n) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET n = CAST($3 AS int4range)',
			[1, '[1,3)', '[2,4)'],
		);
	});
});

it('#914 exported compileUpsert binds explicit SET independently', () => {
	const state = createCompilerState();
	const ast = compileUpsert(
		{
			table: queryLocal('t'),
			columns: ['id', 'n'].map(queryLocal),
			values: [[1, 'a']],
			conflictTarget: { columns: [queryLocal('id')] },
			conflictAction: 'update',
			updateColumns: [queryLocal('n'), queryLocal('extra')],
			updateValues: new Map([
				[queryLocal('n'), 'b'],
				[queryLocal('extra'), null],
			]),
		},
		{ rootTable: 't', maxRecursiveDepth: 100 },
		state,
	);
	check(
		{ sql: deparseQuoted(ast), parameters: state.parameters },
		'INSERT INTO t (id, n) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET n = $3, extra = $4',
		[1, 'a', 'b', null],
	);
});
