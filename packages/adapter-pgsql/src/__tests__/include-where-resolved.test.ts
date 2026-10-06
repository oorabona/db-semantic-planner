import { readdirSync, readFileSync } from 'node:fs';
import {
	and,
	createOrm,
	eq,
	exists,
	exprRef,
	fn,
	inSubquery,
	outerRef,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { describe, expect, it, vi } from 'vitest';
import { createPlanReportForQuery } from '../adapter-compiler-recursive.js';
import {
	createNqlBindingSelectPlan,
	createPgCompileOnlyAdapter,
} from '../pgsql-adapter.js';
import { conditionMatrix } from './condition-matrix.cases.js';

const tripwire = vi.hoisted(() => ({ active: false }));
vi.mock('../condition-compiler.js', async (importOriginal) => {
	const original =
		await importOriginal<typeof import('../condition-compiler.js')>();
	return {
		...original,
		compileCondition: (
			...args: Parameters<typeof original.compileCondition>
		) => {
			if (tripwire.active) throw new Error('include used compileCondition');
			return original.compileCondition(...args);
		},
		compileWhereIntent: (
			...args: Parameters<typeof original.compileWhereIntent>
		) => {
			if (tripwire.active) throw new Error('include used compileWhereIntent');
			return original.compileWhereIntent(...args);
		},
	};
});
function withoutLegacyCompilation<T>(run: () => T): T {
	tripwire.active = true;
	try {
		return run();
	} finally {
		tripwire.active = false;
	}
}
const model = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'text',
		email: 'text',
		managerId: ref('users', {
			roles: { parent: 'manager', children: 'reports' },
		}),
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'text',
		authorId: ref('users', { as: 'author', inverse: 'authored' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		body: 'text',
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
	},
}).model;
const adapter = createPgCompileOnlyAdapter({ model });
const orm = createOrm({ model, adapter });
const prefix =
	'SELECT comments.*, post.id AS "post.id", post.title AS "post.title", post."authorId" AS "post.authorId", post.id AS __dbsp_presence_post, author.id AS "post.author.id", author.name AS "post.author.name", author.email AS "post.author.email", author."managerId" AS "post.author.managerId", author.id AS "__dbsp_presence_post.author" FROM comments LEFT JOIN posts AS post ON comments."postId" = post.id LEFT JOIN users AS author ON post."authorId" = author.id';
describe('resolved include predicates', () => {
	it('compiles the complete include condition inventory without legacy compilation or relation lookup', () => {
		const directory = new URL('./condition-matrix/', import.meta.url);
		const baseline = readdirSync(directory)
			.filter((name) => /^include-(inner|left)-where/.test(name))
			.flatMap(
				(name) =>
					JSON.parse(readFileSync(new URL(name, directory), 'utf8')).entries,
			);
		const entries = conditionMatrix.filter((entry) =>
			/^include-(inner|left)-where$/.test(entry.position),
		);
		expect(entries).toHaveLength(638);
		tripwire.active = true;
		try {
			for (const entry of entries) {
				const expected = baseline.find(
					(b: { position: string; shape: string; kind: string }) =>
						b.position === entry.position &&
						b.shape === entry.shape &&
						b.kind === entry.kind,
				);
				expect(entry.run()).toEqual({
					sql: expected.sql,
					params: expected.params,
					error: expected.error,
				});
			}
		} finally {
			tripwire.active = false;
		}
	});
	for (const target of ['title', 'post.title', 'comments.body'])
		it(`binds the nested outer reference ${target}`, () => {
			const result = orm
				.select('comments')
				.include('post', {
					join: 'left',
					include: [
						{
							relation: 'author',
							join: 'left',
							where: eq('name', outerRef(target)),
						},
					],
				})
				.dump();
			expect(result).toMatchObject({
				sql: `${prefix} WHERE author.name = ${target === 'comments.body' ? 'comments.body' : 'post.title'}`,
				params: [],
			});
		});
	for (const target of ['name', 'users.name', 'post.title'])
		it(`searches ancestor ranges nearest first for ${target}`, () => {
			const result = orm
				.select('comments')
				.include('post', {
					join: 'left',
					include: [
						{
							relation: 'author',
							join: 'left',
							include: [
								{
									relation: 'manager',
									join: 'left',
									where: eq('name', outerRef(target)),
								},
							],
						},
					],
				})
				.dump();
			expect(result.sql).toBe(
				`${prefix.replace(' FROM comments', ', manager.id AS "post.author.manager.id", manager.name AS "post.author.manager.name", manager.email AS "post.author.manager.email", manager."managerId" AS "post.author.manager.managerId", manager.id AS "__dbsp_presence_post.author.manager" FROM comments')} LEFT JOIN users AS manager ON author."managerId" = manager.id WHERE manager.name = ${target === 'post.title' ? 'post.title' : 'author.name'}`,
			);
			expect(result.params).toEqual([]);
		});
	it('qualifies expressions and merges duplicate predicates in authored order', () => {
		const result = orm
			.select('posts')
			.include('author', {
				join: 'left',
				where: fn('lower', exprRef('email')).eq('a'),
			})
			.include('author', { join: 'left', where: eq('name', 'n') })
			.dump();
		expect(result.sql).toBe(
			'SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author.email AS "author.email", author."managerId" AS "author.managerId", author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id WHERE lower(author.email) = $1 AND author.name = $2',
		);
		expect(result.params).toEqual(['a', 'n']);
	});
	it('keeps root and include parameters before manual join parameters', () => {
		const result = withoutLegacyCompilation(() =>
			orm
				.select('posts')
				.join('comments', {
					as: 'c1',
					on: and(eq('posts.id', exprRef('c1.postId')), eq('c1.body', 'b')),
				})
				.where(eq('title', 'r'))
				.include('author', { join: 'left', where: eq('name', 'n') })
				.dump(),
		);
		expect(result.sql).toBe(
			'SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author.email AS "author.email", author."managerId" AS "author.managerId", author.id AS __dbsp_presence_author FROM posts JOIN comments AS c1 ON posts.id = c1."postId" AND c1.body = $3 LEFT JOIN users AS author ON posts."authorId" = author.id WHERE posts.title = $1 AND author.name = $2',
		);
		expect(result.params).toEqual(['r', 'n', 'b']);
	});
	it('merges duplicate resolved conditions without re-resolution', () => {
		const result = withoutLegacyCompilation(() =>
			orm
				.select('posts')
				.include('author', { join: 'left', where: eq('name', 'a') })
				.include('author', { join: 'left', where: eq('email', 'e') })
				.dump(),
		);
		expect(result.sql).toBe(
			'SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author.email AS "author.email", author."managerId" AS "author.managerId", author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id WHERE author.name = $1 AND author.email = $2',
		);
		expect(result.params).toEqual(['a', 'e']);
	});
	it('shares scalar subquery alias numbering across duplicate include predicates', () => {
		const where = inSubquery(
			'id',
			subquery('users').select('id').where(eq('name', 'n')),
		);
		const result = withoutLegacyCompilation(() =>
			orm
				.select('posts')
				.include('author', { join: 'left', where })
				.include('author', { join: 'left', where })
				.dump(),
		);
		expect(result.sql).toBe(
			'SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author.email AS "author.email", author."managerId" AS "author.managerId", author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id WHERE author.id = ANY (SELECT users_subq_1.id FROM users AS users_subq_1 WHERE users_subq_1.name = $1) AND author.id = ANY (SELECT users_subq_2.id FROM users AS users_subq_2 WHERE users_subq_2.name = $2)',
		);
		expect(result.params).toEqual(['n', 'n']);
	});
	it('keeps expression references inside subquery bodies on their inner range', () => {
		const report = orm
			.select('posts')
			.include('author', {
				join: 'left',
				where: inSubquery(
					'id',
					subquery('users')
						.select('id')
						.where(fn('lower', exprRef('email')).eq('a')),
				),
			})
			.plan();
		expect(report.execution!.includes[0]!.predicate!.condition).toMatchObject({
			kind: 'in',
			operand: {
				kind: 'subquery',
				body: {
					range: { table: 'users', alias: 'users_subq_1' },
					where: {
						kind: 'expression',
						expression: {
							kind: 'call',
							args: [
								{
									kind: 'ref',
									operand: {
										range: { table: 'users', alias: 'users_subq_1' },
										column: 'email',
									},
								},
							],
						},
					},
				},
			},
		});
		const result = withoutLegacyCompilation(() => adapter.compile(report));
		expect(result.sql).toBe(
			'SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author.email AS "author.email", author."managerId" AS "author.managerId", author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id WHERE author.id = ANY (SELECT users_subq_1.id FROM users AS users_subq_1 WHERE lower(email) = $1)',
		);
		expect(result.parameters).toEqual(['a']);
	});
	it('refuses an ambiguous logical outer qualifier in the nearest query scope', () => {
		expect(() =>
			orm
				.select('posts')
				.join('users', { as: 'u1', on: eq('u1.id', 1) })
				.join('users', { as: 'u2', on: eq('u2.id', 2) })
				.include('author', {
					join: 'left',
					where: eq('name', outerRef('users.name')),
				})
				.plan(),
		).toThrow(
			new Error(
				"outerRef qualifier 'users' is ambiguous between 'u1', 'u2' in an enclosing query.",
			),
		);
	});
	it('maps the include logical table qualifier to its emitted range', () => {
		const plain = orm
			.select('posts')
			.include('author', { join: 'left', where: eq('name', 'n') })
			.dump();
		const qualified = orm
			.select('posts')
			.include('author', { join: 'left', where: eq('users.name', 'n') })
			.dump();
		expect(qualified.sql).toBe(plain.sql);
		expect(qualified.params).toEqual(plain.params);
	});
	for (const construct of [
		createNqlBindingSelectPlan,
		createPlanReportForQuery,
	])
		it(`refuses include predicates during ${construct.name} report construction`, () => {
			expect(() =>
				construct(
					{
						type: 'select',
						from: 'posts',
						include: [
							{ relation: 'author', join: 'left', where: exists('nope') },
						],
					},
					model,
				),
			).toThrow(
				new Error(
					'Relation predicates inside an include where are not supported yet at include[0](author).where for strategy join (oorabona/db-semantic-planner#892).',
				),
			);
		});
	it('refuses relation predicates before resolving nonexistent relations or columns during planning', () => {
		expect(() =>
			orm
				.select('posts')
				.include('author', {
					join: 'left',
					where: and(eq('nope', 1), exists('nope')),
				})
				.plan(),
		).toThrow(
			new Error(
				'Relation predicates inside an include where are not supported yet at include[0](author).where for strategy join (oorabona/db-semantic-planner#892).',
			),
		);
	});
	it('refuses mixed strategies before child relation predicates during planning', () => {
		expect(() =>
			orm
				.select('comments')
				.include('post', {
					join: 'left',
					include: [{ relation: 'comments', where: exists('post') }],
				})
				.plan(),
		).toThrow(
			new Error(
				'Nested include at include[0](post).include[0](comments) has parent strategy join and child strategy json_agg; mixed strategies and includes under cte are refused (oorabona/db-semantic-planner#894).',
			),
		);
	});
	it('refuses unsupported strategy before resolving columns during planning', () => {
		expect(() =>
			orm
				.select('users')
				.include('authored', { where: eq('nope', 1) })
				.plan(),
		).toThrow(
			new Error(
				'Include where is not supported for strategy json_agg at include[0](authored).where (oorabona/db-semantic-planner#892).',
			),
		);
	});
});
