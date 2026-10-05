import {
	createOrm,
	eq,
	exists,
	fn,
	inSubquery,
	rawExists,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	a: { id: { type: 'integer', primaryKey: true } },
	other: {
		id: { type: 'integer', primaryKey: true },
		aId: ref('a', { inverse: 'others' }),
		fooBarId: ref('fooBar', { as: 'fooBar' }),
		fooBarAgainId: ref('fooBar', { as: 'foo_bar' }),
	},
	fooBar: {
		id: { type: 'integer', primaryKey: true },
		aId: ref('a', { inverse: 'children' }),
	},
	baz: { id: { type: 'integer', primaryKey: true } },
});
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({
		model: db.model,
		dbCasing: 'snake_case',
	}),
});
const body = subquery('fooBar').select('id');
for (const [name, predicate, tail] of [
	[
		'raw EXISTS',
		rawExists(body),
		'EXISTS (SELECT "fooBar_sq".id FROM foo_bar AS "fooBar_sq")',
	],
	[
		'IN',
		inSubquery('id', body),
		'a.id = ANY (SELECT "fooBar_subq_1".id FROM foo_bar AS "fooBar_subq_1")',
	],
	[
		'scalar',
		body.build().toWhereIntent('id', 'eq'),
		'a.id = (SELECT "fooBar_subq_1".id FROM foo_bar AS "fooBar_subq_1")',
	],
	[
		'expression',
		fn('abs', body.asExpr('value')).gt(0),
		'abs((SELECT "fooBar_sq".id FROM foo_bar AS "fooBar_sq")) > $1',
	],
] as const) {
	it(`${name} FROM resolves the physical table beneath an outer alias`, () => {
		const result = orm
			.select('a')
			.join('other', { as: 'fooBar', on: eq('a.id', 1) })
			.where(predicate)
			.dump();
		expect(result.sql).toBe(
			`SELECT a.* FROM a JOIN other AS "fooBar" ON a.id = ${name === 'expression' ? '$2' : '$1'} WHERE ${tail}`,
		);
	});
}
it('authored join alias retains a reserved table spelling', () => {
	const result = orm
		.select('a')
		.join('fooBar', { as: 'x', on: eq('a.id', 1) })
		.join('baz', { as: 'foo_bar', on: eq('a.id', 1) })
		.where(eq('foo_bar.id', 7))
		.dump();
	expect(result.sql).toBe(
		'SELECT a.* FROM a JOIN foo_bar AS x ON a.id = $2 JOIN baz AS foo_bar ON a.id = $3 WHERE foo_bar.id = $1',
	);
	expect(result.params).toEqual([7, 1, 1]);
});

it('relation hop FROM ignores an outer join alias matching its logical table', () => {
	expect(
		orm
			.select('a')
			.join('baz', { as: 'fooBar', on: eq('a.id', 1) })
			.where(exists('children'))
			.dump().sql,
	).toBe(
		'SELECT a.* FROM a JOIN baz AS "fooBar" ON a.id = $1 WHERE EXISTS (SELECT 1 FROM foo_bar AS "fooBar_exists_1" WHERE a.id = "fooBar_exists_1".a_id)',
	);
});
it('relation predicate include FROM ignores an outer join alias matching its logical table', () => {
	expect(
		orm
			.select('a')
			.join('baz', { as: 'fooBar', on: eq('a.id', 1) })
			.where(exists('others', { include: { fooBar: { join: 'inner' } } }))
			.dump().sql,
	).toBe(
		'SELECT a.* FROM a JOIN baz AS "fooBar" ON a.id = $1 WHERE EXISTS (SELECT 1 FROM other AS other_exists_1 JOIN foo_bar AS "fooBar" ON other_exists_1.foo_bar_id = "fooBar".id WHERE a.id = other_exists_1.a_id)',
	);
});

it('WHERE relation include alias retains its written casing spelling', () => {
	const result = orm
		.select('a')
		.join('fooBar', { as: 'x', on: eq('a.id', 1) })
		.where(exists('others', { include: { foo_bar: { join: 'inner' } } }))
		.dump();
	expect(result.sql).toBe(
		'SELECT a.* FROM a JOIN foo_bar AS x ON a.id = $1 WHERE EXISTS (SELECT 1 FROM other AS other_exists_1 JOIN foo_bar AS foo_bar ON other_exists_1.foo_bar_again_id = foo_bar.id WHERE a.id = other_exists_1.a_id)',
	);
});
it('physical subquery FROM retains the configured schema under an outer alias', () => {
	const result = orm
		.withSchema('tenant')
		.select('a')
		.join('other', { as: 'fooBar', on: eq('a.id', 1) })
		.where(rawExists(body))
		.dump();
	expect(result.sql).toBe(
		'SELECT a.* FROM tenant.a JOIN tenant.other AS "fooBar" ON a.id = $1 WHERE EXISTS (SELECT "fooBar_sq".id FROM tenant.foo_bar AS "fooBar_sq")',
	);
});
