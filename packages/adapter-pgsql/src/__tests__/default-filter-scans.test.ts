import type { QueryBuilder, SubqueryBuilder, WhereIntent } from '@dbsp/core';
import {
	caseWhen,
	createOrm,
	eq,
	exists,
	exprRef,
	fn,
	inSubquery,
	isNull,
	literal,
	namedArg,
	notExists,
	op,
	outerRef,
	plan,
	rawExists,
	ref,
	relationColumn,
	SubqueryExpression,
	schema,
	star,
	subquery,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const rawNotExists = (q: SubqueryBuilder): WhereIntent => ({
	kind: 'rawNotExists',
	subquery: q.build().toIntent(),
});
const db = schema(
	{
		users: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			deletedAt: { type: 'timestamp', nullable: true },
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			deletedAt: { type: 'timestamp', nullable: true },
			authorId: ref('users', { as: 'author', inverse: 'authored' }),
		},
		comments: {
			id: { type: 'integer', primaryKey: true },
			deletedAt: { type: 'timestamp', nullable: true },
			postId: ref('posts', { as: 'post', inverse: 'comments' }),
		},
	},
	undefined,
	{
		defaultFilters: {
			users: isNull('deletedAt'),
			posts: isNull('deletedAt'),
			comments: isNull('deletedAt'),
		},
	},
);
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter() });
const cases: Record<string, (o: typeof orm) => QueryBuilder<unknown>> = {};
for (const strategy of ['json_agg', 'lateral'] as const)
	cases[strategy] = (o) =>
		o
			.select('users')
			.include('authored', {
				limit: 2,
				orderBy: [{ field: 'id', direction: 'desc' }],
			})
			.withPlanOptions({ defaultIncludeStrategy: strategy });
cases.cte = (o) =>
	o
		.select('posts')
		.include('author')
		.withPlanOptions({ defaultIncludeStrategy: 'cte' });
cases.joinInclude = (o) =>
	o.select('posts').include('author', { join: 'left', where: eq('name', 'x') });
for (const [name, f] of Object.entries({ exists, notExists }))
	cases[name] = (o) =>
		o.select('users').where(f('authored', { where: eq('title', 'x') }));
cases.every = (o) =>
	o.select('users').where({
		kind: 'relationFilter',
		relation: 'authored',
		mode: 'every',
		where: eq('title', 'x'),
	});
cases.none = (o) =>
	o.select('users').where({
		kind: 'relationFilter',
		relation: 'authored',
		mode: 'none',
		where: eq('title', 'x'),
	});
cases.inBody = (o) =>
	o
		.select('users')
		.where(inSubquery('name', subquery('posts').select('title')));
cases.dotted = (o) => o.select('users').where(eq('authored.comments.id', 3));
cases.existsInclude = (o) =>
	o.select('users').where(
		exists('authored', {
			include: { author: { join: 'left' } },
			where: eq('author.name', 'x'),
		}),
	);
cases.relationJoin = (o) => o.select('posts').join('author', { type: 'left' });
cases.tableJoin = (o) =>
	o.select('posts').join('users', {
		as: 'u',
		type: 'left',
		on: eq('authorId', exprRef('u.id')),
	});
// field ref: use exprRef rather than schema ref
for (const [name, f] of Object.entries({ rawExists, rawNotExists }))
	cases[name] = (o) =>
		o
			.select('users')
			.where(f(subquery('posts').select('id').where(eq('title', 'x'))));
cases.inSubquery = (o) =>
	o
		.select('users')
		.where(
			inSubquery(
				'id',
				subquery('posts').select('authorId').where(eq('title', 'x')),
			),
		);
cases.scalar = (o) =>
	o
		.select('users')
		.where(subquery('posts').select('id').build().toWhereIntent('id', 'eq'));
cases.expression = (o) =>
	o.select('users').columns([subquery('posts').select('id').asExpr('postId')]);
cases.carrier = (o) =>
	o
		.select('posts')
		.include('author', { join: 'left' })
		.withPlanOptions({ defaultFilters: Object.create(null) });

describe('default filters on physical read scans', () => {
	it('filters aggregated children before ordering and limiting', () => {
		const build = cases['json_agg'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT users.*, COALESCE((SELECT json_agg(__lim.__row ORDER BY __lim.__key0 DESC) FROM (SELECT jsonb_build_object(\'id\', __t__.id, \'title\', __t__.title, \'deletedAt\', __t__."deletedAt", \'authorId\', __t__."authorId") AS __row, __t__.id AS __key0 FROM posts AS __t__ WHERE __t__."authorId" = users.id AND __t__."deletedAt" IS NULL ORDER BY __t__.id DESC LIMIT 2) AS __lim), \'[]\'::json) AS authored_json FROM users WHERE users."deletedAt" IS NULL',
			params: [],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: "SELECT users.*, COALESCE((SELECT json_agg(__lim.__row ORDER BY __lim.__key0 DESC) FROM (SELECT jsonb_build_object('id', __t__.id, 'title', __t__.title, 'deletedAt', __t__.\"deletedAt\", 'authorId', __t__.\"authorId\") AS __row, __t__.id AS __key0 FROM posts AS __t__ WHERE __t__.\"authorId\" = users.id ORDER BY __t__.id DESC LIMIT 2) AS __lim), '[]'::json) AS authored_json FROM users",
			params: [],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: "SELECT users.*, COALESCE((SELECT json_agg(__lim.__row ORDER BY __lim.__key0 DESC) FROM (SELECT jsonb_build_object('id', __t__.id, 'title', __t__.title, 'deletedAt', __t__.\"deletedAt\", 'authorId', __t__.\"authorId\") AS __row, __t__.id AS __key0 FROM posts AS __t__ WHERE __t__.\"authorId\" = users.id ORDER BY __t__.id DESC LIMIT 2) AS __lim), '[]'::json) AS authored_json FROM users",
			params: [],
		});
	});
	it('filters lateral children before ordering and limiting', () => {
		const build = cases['lateral'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT users.*, posts_lat_0.id AS "authored.id", posts_lat_0.title AS "authored.title", posts_lat_0."deletedAt" AS "authored.deletedAt", posts_lat_0."authorId" AS "authored.authorId", posts_lat_0.__dbsp_presence_authored AS __dbsp_presence_authored FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.id, posts_inner_0.title, posts_inner_0."deletedAt", posts_inner_0."authorId", posts_inner_0.id AS __dbsp_presence_authored FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id AND posts_inner_0."deletedAt" IS NULL ORDER BY posts_inner_0.id DESC LIMIT 2) AS posts_lat_0 ON true WHERE users."deletedAt" IS NULL',
			params: [],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT users.*, posts_lat_0.id AS "authored.id", posts_lat_0.title AS "authored.title", posts_lat_0."deletedAt" AS "authored.deletedAt", posts_lat_0."authorId" AS "authored.authorId", posts_lat_0.__dbsp_presence_authored AS __dbsp_presence_authored FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.id, posts_inner_0.title, posts_inner_0."deletedAt", posts_inner_0."authorId", posts_inner_0.id AS __dbsp_presence_authored FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id ORDER BY posts_inner_0.id DESC LIMIT 2) AS posts_lat_0 ON true',
			params: [],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: 'SELECT users.*, posts_lat_0.id AS "authored.id", posts_lat_0.title AS "authored.title", posts_lat_0."deletedAt" AS "authored.deletedAt", posts_lat_0."authorId" AS "authored.authorId", posts_lat_0.__dbsp_presence_authored AS __dbsp_presence_authored FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.id, posts_inner_0.title, posts_inner_0."deletedAt", posts_inner_0."authorId", posts_inner_0.id AS __dbsp_presence_authored FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id ORDER BY posts_inner_0.id DESC LIMIT 2) AS posts_lat_0 ON true',
			params: [],
		});
	});
	it('filters the physical include CTE body', () => {
		const build = cases['cte'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'WITH author_cte AS (SELECT users_inner_0.* FROM users AS users_inner_0 WHERE users_inner_0."deletedAt" IS NULL) SELECT posts.* FROM posts LEFT JOIN author_cte AS author_ref_0 ON posts."authorId" = author_ref_0.id WHERE posts."deletedAt" IS NULL',
			params: [],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'WITH author_cte AS (SELECT users_inner_0.* FROM users AS users_inner_0) SELECT posts.* FROM posts LEFT JOIN author_cte AS author_ref_0 ON posts."authorId" = author_ref_0.id',
			params: [],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: 'WITH author_cte AS (SELECT users_inner_0.* FROM users AS users_inner_0) SELECT posts.* FROM posts LEFT JOIN author_cte AS author_ref_0 ON posts."authorId" = author_ref_0.id',
			params: [],
		});
	});
	it('keeps the scan filter in ON and authored include where in root WHERE', () => {
		const build = cases['joinInclude'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author."deletedAt" AS "author.deletedAt", author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id AND author."deletedAt" IS NULL WHERE posts."deletedAt" IS NULL AND author.name = $1',
			params: ['x'],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author."deletedAt" AS "author.deletedAt", author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id WHERE author.name = $1',
			params: ['x'],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: 'SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author."deletedAt" AS "author.deletedAt", author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id WHERE author.name = $1',
			params: ['x'],
		});
	});
	it('excludes filtered rows from exists', () => {
		const build = cases['exists'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0."deletedAt" IS NULL AND posts_exists_0.title = $1)',
			params: ['x'],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0.title = $1)',
			params: ['x'],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0.title = $1)',
			params: ['x'],
		});
	});
	it('excludes filtered rows from notExists', () => {
		const build = cases['notExists'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users."deletedAt" IS NULL AND NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0."deletedAt" IS NULL AND posts_exists_0.title = $1))',
			params: ['x'],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0.title = $1))',
			params: ['x'],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0.title = $1))',
			params: ['x'],
		});
	});
	it('tests every only over visible children', () => {
		const build = cases['every'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users."deletedAt" IS NULL AND NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0."deletedAt" IS NULL AND NOT (posts_exists_0.title = $1)))',
			params: ['x'],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND NOT (posts_exists_0.title = $1)))',
			params: ['x'],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND NOT (posts_exists_0.title = $1)))',
			params: ['x'],
		});
	});
	it('tests none only over visible children', () => {
		const build = cases['none'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users."deletedAt" IS NULL AND NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0."deletedAt" IS NULL AND posts_exists_0.title = $1))',
			params: ['x'],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0.title = $1))',
			params: ['x'],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0.title = $1))',
			params: ['x'],
		});
	});
	it('filters unoptimized IN subquery bodies', () => {
		const build = cases['inBody'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users."deletedAt" IS NULL AND users.name = ANY (SELECT posts_subq_0.title FROM posts AS posts_subq_0 WHERE posts_subq_0."deletedAt" IS NULL)',
			params: [],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users.name = ANY (SELECT posts_subq_0.title FROM posts AS posts_subq_0)',
			params: [],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users.name = ANY (SELECT posts_subq_0.title FROM posts AS posts_subq_0)',
			params: [],
		});
	});
	it('filters intermediate and final dotted relation hops', () => {
		const build = cases['dotted'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1."postId" AND comments_exists_1."deletedAt" IS NULL AND comments_exists_1.id = $1))',
			params: [3],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1."postId" AND comments_exists_1.id = $1))',
			params: [3],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1."postId" AND comments_exists_1.id = $1))',
			params: [3],
		});
	});
	it('filters left joins inside exists in ON', () => {
		const build = cases['existsInclude'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM posts AS posts_exists_0 LEFT JOIN users AS author ON posts_exists_0."authorId" = author.id AND author."deletedAt" IS NULL WHERE users.id = posts_exists_0."authorId" AND posts_exists_0."deletedAt" IS NULL AND author.name = $1)',
			params: ['x'],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 LEFT JOIN users AS author ON posts_exists_0."authorId" = author.id WHERE users.id = posts_exists_0."authorId" AND author.name = $1)',
			params: ['x'],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 LEFT JOIN users AS author ON posts_exists_0."authorId" = author.id WHERE users.id = posts_exists_0."authorId" AND author.name = $1)',
			params: ['x'],
		});
	});
	it('filters explicit relation joins in ON', () => {
		const build = cases['relationJoin'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT posts.* FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id AND author."deletedAt" IS NULL WHERE posts."deletedAt" IS NULL',
			params: [],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT posts.* FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id',
			params: [],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: 'SELECT posts.* FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id',
			params: [],
		});
	});
	it('filters explicit table joins in ON', () => {
		const build = cases['tableJoin'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT posts.* FROM posts LEFT JOIN users AS u ON posts."authorId" = u.id AND u."deletedAt" IS NULL WHERE posts."deletedAt" IS NULL',
			params: [],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT posts.* FROM posts LEFT JOIN users AS u ON posts."authorId" = u.id',
			params: [],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: 'SELECT posts.* FROM posts LEFT JOIN users AS u ON posts."authorId" = u.id',
			params: [],
		});
	});
	it('filters hand-written exists subquery bodies', () => {
		const build = cases['rawExists'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users."deletedAt" IS NULL AND EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.title = $1 AND posts_sq."deletedAt" IS NULL)',
			params: ['x'],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.title = $1)',
			params: ['x'],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.title = $1)',
			params: ['x'],
		});
	});
	it('filters hand-written not-exists subquery bodies', () => {
		const build = cases['rawNotExists'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users."deletedAt" IS NULL AND NOT (EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.title = $1 AND posts_sq."deletedAt" IS NULL))',
			params: ['x'],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE NOT (EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.title = $1))',
			params: ['x'],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE NOT (EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.title = $1))',
			params: ['x'],
		});
	});
	it('filters optimized IN subquery scans', () => {
		const build = cases['inSubquery'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0."deletedAt" IS NULL AND posts_exists_0.title = $1)',
			params: ['x'],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0.title = $1)',
			params: ['x'],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0.title = $1)',
			params: ['x'],
		});
	});
	it('filters scalar comparison subquery bodies', () => {
		const build = cases['scalar'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users."deletedAt" IS NULL AND users.id = (SELECT posts_subq_0.id FROM posts AS posts_subq_0 WHERE posts_subq_0."deletedAt" IS NULL)',
			params: [],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users.id = (SELECT posts_subq_0.id FROM posts AS posts_subq_0)',
			params: [],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users.id = (SELECT posts_subq_0.id FROM posts AS posts_subq_0)',
			params: [],
		});
	});
	it('filters expression subquery bodies', () => {
		const build = cases['expression'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT (SELECT posts.id FROM posts WHERE posts."deletedAt" IS NULL) AS "postId" FROM users WHERE users."deletedAt" IS NULL',
			params: [],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT (SELECT posts.id FROM posts) AS "postId" FROM users',
			params: [],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: 'SELECT (SELECT posts.id FROM posts) AS "postId" FROM users',
			params: [],
		});
	});
	it('prevents plan options from discarding the ORM filter map', () => {
		const build = cases['carrier'];
		if (!build) throw new Error('Missing query factory');
		const filtered = build(orm).dump();
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author."deletedAt" AS "author.deletedAt", author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id AND author."deletedAt" IS NULL WHERE posts."deletedAt" IS NULL',
			params: [],
		});
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author."deletedAt" AS "author.deletedAt", author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id',
			params: [],
		});
		const view = build(orm.withoutDefaultFilters()).dump();
		expect({ sql: view.sql, params: view.params }).toEqual({
			sql: 'SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author."deletedAt" AS "author.deletedAt", author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id',
			params: [],
		});
	});
});

describe('default filters on unsupported read paths', () => {
	const builds = {
		set: (o: typeof orm) =>
			o.select('posts').join('author').union(o.select('posts')),
		rawCte: (o: typeof orm) =>
			o.recursive('walk', {
				base: o.select('users').include('authored'),
				step: o.select('users'),
			}),
		cte: (o: typeof orm) =>
			o
				.withCte('lookups')
				.fromUnnest({ id: [1] })
				.query(o.select('users').include('authored')),
		nql: (o: typeof orm) => o.nql`users | select id`,
	};
	it('filters non-root scans in set reads and allows the ORM opt-out', () => {
		expect(builds.set(orm).dump().sql).toBe(
			'SELECT posts.* FROM posts JOIN users AS author ON posts."authorId" = author.id AND author."deletedAt" IS NULL WHERE posts."deletedAt" IS NULL UNION SELECT posts.* FROM posts WHERE posts."deletedAt" IS NULL',
		);
		expect(builds.set(orm.withoutDefaultFilters()).dump().sql).toBe(
			'SELECT posts.* FROM posts JOIN users AS author ON posts."authorId" = author.id UNION SELECT posts.* FROM posts',
		);
	});
	it('filters non-root scans in rawCte reads and allows the ORM opt-out', () => {
		expect(builds.rawCte(orm).dump().sql).toBe(
			'WITH RECURSIVE walk AS (SELECT users.*, COALESCE((SELECT json_agg(jsonb_build_object(\'id\', __t__.id, \'title\', __t__.title, \'deletedAt\', __t__."deletedAt", \'authorId\', __t__."authorId") ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__."authorId" = users.id AND __t__."deletedAt" IS NULL), \'[]\'::json) AS authored_json FROM users WHERE users."deletedAt" IS NULL UNION ALL SELECT users.* FROM users WHERE users."deletedAt" IS NULL) SELECT walk.* FROM walk',
		);
		expect(builds.rawCte(orm.withoutDefaultFilters()).dump().sql).toBe(
			"WITH RECURSIVE walk AS (SELECT users.*, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'title', __t__.title, 'deletedAt', __t__.\"deletedAt\", 'authorId', __t__.\"authorId\") ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__.\"authorId\" = users.id), '[]'::json) AS authored_json FROM users UNION ALL SELECT users.* FROM users) SELECT walk.* FROM walk",
		);
	});
	it('filters non-root scans in cte reads and allows the ORM opt-out', () => {
		expect(builds.cte(orm).dump().sql).toBe(
			'WITH lookups AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT users.*, COALESCE((SELECT json_agg(jsonb_build_object(\'id\', __t__.id, \'title\', __t__.title, \'deletedAt\', __t__."deletedAt", \'authorId\', __t__."authorId") ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__."authorId" = users.id AND __t__."deletedAt" IS NULL), \'[]\'::json) AS authored_json FROM users WHERE users."deletedAt" IS NULL',
		);
		expect(builds.cte(orm.withoutDefaultFilters()).dump().sql).toBe(
			"WITH lookups AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT users.*, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'title', __t__.title, 'deletedAt', __t__.\"deletedAt\", 'authorId', __t__.\"authorId\") ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__.\"authorId\" = users.id), '[]'::json) AS authored_json FROM users",
		);
	});
	it('filters NQL roots and allows the ORM opt-out', () => {
		expect(builds.nql(orm).dump().sql).toBe(
			'SELECT users.id FROM users WHERE users."deletedAt" IS NULL',
		);
		expect(builds.nql(orm.withoutDefaultFilters()).dump().sql).toBe(
			'SELECT users.id FROM users',
		);
	});

	it('refuses a default filter that resolves a relation range by its table name', () => {
		// Bypass eager schema validation to exercise the planning-time defense.
		const invalidSchema = schema(db.definition, undefined, {
			defaultFilters: { posts: isNull('deletedAt') },
		});
		if (!invalidSchema.defaultFilters) throw new Error('Missing filters');
		invalidSchema.defaultFilters.posts = eq('author.name', 'x');
		const invalid = createOrm({
			schema: invalidSchema,
			adapter: createPgCompileOnlyAdapter(),
		});
		expect(() => invalid.select('posts').dump()).toThrowError(
			new Error(
				"Default filter for table 'posts' must reference only its own scan. forbidden condition kind 'relation'",
			),
		);
		expect(invalid.select('posts').withoutDefaultFilters().dump().sql).toBe(
			'SELECT posts.* FROM posts',
		);
	});
	it('refuses invalid target filters before compiling an include scan', () => {
		// Bypass eager schema validation to exercise the planning-time defense.
		const invalidSchema = schema(db.definition, undefined, {
			defaultFilters: { users: isNull('deletedAt') },
		});
		if (!invalidSchema.defaultFilters) throw new Error('Missing filters');
		invalidSchema.defaultFilters.users = exists('authored');
		const invalid = createOrm({
			schema: invalidSchema,
			adapter: createPgCompileOnlyAdapter(),
		});
		expect(() => invalid.select('posts').include('author').dump()).toThrowError(
			new Error(
				"Default filter for table 'users' must reference only its own scan. forbidden condition kind 'relation'",
			),
		);
		expect(
			invalid.withoutDefaultFilters().select('posts').include('author').dump()
				.sql,
		).toBe(
			"SELECT posts.*, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'name', __t__.name, 'deletedAt', __t__.\"deletedAt\") ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts.\"authorId\"), '[]'::json) AS author_json FROM posts",
		);
	});
	it('keeps the original ORM filtered after creating an opt-out view', () => {
		const view = orm.withoutDefaultFilters();
		expect(view.select('users').dump().sql).toBe('SELECT users.* FROM users');
		expect(orm.select('users').dump().sql).toBe(
			'SELECT users.* FROM users WHERE users."deletedAt" IS NULL',
		);
		expect(orm.from(orm.tables.users).dump().sql).toBe(
			'SELECT users.* FROM users WHERE users."deletedAt" IS NULL',
		);
	});
});

describe('default filters at every relation hop', () => {
	it('filters intermediate and target scans for exists', () => {
		const build = (o: typeof orm) =>
			o
				.select('users')
				.where(exists('authored.comments', { where: eq('id', 3) }));
		const filtered = build(orm).dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1."postId" AND comments_exists_1."deletedAt" IS NULL AND comments_exists_1.id = $1))',
			params: [3],
		});
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1."postId" AND comments_exists_1.id = $1))',
			params: [3],
		});
	});
	it('filters intermediate and target scans for notExists', () => {
		const build = (o: typeof orm) =>
			o
				.select('users')
				.where(notExists('authored.comments', { where: eq('id', 3) }));
		const filtered = build(orm).dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users."deletedAt" IS NULL AND NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1."postId" AND comments_exists_1."deletedAt" IS NULL AND comments_exists_1.id = $1)))',
			params: [3],
		});
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1."postId" AND comments_exists_1.id = $1)))',
			params: [3],
		});
	});
	it('filters intermediate and target scans for every', () => {
		const build = (o: typeof orm) =>
			o.select('users').where({
				kind: 'relationFilter',
				relation: 'authored.comments',
				mode: 'every',
				where: eq('id', 3),
			});
		const filtered = build(orm).dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users."deletedAt" IS NULL AND NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1."postId" AND comments_exists_1."deletedAt" IS NULL AND NOT (comments_exists_1.id = $1))))',
			params: [3],
		});
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1."postId" AND NOT (comments_exists_1.id = $1))))',
			params: [3],
		});
	});
	it('filters intermediate and target scans for none', () => {
		const build = (o: typeof orm) =>
			o.select('users').where({
				kind: 'relationFilter',
				relation: 'authored.comments',
				mode: 'none',
				where: eq('id', 3),
			});
		const filtered = build(orm).dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE users."deletedAt" IS NULL AND NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1."postId" AND comments_exists_1."deletedAt" IS NULL AND comments_exists_1.id = $1)))',
			params: [3],
		});
		const unfiltered = build(orm).withoutDefaultFilters().dump();
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT users.* FROM users WHERE NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1."postId" AND comments_exists_1.id = $1)))',
			params: [3],
		});
	});
});

it('filters recursive include anchor and step and allows its builder opt-out', () => {
	const rec = schema(
		{
			categories: {
				id: { type: 'integer', primaryKey: true },
				parentId: ref('categories', {
					nullable: true,
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		},
		undefined,
		{ defaultFilters: { categories: eq('id', 1) } },
	);
	const recursiveOrm = createOrm({
		schema: rec,
		adapter: createPgCompileOnlyAdapter(),
	});
	const query = recursiveOrm
		.select('categories')
		.include('children', { recursive: true, direction: 'descendants' });
	const filtered = query.dump();
	expect(filtered.params).toEqual([1, 1, 1]);
	expect(filtered.sql).toContain('__n.id = $2');
	expect(filtered.sql).toContain('__n.id = $3');
	expect(filtered.sql).toContain('WHERE categories.id = $1');
	expect(query.withoutDefaultFilters().dump().sql).toBe(
		'SELECT categories.*, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n.id AS id, __n."parentId" AS "parentId", 1 AS __depth, array_remove(ARRAY[categories.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM categories AS __n WHERE __n."parentId" = categories.id AND __n.id IS DISTINCT FROM categories.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n."parentId" AS "parentId", children_walk.__depth + 1 AS __depth, children_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM children_walk JOIN categories AS __n ON __n."parentId" = children_walk.id WHERE children_walk.__depth < 100 AND __n.id <> ALL (children_walk.__visited)), children_output AS (SELECT children_walk.id, children_walk."parentId", children_walk.__depth, children_walk.__visited, children_walk.__node_text, children_walk.__parent_text FROM children_walk UNION ALL SELECT categories.id AS id, categories."parentId" AS "parentId", 0 AS __depth, array_remove(ARRAY[categories.id], NULL) AS __visited, CAST(categories.id AS text) AS __node_text, CAST(categories."parentId" AS text) AS __parent_text) SELECT json_agg(json_build_object(\'id\', children_walk.id, \'parentId\', children_walk."parentId", \'__dbsp_node\', children_walk.__node_text, \'__dbsp_parent\', children_walk.__parent_text, \'__dbsp_depth\', children_walk.__depth) ORDER BY children_walk.__depth, children_walk.id) FROM children_output AS children_walk), \'[]\'::json) AS children_json FROM categories',
	);
	expect(
		recursiveOrm
			.withoutDefaultFilters()
			.select('categories')
			.include('children', { recursive: true, direction: 'descendants' })
			.dump().sql,
	).toBe(
		'SELECT categories.*, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n.id AS id, __n."parentId" AS "parentId", 1 AS __depth, array_remove(ARRAY[categories.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM categories AS __n WHERE __n."parentId" = categories.id AND __n.id IS DISTINCT FROM categories.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n."parentId" AS "parentId", children_walk.__depth + 1 AS __depth, children_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM children_walk JOIN categories AS __n ON __n."parentId" = children_walk.id WHERE children_walk.__depth < 100 AND __n.id <> ALL (children_walk.__visited)), children_output AS (SELECT children_walk.id, children_walk."parentId", children_walk.__depth, children_walk.__visited, children_walk.__node_text, children_walk.__parent_text FROM children_walk UNION ALL SELECT categories.id AS id, categories."parentId" AS "parentId", 0 AS __depth, array_remove(ARRAY[categories.id], NULL) AS __visited, CAST(categories.id AS text) AS __node_text, CAST(categories."parentId" AS text) AS __parent_text) SELECT json_agg(json_build_object(\'id\', children_walk.id, \'parentId\', children_walk."parentId", \'__dbsp_node\', children_walk.__node_text, \'__dbsp_parent\', children_walk.__parent_text, \'__dbsp_depth\', children_walk.__depth) ORDER BY children_walk.__depth, children_walk.id) FROM children_output AS children_walk), \'[]\'::json) AS children_json FROM categories',
	);
});

it('keeps expression scan filters after duplicate root projections are removed', () => {
	const build = (o: typeof orm) =>
		o
			.select('users')
			.columns(['id', 'id', subquery('posts').select('id').asExpr('postId')]);
	expect(build(orm).dump().sql).toBe(
		'SELECT users.id, (SELECT posts.id FROM posts WHERE posts."deletedAt" IS NULL) AS "postId" FROM users WHERE users."deletedAt" IS NULL',
	);
	expect(build(orm).withoutDefaultFilters().dump().sql).toBe(
		'SELECT users.id, (SELECT posts.id FROM posts) AS "postId" FROM users',
	);
});

it('keeps a separate resolved predicate for each scan of a reused expression query', () => {
	const query = subquery('posts').select('id').build();
	const build = (o: typeof orm) =>
		o
			.select('users')
			.columns([query.asExpr('postOne'), query.asExpr('postTwo')]);
	const planned = build(orm).plan();
	expect(
		new Set(
			planned.execution?.expressionSubqueries?.map(
				(entry) => entry.select.execution.rootRange.id,
			),
		).size,
	).toBe(2);
	expect(build(orm).dump().sql).toBe(
		'SELECT (SELECT posts.id FROM posts WHERE posts."deletedAt" IS NULL) AS "postOne", (SELECT posts_1.id FROM posts AS posts_1 WHERE posts_1."deletedAt" IS NULL) AS "postTwo" FROM users WHERE users."deletedAt" IS NULL',
	);
	expect(build(orm).withoutDefaultFilters().dump().sql).toBe(
		'SELECT (SELECT posts.id FROM posts) AS "postOne", (SELECT posts_1.id FROM posts AS posts_1) AS "postTwo" FROM users',
	);
});

describe('default filters in SELECT expression conditions', () => {
	const builds = {
		having: (o: typeof orm) =>
			o
				.select('users')
				.count()
				.having(rawExists(subquery('posts').select('id'))),
		casePredicate: (o: typeof orm) =>
			o
				.select('users')
				.columns([
					caseWhen(exists('authored'), literal(1))
						.else(literal(0))
						.as('hasPosts'),
				]),
		filterPredicate: (o: typeof orm) =>
			o
				.select('users')
				.columns([
					fn('count', star()).filter(exists('authored')).as('visibleCount'),
				]),
		joinProjection: (o: typeof orm) =>
			o
				.select('posts')
				.join('author', { type: 'left' })
				.columns([relationColumn('author', 'name', 'authorName')]),
	};
	it('filters subquery scans in HAVING', () => {
		const filtered = builds.having(orm).dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT count(*) FROM users WHERE users."deletedAt" IS NULL HAVING EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq."deletedAt" IS NULL)',
			params: [],
		});
		const unfiltered = builds.having(orm).withoutDefaultFilters().dump();
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT count(*) FROM users HAVING EXISTS (SELECT posts_sq.id FROM posts AS posts_sq)',
			params: [],
		});
	});
	it('filters relation scans in CASE conditions', () => {
		const filtered = builds.casePredicate(orm).dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT CASE WHEN EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0."deletedAt" IS NULL) THEN 1 ELSE 0 END AS "hasPosts" FROM users WHERE users."deletedAt" IS NULL',
			params: [],
		});
		const unfiltered = builds.casePredicate(orm).withoutDefaultFilters().dump();
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT CASE WHEN EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId") THEN 1 ELSE 0 END AS "hasPosts" FROM users',
			params: [],
		});
	});
	it('filters relation scans in aggregate FILTER conditions', () => {
		const filtered = builds.filterPredicate(orm).dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0."deletedAt" IS NULL)) AS "visibleCount" FROM users WHERE users."deletedAt" IS NULL',
			params: [],
		});
		const unfiltered = builds
			.filterPredicate(orm)
			.withoutDefaultFilters()
			.dump();
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId")) AS "visibleCount" FROM users',
			params: [],
		});
	});
	it('preserves filters when projecting fields from an explicit join', () => {
		const filtered = builds.joinProjection(orm).dump();
		expect({ sql: filtered.sql, params: filtered.params }).toEqual({
			sql: 'SELECT author.name AS "authorName" FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id AND author."deletedAt" IS NULL WHERE posts."deletedAt" IS NULL',
			params: [],
		});
		const unfiltered = builds
			.joinProjection(orm)
			.withoutDefaultFilters()
			.dump();
		expect({ sql: unfiltered.sql, params: unfiltered.params }).toEqual({
			sql: 'SELECT author.name AS "authorName" FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id',
			params: [],
		});
	});
});

// orm.selectExpression() applies the ORM's read policy to its subquery bodies,
// and a policy issued by a nested builder applies whatever the outer filters
// (#891, slice 1).
describe('selectExpression bodies and nested issued policies', () => {
	const definition = {
		users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			score: 'integer',
			deleted_at: { type: 'timestamp', nullable: true },
			author_id: ref('users', { as: 'author' }),
		},
		comments: {
			id: { type: 'integer', primaryKey: true },
			deleted_at: { type: 'timestamp', nullable: true },
			post_id: ref('posts', { as: 'post' }),
		},
	} as const;
	const filters = {
		posts: isNull('deleted_at'),
		comments: isNull('deleted_at'),
	};
	const filteredDb = schema(definition, undefined, { defaultFilters: filters });
	const plainDb = schema(definition);
	const adapter = createPgCompileOnlyAdapter({ model: filteredDb.model });
	const filtered = createOrm({
		schema: filteredDb,
		adapter,
		suppressDxWarnings: true,
	});
	const plain = createOrm({
		schema: plainDb,
		adapter: createPgCompileOnlyAdapter({ model: plainDb.model }),
		suppressDxWarnings: true,
	});
	const outer = filtered.withoutDefaultFilters();
	// rawExists() accepts an ORM builder at runtime, as its JSDoc example shows;
	// its public type does not list QueryBuilder yet, hence the cast.
	const issuedPosts = () =>
		filtered.select('posts').columns(['id']) as unknown as Parameters<
			typeof rawExists
		>[0];
	const nestedPolicyBody = () =>
		subquery('users').where(rawExists(issuedPosts())).count().asExpr('n');

	it('filters the body table', () => {
		const result = filtered.selectExpression(
			subquery('posts').where(eq('score', 1)).max('score').asExpr('m'),
		);
		expect(result.sql).toBe(
			'SELECT (SELECT max(posts.score) FROM posts WHERE posts.deleted_at IS NULL AND posts.score = $1) AS m',
		);
		expect(result.parameters).toEqual([1]);
	});

	it('filters a relation scanned inside the body', () => {
		expect(
			filtered.selectExpression(
				subquery('posts').where(exists('comments')).count().asExpr('n'),
			).sql,
		).toBe(
			'SELECT (SELECT count(*) FROM posts WHERE posts.deleted_at IS NULL AND EXISTS (SELECT 1 FROM comments AS comments_exists_0 WHERE posts.id = comments_exists_0.post_id AND comments_exists_0.deleted_at IS NULL)) AS n',
		);
	});

	it('filters a body nested in an operator', () => {
		expect(
			filtered.selectExpression(
				op('+', subquery('posts').max('score').asExpr('m'), literal(1)),
			).sql,
		).toBe(
			'SELECT (SELECT max(posts.score) FROM posts WHERE posts.deleted_at IS NULL) + 1',
		);
	});

	it('renumbers the parameters of sibling bodies', () => {
		const result = filtered.selectExpression(
			op(
				'+',
				subquery('posts').where(eq('score', 1)).count().asExpr('a'),
				subquery('posts').where(eq('score', 2)).count().asExpr('b'),
			),
		);
		expect(result.sql).toBe(
			'SELECT (SELECT count(*) FROM posts WHERE posts.deleted_at IS NULL AND posts.score = $1) + (SELECT count(*) FROM posts WHERE posts.deleted_at IS NULL AND posts.score = $2)',
		);
		expect(result.parameters).toEqual([1, 2]);
	});

	it('compiles an unfiltered body as an issued plan', () => {
		expect(
			plain.selectExpression(subquery('posts').max('score').asExpr('m')).sql,
		).toBe('SELECT (SELECT max(posts.score) FROM posts) AS m');
	});

	it('keeps the schema of withSchema', () => {
		expect(
			filtered
				.withSchema('t1')
				.selectExpression(
					subquery('posts').where(eq('score', 1)).max('score').asExpr('m'),
				).sql,
		).toBe(
			'SELECT (SELECT max(posts.score) FROM t1.posts WHERE posts.deleted_at IS NULL AND posts.score = $1) AS m',
		);
	});

	it('applies a nested builder policy in the body WHERE without outer filters', () => {
		expect(outer.selectExpression(nestedPolicyBody()).sql).toBe(
			'SELECT (SELECT count(*) FROM users WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.deleted_at IS NULL)) AS n',
		);
	});

	it('applies a nested builder policy in a SELECT-column body without outer filters', () => {
		expect(
			outer.select('users').columns(['id', nestedPolicyBody()]).dump().sql,
		).toBe(
			'SELECT users.id, (SELECT count(*) FROM users AS users_1 WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.deleted_at IS NULL)) AS n FROM users',
		);
	});

	it('applies a nested builder policy in a scalar projected by a selectExpression body', () => {
		const projecting = new SubqueryExpression({
			type: 'select',
			from: 'users',
			select: {
				type: 'expressions',
				columns: [nestedPolicyBody().intent],
			},
			limit: 1,
		} as unknown as ConstructorParameters<typeof SubqueryExpression>[0]);
		expect(outer.selectExpression(projecting).sql).toBe(
			'SELECT (SELECT (SELECT count(*) FROM users AS users_1 WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.deleted_at IS NULL)) AS n FROM users LIMIT 1)',
		);
	});

	describe('a scalar body under a named argument', () => {
		it('keeps a nested builder policy in a scalar body WHERE', () => {
			expect(
				outer
					.select('users')
					.columns([
						subquery('users')
							.where(
								fn(
									'date_part',
									literal('epoch'),
									fn('make_interval', namedArg('secs', nestedPolicyBody())),
								).gt(0),
							)
							.count()
							.asExpr('m'),
					])
					.dump().sql,
			).toBe(
				"SELECT (SELECT count(*) FROM users AS users_1 WHERE date_part('epoch', make_interval(secs => (SELECT count(*) FROM users AS users_2 WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.deleted_at IS NULL)))) > $1) AS m FROM users",
			);
		});

		it('keeps a nested builder policy in a projected column', () => {
			expect(
				outer
					.select('users')
					.columns([
						fn('make_interval', namedArg('secs', nestedPolicyBody())).as('iv'),
					])
					.dump().sql,
			).toBe(
				'SELECT make_interval(secs => (SELECT count(*) FROM users AS users_1 WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.deleted_at IS NULL))) AS iv FROM users',
			);
		});

		it('keeps the default filter of the scalar body', () => {
			expect(
				filtered
					.select('users')
					.columns([
						fn(
							'make_interval',
							namedArg('secs', subquery('posts').count().asExpr('c')),
						).as('iv'),
					])
					.dump().sql,
			).toBe(
				'SELECT make_interval(secs => (SELECT count(*) FROM posts WHERE posts.deleted_at IS NULL)) AS iv FROM users',
			);
		});
	});

	it('compiles an aggregate FILTER in a scalar body the resolved route plans', () => {
		const scalar = new SubqueryExpression({
			type: 'select',
			from: 'posts',
			where: rawExists(issuedPosts()),
			select: {
				type: 'aggregate',
				aggregates: [{ function: 'count', field: '*', filter: eq('score', 1) }],
			},
		} as never).asExpr('n');
		const dumped = outer.select('users').columns([scalar]).dump();
		expect({ sql: dumped.sql, params: dumped.params }).toEqual({
			sql: 'SELECT (SELECT count(*) FILTER (WHERE posts.score = $1) FROM posts WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.deleted_at IS NULL)) AS n FROM users',
			params: [1],
		});
	});

	it('compiles an aggregate FILTER in an EXISTS body, where only existence counts', () => {
		const body = new SubqueryExpression({
			type: 'select',
			from: 'posts',
			select: {
				type: 'aggregate',
				aggregates: [{ function: 'count', field: '*', filter: eq('id', 1) }],
			},
		} as never);
		expect(filtered.select('users').where(rawExists(body)).dump().sql).toBe(
			'SELECT users.* FROM users WHERE EXISTS (SELECT count(*) FROM posts AS posts_sq WHERE posts_sq.deleted_at IS NULL)',
		);
	});

	describe('an IN body carrying its own policy is not rewritten to EXISTS', () => {
		const inBody = (orm: typeof filtered) =>
			new SubqueryExpression(
				rawExists(
					orm.select('posts').columns(['author_id']) as unknown as Parameters<
						typeof rawExists
					>[0],
				).subquery,
			);
		it('keeps a nested opt-out in a selectExpression body', () => {
			expect(
				filtered.selectExpression(
					subquery('users')
						.where(inSubquery('id', inBody(filtered.withoutDefaultFilters())))
						.count()
						.asExpr('n'),
				).sql,
			).toBe(
				'SELECT (SELECT count(*) FROM users WHERE users.id = ANY (SELECT posts_subq_0.author_id FROM posts AS posts_subq_0)) AS n',
			);
		});
		it('keeps a nested filtered builder under an unfiltered ORM', () => {
			expect(
				outer.selectExpression(
					subquery('users')
						.where(inSubquery('id', inBody(filtered)))
						.count()
						.asExpr('n'),
				).sql,
			).toBe(
				'SELECT (SELECT count(*) FROM users WHERE users.id = ANY (SELECT posts_subq_0.author_id FROM posts AS posts_subq_0 WHERE posts_subq_0.deleted_at IS NULL)) AS n',
			);
		});
		it('keeps a nested opt-out in a root WHERE', () => {
			expect(
				filtered
					.select('users')
					.where(inSubquery('id', inBody(filtered.withoutDefaultFilters())))
					.dump().sql,
			).toBe(
				'SELECT users.* FROM users WHERE users.id = ANY (SELECT posts_subq_0.author_id FROM posts AS posts_subq_0)',
			);
		});
	});

	it('does not walk bound payloads looking for nested policies', () => {
		const docsDb = schema({
			docs: { id: { type: 'integer', primaryKey: true }, payload: 'json' },
		});
		const docs = createOrm({
			schema: docsDb,
			adapter: createPgCompileOnlyAdapter({ model: docsDb.model }),
			suppressDxWarnings: true,
		});
		let payload: Record<string, unknown> = { leaf: 1 };
		for (let i = 0; i < 4000; i++) payload = { child: payload };
		// plan() is where the nested-policy gate runs; a deep payload must not
		// make it recurse (dump() serialises parameters separately).
		const planned = docs
			.select('docs')
			.columns([
				subquery('docs').where(eq('payload', payload)).count().asExpr('n'),
			])
			.plan();
		expect(planned.intent.from).toBe('docs');
	});

	it('refuses an outerRef in a FROM-less body', () => {
		expect(
			() =>
				filtered.selectExpression(
					subquery('posts')
						.where(eq('author_id', outerRef('users.id')))
						.max('score')
						.asExpr('m'),
				).sql,
		).toThrow('outerRef() requires an enclosing query range.');
	});

	const projectNested = (query: Record<string, unknown>) =>
		adapter.compile(
			plan(
				{
					type: 'select',
					from: 'users',
					select: {
						type: 'expressions',
						columns: [{ kind: 'subquery', as: 'v', query }],
					},
				} as never,
				filteredDb.model,
			),
		);
	const nestedPolicyWhere = () => rawExists(issuedPosts());

	it('compiles a nested-policy body with an expression SELECT', () => {
		expect(
			projectNested({
				type: 'select',
				from: 'users',
				where: nestedPolicyWhere(),
				select: {
					type: 'expressions',
					columns: [fn('lower', exprRef('name')).as('l').intent],
				},
				limit: 1,
			}),
		).toMatchObject({
			sql: 'SELECT (SELECT lower(name) AS l FROM users AS users_1 WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.deleted_at IS NULL) LIMIT 1) AS v FROM users',
			parameters: [],
		});
	});

	it('compiles a nested-policy body with GROUP BY and HAVING', () => {
		expect(
			projectNested({
				type: 'select',
				from: 'users',
				where: nestedPolicyWhere(),
				select: { type: 'fields', fields: ['id'] },
				groupBy: ['id'],
				having: { kind: 'comparison', field: 'id', operator: 'gt', value: 0 },
				limit: 1,
			}),
		).toMatchObject({
			sql: 'SELECT (SELECT users_1.id FROM users AS users_1 WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.deleted_at IS NULL) GROUP BY users_1.id HAVING users_1.id > $1 LIMIT 1) AS v FROM users',
			parameters: [0],
		});
	});
});

describe('dotted fields outside conditions under default filters (#891 slice 3)', () => {
	it('AC8 orders by a joined alias column when the joined table has a default filter', () => {
		const joinedDb = schema(
			{
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'text',
					deletedAt: { type: 'timestamp', nullable: true },
				},
				posts: {
					id: { type: 'integer', primaryKey: true },
					title: 'text',
					authorId: ref('users', { as: 'author', inverse: 'posts' }),
				},
			},
			undefined,
			{ defaultFilters: { users: isNull('deletedAt') } },
		);
		const joinedOrm = createOrm({
			schema: joinedDb,
			adapter: createPgCompileOnlyAdapter(),
			suppressDxWarnings: true,
		});
		const result = joinedOrm
			.select('posts')
			.join('author')
			.orderBy('author.name')
			.dump();
		expect(result.sql).toBe(
			'SELECT posts.* FROM posts JOIN users AS author ON posts."authorId" = author.id AND author."deletedAt" IS NULL ORDER BY author.name ASC',
		);
		expect(result.params).toEqual([]);
	});
});
