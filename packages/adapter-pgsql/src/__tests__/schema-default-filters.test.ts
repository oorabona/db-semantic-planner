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
	ref,
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
	[
		exists('authored'),
		"exists('authored'): no relation 'authored' is declared on table 'posts'. Use rawExists(subquery(...)) for an EXISTS over an undeclared or uncorrelated subquery.",
	],
	[
		isNull('author.deletedAt'),
		"exists('author'): no relation 'author' is declared on table 'posts'. Use rawExists(subquery(...)) for an EXISTS over an undeclared or uncorrelated subquery.",
	],
	[
		rawExists(subquery('posts').select('id')),
		"forbidden condition kind 'subquery'",
	],
	[
		inSubquery('id', subquery('posts').select('id')),
		"forbidden subquery in 'in'",
	],
	[isNull('missing'), "invalid column 'missing'"],
	[{ kind: 'mystery' }, "Unsupported predicate kind 'mystery'"],
	[
		and(isNull('deletedAt'), { field: 'title' } as unknown as WhereIntent),
		"Unsupported predicate kind 'undefined'",
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
		['some', 'every', 'none'].includes(kind)
			? `Unsupported predicate kind '${kind}'`
			: kind === 'subquery'
				? 'Condition requires a column'
				: `Cannot read properties of undefined (reading '${kind === 'rawNotExists' ? 'groupBy' : kind === 'expression' ? 'kind' : 'length'}')`,
	]),
	[
		eq('id', { kind: 'ref', column: 'id', outer: true }),
		'outerRef() requires an enclosing query range.',
	],
	[not(or(isNull('deletedAt'), isNull('absent'))), "invalid column 'absent'"],
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

it('refuses branded references to invisible tables during schema construction', () => {
	expect(() =>
		schema({ ...definition, authors: { id: 'integer' } }, undefined, {
			defaultFilters: { posts: eq('id', ref('authors.id')) },
		}),
	).toThrowError(
		"Default filter for table 'posts': WHERE qualifier 'authors' is not visible in this query.",
	);
});

it.each([{ outer: true }, { kind: 'subquery' }])(
	'binds unbranded object payload %j without interpreting it as an operand',
	(payload) => {
		const db = schema(
			{ posts: { id: 'integer', payload: 'jsonb' } },
			undefined,
			{
				defaultFilters: { posts: eq('payload', payload) },
			},
		);
		const orm = createOrm({
			schema: db,
			adapter: createPgCompileOnlyAdapter({ model: db.model }),
		});
		const dump = orm.select('posts').dump();
		expect(dump.sql).toBe('SELECT posts.* FROM posts WHERE posts.payload = $1');
		expect(dump.params).toEqual([payload]);
	},
);

it.each(['audit', 'null'])(
	'treats the declared kind column as an object filter with value %s',
	(value) => {
		const definition = { events: { id: 'integer', kind: 'string' } } as const;
		const db = schema(definition, undefined, {
			defaultFilters: { events: { kind: value } },
		});
		const orm = createOrm({
			schema: db,
			adapter: createPgCompileOnlyAdapter({ model: db.model }),
		});
		const dumps = [
			orm.select('events').dump(),
			orm
				.select('events')
				.withoutDefaultFilters()
				.where({ kind: value })
				.dump(),
			orm
				.select('events')
				.withoutDefaultFilters()
				.where(eq('kind', value))
				.dump(),
		];
		for (const dump of dumps) {
			expect(dump.sql).toBe(
				'SELECT events.* FROM events WHERE events.kind = $1',
			);
			expect(dump.params).toEqual([value]);
		}
	},
);

it.each(['audit', 'null'])(
	'normalizes an explicit object filter on the kind column with value %s',
	(value) => {
		const db = schema({ events: { id: 'integer', kind: 'string' } });
		const orm = createOrm({
			schema: db,
			adapter: createPgCompileOnlyAdapter({ model: db.model }),
		});
		const dump = orm.select('events').where({ kind: value }).dump();
		expect(dump.sql).toBe('SELECT events.* FROM events WHERE events.kind = $1');
		expect(dump.params).toEqual([value]);
	},
);
