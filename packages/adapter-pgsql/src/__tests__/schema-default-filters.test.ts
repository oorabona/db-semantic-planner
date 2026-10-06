import {
	aggOrderBy,
	and,
	array,
	caseWhen,
	cast,
	createOrm,
	ExpressionRef,
	eq,
	exists,
	exprRef,
	fn,
	inSubquery,
	isNull,
	namedArg,
	not,
	op,
	or,
	param,
	rawExists,
	ref,
	schema,
	star,
	subquery,
} from '@dbsp/core';
import type { WhereIntent } from '@dbsp/types';
import { expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const definition = {
	posts: { id: 'integer', title: 'string', deletedAt: 'timestamp' },
} as const;

it('refuses object default filters with a table name and condition helper hint', () => {
	expect(() =>
		schema(definition, undefined, {
			defaultFilters: { posts: { deletedAt: null } as unknown as WhereIntent },
		}),
	).toThrowError(
		/^Default filter for table 'posts': expected a condition intent built with condition helpers, for example isNull\('deletedAt'\)$/,
	);
});

it('keeps helper conditions on tables declaring intent-shaped column names', () => {
	const db = schema({
		events: {
			id: 'integer',
			kind: 'string',
			field: 'string',
			operator: 'string',
			value: 'string',
		},
	});
	const orm = createOrm({
		schema: db,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
	const dump = orm.select('events').where(eq('id', 7)).dump();
	expect(dump.sql).toBe('SELECT events.* FROM events WHERE events.id = $1');
	expect(dump.params).toEqual([7]);
});

it('accepts nested conditions on declared columns', () => {
	const filter = and(isNull('deletedAt'), eq('title', 'x'));
	expect(
		schema(definition, undefined, { defaultFilters: { posts: filter } })
			.defaultFilters?.posts,
	).toEqual(filter);
});

it.each([
	[
		{ field: 'deletedAt', op: 'isNull' },
		"expected a condition intent built with condition helpers, for example isNull('deletedAt')",
	],
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

it.each([
	[exprRef('id').eq(7), 'SELECT posts.* FROM posts WHERE posts.id = $1', [7]],
	[
		isNull('posts.deletedAt'),
		'SELECT posts.* FROM posts WHERE posts."deletedAt" IS NULL',
		[],
	],
	[
		eq('id', ref('posts.id')),
		'SELECT posts.* FROM posts WHERE posts.id = posts.id',
		[],
	],
])('accepts and emits own-range default filter %j', (filter, sql, params) => {
	const db = schema(definition, undefined, {
		defaultFilters: { posts: filter },
	});
	const orm = createOrm({
		schema: db,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
	expect(orm.select('posts').dump()).toMatchObject({ sql, params });
});

it('accepts nested own-range expression operands', () => {
	const filter = fn(
		'coalesce',
		cast(caseWhen(eq('id', 7), exprRef('posts.id')).else(param(0)), 'integer'),
		namedArg('value', array(exprRef('id'), param(1))),
	).eq(7);
	expect(
		schema(definition, undefined, { defaultFilters: { posts: filter } })
			.defaultFilters?.posts,
	).toBe(filter);
});

it.each([
	[
		fn('abs', exprRef('authors.id')).eq(7),
		"WHERE qualifier 'authors' is not visible in this query.",
	],
	[
		new ExpressionRef({
			kind: 'subquery',
			query: subquery('posts').select('id').build().intent,
		}).eq(7),
		"forbidden operand 'subquery'",
	],
	[
		fn('count', exprRef('id')).filter(exists('author')).eq(7),
		"forbidden condition kind 'relation'",
	],
])(
	'refuses another range inside expression %j with its table named',
	(filter, reason) => {
		expect(() =>
			schema(
				{
					...definition,
					posts: { ...definition.posts, authorId: ref('authors') },
					authors: { id: 'integer' },
				},
				undefined,
				{ defaultFilters: { posts: filter } },
			),
		).toThrowError(`Default filter for table 'posts': ${reason}`);
	},
);

it.each([
	op('+', exprRef('id'), param(1)).eq(7),
	exprRef('id').eq(cast(exprRef('posts.id'), 'integer')),
	eq('id', cast(exprRef('posts.id'), 'integer')),
])('accepts own-range expression kind and RHS %j', (filter) => {
	expect(
		schema(definition, undefined, { defaultFilters: { posts: filter } })
			.defaultFilters?.posts,
	).toBe(filter);
});

it('refuses relation paths to another table', () => {
	expect(() =>
		schema(
			{
				posts: { ...definition.posts, authorId: ref('authors') },
				authors: { id: 'integer' },
			},
			undefined,
			{ defaultFilters: { posts: isNull('author.id') } },
		),
	).toThrowError(
		"Default filter for table 'posts': forbidden condition kind 'relation'",
	);
});

// #961: schema validation must refuse expressions invalid in a scan WHERE.
it.each([
	[fn('count', star()).filter(eq('id', 7)).eq(1), 'forbidden aggregate call'],
	[
		fn('array_agg', exprRef('id'), aggOrderBy('posts.id')).eq(1),
		'forbidden aggregate call',
	],
	[
		new ExpressionRef({
			kind: 'customFn',
			name: 'array_agg',
			args: [exprRef('id').intent],
			distinct: true,
		}).eq(1),
		'forbidden aggregate call',
	],
	[
		new ExpressionRef({ kind: 'aggregate', function: 'count', field: '*' }).eq(
			1,
		),
		'forbidden aggregate call',
	],
	[star().eq(1), "forbidden operand 'star' outside a function argument"],
	[
		namedArg('value', exprRef('id')).eq(1),
		"forbidden operand 'namedArg' outside a function argument",
	],
])('refuses #961 default filter %j at schema()', (filter, reason) => {
	expect(() =>
		schema(definition, undefined, { defaultFilters: { posts: filter } }),
	).toThrowError(`Default filter for table 'posts': ${reason}`);
});

it('refuses a self-relation as another range at schema()', () => {
	expect(() =>
		schema(
			{
				posts: {
					...definition.posts,
					parentId: ref('posts', {
						nullable: true,
						roles: { parent: 'parent', children: 'children' },
					}),
				},
			},
			undefined,
			{ defaultFilters: { posts: isNull('parent.id') } },
		),
	).toThrowError(
		"Default filter for table 'posts': forbidden condition kind 'relation'",
	);
});

it('accepts a scalar function over its own column with exact SQL', () => {
	const db = schema(definition, undefined, {
		defaultFilters: { posts: fn('abs', exprRef('id')).eq(7) },
	});
	const orm = createOrm({
		schema: db,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
	expect(orm.select('posts').dump()).toMatchObject({
		sql: 'SELECT posts.* FROM posts WHERE abs(posts.id) = $1',
		params: [7],
	});
});
