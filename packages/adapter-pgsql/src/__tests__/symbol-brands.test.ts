import {
	coalesce,
	createOrm,
	eq,
	exprRef,
	literal,
	ref,
	rowNumber,
	schema,
	subquery,
	unsafeAsPredicate,
} from '@dbsp/core';
import { EXPRESSION_BRAND, PREDICATE_BRAND, REF_BRAND } from '@dbsp/types';
import { expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	t: {
		__expr: 'boolean',
		__predicateRef: 'string',
		__brand: 'string',
		intent: 'string',
		doc: 'json',
	},
});
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});
it.each([
	[{ __expr: true }, 't.__expr = $1', [true]],
	[
		{ __expr: true, intent: 'x' },
		't.__expr = $1 AND t.intent = $2',
		[true, 'x'],
	],
	[{ __predicateRef: 'x' }, 't."__predicateRef" = $1', ['x']],
	[
		{ __brand: 'ref', intent: 'x' },
		't.__brand = $1 AND t.intent = $2',
		['ref', 'x'],
	],
] as const)('object filter %j is user data', (input, sql, params) => {
	const result = orm.select('t').where(input).dump();
	expect(result.sql).toBe(`SELECT t.* FROM t WHERE ${sql}`);
	expect(result.params).toEqual(params);
});
it('eq on __expr stays an equality', () => {
	const result = orm.select('t').where(eq('__expr', true)).dump();
	expect(result.sql).toBe('SELECT t.* FROM t WHERE t.__expr = $1');
	expect(result.params).toEqual([true]);
});
it.each([
	{ __expr: true, intent: { kind: 'literal', value: 1 } },
	{ __brand: 'ref', target: 'id' },
	{ __predicateRef: 'x' },
	{ __brand: 'ref', intent: 'x' },
	JSON.parse(JSON.stringify(literal(1))),
])('JSON value %j binds through select, insert and update', (doc) => {
	const result = orm.select('t').where(eq('doc', doc)).dump();
	expect(result.sql).toBe('SELECT t.* FROM t WHERE t.doc = $1');
	expect(result.params).toEqual([doc]);
	const insert = orm.insert('t').values({ doc }).dump();
	expect(insert.sql).toBe('INSERT INTO t (doc) VALUES ($1)');
	expect(insert.parameters).toEqual([doc]);
	const update = orm
		.modify(orm.tables.t)
		.set({ doc })
		.where(eq('__expr', true))
		.dump();
	expect(update.sql).toBe('UPDATE t SET doc = $1 WHERE t.__expr = $2');
	expect(update.parameters).toEqual([doc, true]);
});
it.each([
	[literal(1), EXPRESSION_BRAND, true],
	[exprRef('doc'), EXPRESSION_BRAND, true],
	[ref('t'), REF_BRAND, 'ref'],
	[subquery('t').count().asExpr('n'), EXPRESSION_BRAND, true],
	[rowNumber().as('n'), EXPRESSION_BRAND, true],
	[coalesce(['intent'], 's'), EXPRESSION_BRAND, true],
	[unsafeAsPredicate(literal(true)), PREDICATE_BRAND, 'dbsp.predicate.v1'],
] as const)(
	'factory brands are invisible to JSON and enumeration',
	(value, brand, marker) => {
		expect(Object.getOwnPropertyDescriptor(value, brand)).toEqual({
			value: marker,
			enumerable: false,
			writable: false,
			configurable: false,
		});
		expect(JSON.parse(JSON.stringify(value))[String(brand)]).toBeUndefined();
		expect(Object.keys(value)).not.toContain('__expr');
		expect(Object.keys(value)).not.toContain('__brand');
		expect(Object.keys(value)).not.toContain('__predicateRef');
		expect(Symbol.keyFor(brand)).toBeDefined();
	},
);
