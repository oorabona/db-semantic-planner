import {
	and,
	createOrm,
	eq,
	exists,
	inSubquery,
	isNull,
	not,
	or,
	rawExists,
	schema,
	subquery,
} from '@dbsp/core';
import type { WhereIntent } from '@dbsp/types';
import { expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const definition = {
	posts: { id: 'integer', title: 'string', deletedAt: 'timestamp' },
} as const;

it('normalizes object default filters before compiling a select', () => {
	const db = schema(definition, undefined, {
		defaultFilters: { posts: { deletedAt: null } },
	});
	expect(db.defaultFilters?.posts).toEqual(isNull('deletedAt'));
	const orm = createOrm({
		schema: db,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
	expect(orm.select('posts').dump().sql).toBe(
		'SELECT posts.* FROM posts WHERE posts."deletedAt" IS NULL',
	);
});

it('accepts nested conditions on declared columns', () => {
	const filter = and(isNull('deletedAt'), eq('title', 'x'));
	expect(
		schema(definition, undefined, { defaultFilters: { posts: filter } })
			.defaultFilters?.posts,
	).toEqual(filter);
});

it.each([
	[{ field: 'deletedAt', op: 'isNull' }, "invalid column 'field'"],
	[exists('authored'), "forbidden condition kind 'exists'"],
	[isNull('author.deletedAt'), "invalid column 'author.deletedAt'"],
	[
		rawExists(subquery('posts').select('id')),
		"forbidden condition kind 'rawExists'",
	],
	[
		inSubquery('id', subquery('posts').select('id')),
		"forbidden subquery in 'in'",
	],
	[isNull('missing'), "invalid column 'missing'"],
	[{ kind: 'mystery' }, "unknown condition kind 'mystery'"],
	[
		and(isNull('deletedAt'), { field: 'title' } as unknown as WhereIntent),
		"unknown condition kind 'undefined'",
	],
	...[
		'notExists',
		'some',
		'every',
		'none',
		'relationFilter',
		'rawNotExists',
		'subquery',
		'expression',
	].map((kind): [unknown, string] => [
		{ kind },
		`${['some', 'every', 'none'].includes(kind) ? 'unknown' : 'forbidden'} condition kind '${kind}'`,
	]),
	[not(or(isNull('deletedAt'), isNull('absent'))), "invalid column 'absent'"],
	[eq('id', { kind: 'subquery' }), "forbidden operand 'subquery'"],
	[
		eq('id', { kind: 'ref', column: 'id', outer: true }),
		"forbidden operand 'ref'",
	],
])(
	'refuses unsupported default filter %j at schema construction',
	(filter, reason) => {
		expect(() =>
			schema(definition, undefined, {
				defaultFilters: { posts: filter as WhereIntent },
			}),
		).toThrowError(`Default filter for table 'posts': ${reason}`);
	},
);
