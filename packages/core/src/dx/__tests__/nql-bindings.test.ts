/**
 * Tests for nql`...` tagged template bind handling.
 *
 * Tracks: https://github.com/oorabona/db-semantic-planner/issues/113
 * Regression: https://github.com/oorabona/db-semantic-planner/issues/173
 */

import { describe, expect, it, vi } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../../../../adapter-pgsql/src/pgsql-adapter.js';
import type { Adapter, CompiledNqlQuery } from '../../adapter.js';
import type { IncludeIntent, QueryIntent } from '../../intent-ast.js';
import { createHookManager, getHookStore, type HookStore } from '../hooks.js';
import type { MutationDump } from '../mutation-builders.js';
import { createNqlTag, nqlRaw } from '../nql.js';
import { ref, schema } from '../schema.js';

function createBindingTag(executeResult: readonly unknown[] = []) {
	const db = schema({
		users: {
			id: { type: 'integer', dbType: 'integer' },
			name: 'string',
			active: 'boolean',
		},
		posts: {
			id: { type: 'integer', dbType: 'integer' },
			title: 'string',
			published: 'boolean',
			userId: ref('users', { inverse: 'posts' }),
		},
		comments: {
			id: { type: 'integer', dbType: 'integer' },
			body: 'string',
			postId: ref('posts', { inverse: 'comments' }),
		},
	} as const);
	const adapter = createPgsqlCompileOnlyAdapter() as unknown as Adapter;
	const compile = vi.spyOn(adapter, 'compile');
	adapter.execute = vi.fn(async () => [...executeResult]);

	return {
		adapter,
		compile,
		nql: createNqlTag(db.definition, db.model, adapter),
	};
}

function createBlogBindingTag(executeResult: readonly unknown[] = []) {
	const db = schema({
		authors: {
			id: { type: 'integer', primaryKey: true, dbType: 'integer' },
			name: 'string',
			email: 'string',
			post_comments_json: 'string',
		},
		posts: {
			id: { type: 'integer', primaryKey: true, dbType: 'integer' },
			title: 'string',
			content: 'string',
			authorId: ref('authors'),
			published: 'boolean',
			createdAt: 'timestamp',
		},
		comments: {
			id: { type: 'integer', primaryKey: true, dbType: 'integer' },
			postId: ref('posts'),
			authorName: 'string',
			content: 'string',
			createdAt: 'timestamp',
		},
	} as const);
	const adapter = createPgsqlCompileOnlyAdapter() as unknown as Adapter;
	const compile = vi.spyOn(adapter, 'compile');
	adapter.execute = vi.fn(async () => [...executeResult]);

	return {
		adapter,
		compile,
		nql: createNqlTag(db.definition, db.model, adapter),
	};
}

function createMutationBindingTag(
	execute: Adapter['execute'],
	transaction?: Adapter['transaction'],
	hookStore?: HookStore,
	options: { readonly dbCasing?: Adapter['dbCasing'] } = {},
) {
	const db = schema({
		users: {
			id: { type: 'integer', dbType: 'integer' },
			name: 'string',
			active: 'boolean',
		},
		posts: {
			id: { type: 'integer', dbType: 'integer' },
			title: 'string',
			authorId: { type: 'integer', dbType: 'integer' },
		},
	} as const);
	const adapter = createPgsqlCompileOnlyAdapter({
		model: db.model,
		...(options.dbCasing !== undefined && { dbCasing: options.dbCasing }),
	}) as unknown as Adapter;
	const compile = vi.spyOn(adapter, 'compile');
	adapter.execute = execute;
	adapter.transaction =
		transaction ??
		vi.fn(async (fn) => {
			return fn(adapter);
		});

	return {
		adapter,
		compile,
		nql: createNqlTag(db.definition, db.model, adapter, undefined, hookStore),
	};
}

function expectCompiledNqlBundle(value: unknown): CompiledNqlQuery {
	expect(value).toMatchObject({
		query: expect.any(Object),
		bindings: expect.any(Map),
	});
	return value as CompiledNqlQuery;
}

function createBindingFinalBundle(include: IncludeIntent): CompiledNqlQuery {
	const bindingSource: QueryIntent = {
		type: 'select',
		from: 'users',
		select: { type: 'fields', fields: ['id'] },
	};
	const finalQuery: QueryIntent = {
		type: 'select',
		from: 'active_users',
		include: [include],
	};

	return {
		query: finalQuery,
		bindings: new Map([['active_users', bindingSource]]),
		bindingOutputSchemas: new Map([
			[
				'active_users',
				{
					columns: ['id'],
					relationFilters: {
						sourceTable: 'users',
						relations: [],
						scalarRelations: [
							{
								relation: 'posts',
								sourceTable: 'users',
								targetTable: 'posts',
								sourceColumn: 'id',
								targetColumn: 'userId',
								hops: [],
								cardinality: 'many',
								relationType: 'hasMany',
							},
						],
					},
				},
			],
		]),
	};
}

async function expectAuthorBindingProjectionMaterializes(
	dbCasing: Adapter['dbCasing'],
	projectedColumn: 'authorId' | 'author_id',
	expectedCteColumn: 'authorId' | 'author_id',
) {
	const execute = vi
		.fn()
		.mockResolvedValueOnce([{ authorId: 17 }])
		.mockResolvedValueOnce([{ authorId: 17 }]);
	const { compile, nql } = createMutationBindingTag(
		execute,
		undefined,
		undefined,
		{
			dbCasing,
		},
	);

	const rows = await nql<{
		authorId: number;
	}>`update posts set title = ${'Touched'} where id = ${1} | select ${nqlRaw(projectedColumn)} | bind touched
posts | where authorId in (touched) | select authorId`.all();

	expect(rows).toEqual([{ authorId: 17 }]);
	expect(execute).toHaveBeenCalledTimes(2);
	const bundle = expectCompiledNqlBundle(compile.mock.calls[1]?.[0]);
	expect(bundle.bindingOutputSchemas?.get('touched')?.columns).toEqual([
		'authorId',
	]);
	expect(bundle.mutationBindings?.get('touched')?.returning).toEqual([
		'authorId',
	]);
	const finalSql = execute.mock.calls[1]?.[0].sql ?? '';
	expect(finalSql).toContain(
		`WITH "touched" ("${expectedCteColumn}") as (SELECT "${expectedCteColumn}" FROM "posts" WHERE false UNION ALL VALUES ($1::integer))`,
	);
	expect(execute.mock.calls[1]?.[0].parameters).toEqual([17]);
}

describe('nql`...` bind handling', () => {
	it('compiles referenced query-final read-only bindings through the NQL bundle for WITH CTE emission', () => {
		const { compile, nql } = createBindingTag();

		const dump = nql<{ id: number }>`users
			| where active = ${true}
			| select id
			| bind active_users
users | where id in (active_users) | select id`.dump();

		expect(compile).toHaveBeenCalledOnce();
		const bundle = expectCompiledNqlBundle(compile.mock.calls[0]?.[0]);
		expect(bundle.bindings?.has('active_users')).toBe(true);
		expect(bundle.mutationBindings).toBeUndefined();
		expect(compile.mock.calls[0]?.[1]).toMatchObject({
			model: expect.any(Object),
		});
		expect(dump.sql).toMatch(/^WITH "active_users" as \(/);
		expect(dump.params).toEqual([true]);
		expect(dump.plan.rootTable).toBe('users');
	});

	it('compiles binding-final read-only queries through the NQL bundle without planner decisions', () => {
		const { compile, nql } = createBindingTag();

		const dump = nql<{ id: number }>`users
			| where active = ${true}
			| select id
			| bind active_users
active_users | select id`.dump();

		expect(compile).toHaveBeenCalledOnce();
		const bundle = expectCompiledNqlBundle(compile.mock.calls[0]?.[0]);
		expect(bundle.bindings?.has('active_users')).toBe(true);
		expect(bundle.query?.from).toBe('active_users');
		expect(dump.sql).toMatch(/^WITH "active_users" as \(/);
		expect(dump.sql).toContain('FROM active_users');
		expect(dump.params).toEqual([true]);
		expect(dump.plan.rootTable).toBe('active_users');
		expect(dump.plan.decisions).toEqual([]);
	});

	it('compiles unreferenced query-final read-only bindings through WITH CTEs (#173)', () => {
		const { compile, nql } = createBindingTag();

		const dump = nql<{ id: number }>`posts
			| where id >= ${3}
			| select id
			| bind recent_posts
posts | where published = ${true} | select id`.dump();

		expect(compile).toHaveBeenCalledOnce();
		const bundle = expectCompiledNqlBundle(compile.mock.calls[0]?.[0]);
		expect(bundle.bindings?.has('recent_posts')).toBe(true);
		expect(bundle.query?.from).toBe('posts');
		expect(dump.sql).toMatch(/^WITH "recent_posts" as \(/);
		expect(dump.params).toEqual([3, true]);
		expect(dump.plan.rootTable).toBe('posts');
	});

	it('plans binding-final read-only queries without planner decisions', () => {
		const { nql } = createBindingTag();

		const plan = nql<{ id: number }>`users
			| where active = ${true}
			| select id
			| bind active_users
active_users | select id`.plan();

		expect(plan.rootTable).toBe('active_users');
		expect(plan.decisions).toEqual([]);
	});

	it('rejects read binding references across an intervening mutation (#186)', () => {
		const execute = vi.fn(async () => [{ id: 1 }]);
		const { compile, nql } = createMutationBindingTag(execute);

		expect(() => {
			nql<{ id: number }>`users
				| where active = ${true}
				| select id
				| bind active_users
insert into users set name = ${'Alice'}, active = ${true} | select id | bind created
users | where id in (active_users) | select id`.dump();
		}).toThrow(/read binding referenced across a mutation \(#186\)/);
		expect(compile).not.toHaveBeenCalled();
	});

	it('compiles binding-final hasMany relation columns through a correlated json_agg subquery', () => {
		const { compile, nql } = createBindingTag();

		const dump = nql<{ title: string[] }>`users
			| where active = ${true}
			| select id
			| bind active_users
active_users | select posts.title`.dump();

		expect(compile).toHaveBeenCalledOnce();
		const bundle = expectCompiledNqlBundle(compile.mock.calls[0]?.[0]);
		expect(bundle.query?.from).toBe('active_users');
		expect(dump.sql).toMatch(
			/\(SELECT COALESCE\(json_agg\(rc_\d+\.title ORDER BY CAST\(rc_\d+\.title AS text\) NULLS LAST\), '\[\]'::json\) FROM posts AS rc_\d+ WHERE rc_\d+\."userId" = active_users\.id\) AS "posts\.title"/i,
		);
		expect(dump.sql).not.toMatch(/\bJOIN\s+"?posts"?/i);
	});

	it('compiles binding-final belongsTo scalar relation columns through a correlated subquery', () => {
		const { compile, nql } = createBindingTag();

		const dump = nql<{ id: number; 'user.name': string }>`posts
			| select id, userId
			| bind projected_posts
projected_posts | select id, user.name`.dump();

		expect(compile).toHaveBeenCalledOnce();
		const bundle = expectCompiledNqlBundle(compile.mock.calls[0]?.[0]);
		expect(bundle.query?.from).toBe('projected_posts');
		expect(dump.sql).toMatch(
			/\(SELECT rc_\d+\.name FROM users AS rc_\d+ WHERE rc_\d+\.id = projected_posts\."userId"\) AS "user\.name"/i,
		);
		expect(dump.sql).not.toContain('JOIN "users"');
	});

	it('compiles and hydrates binding-final hasMany includes through the json_agg include pipeline', async () => {
		const { compile, nql } = createBindingTag([
			{
				id: 1,
				name: 'Ada',
				posts_json: JSON.stringify([{ id: 10, title: 'First' }]),
			},
			{ id: 2, name: 'No Posts', posts_json: null },
		]);

		const query = nql<{
			id: number;
			name: string;
			posts: Array<{ id: number; title: string }>;
		}>`users
			| select id, name
			| bind active_users
active_users | select *, posts.*`;
		const dump = query.dump();
		const rows = await query.all();

		const decision = dump.plan.decisions.find(
			(planDecision) =>
				planDecision.type === 'include-strategy' &&
				planDecision.choice === 'json_agg',
		);
		expect(decision).toMatchObject({
			type: 'include-strategy',
			choice: 'json_agg',
			context: {
				sourceTable: 'active_users',
				target: 'posts',
				relation: 'posts',
				relationType: 'hasMany',
				foreignKey: ['userId'],
				parentKey: ['id'],
				targetPrimaryKey: ['id'],
				includeAlias: 'posts',
			},
		});
		expect(dump.sql).toMatch(/^WITH "active_users" as \(/);
		expect(dump.sql).toContain(
			'json_agg(to_jsonb(__t__) ORDER BY __t__.id ASC NULLS LAST)',
		);
		expect(dump.sql).toContain('AS posts_json');
		expect(dump.sql).toMatch(/WHERE __t__\."userId" = active_users\.id/i);
		expect(rows).toEqual([
			{ id: 1, name: 'Ada', posts: [{ id: 10, title: 'First' }] },
			{ id: 2, name: 'No Posts', posts: [] },
		]);
		expect(rows[0]).not.toHaveProperty('posts_json');
		expect(compile).toHaveBeenCalledTimes(2);
		const bundle = expectCompiledNqlBundle(compile.mock.calls[0]?.[0]);
		expect(bundle.plan?.decisions).toHaveLength(1);
	});

	it('compiles nested binding-final hasMany includes as flat chained json_agg decisions', async () => {
		const { compile, nql } = createBindingTag([
			{
				id: 1,
				name: 'Ada',
				posts_json: JSON.stringify([
					{
						id: 10,
						title: 'First',
						userId: 1,
						comments: [{ id: 100, body: 'Nice', postId: 10 }],
					},
				]),
			},
			{ id: 2, name: 'No Posts', posts_json: null },
		]);

		const query = nql<{
			id: number;
			name: string;
			posts: Array<{
				id: number;
				title: string;
				userId: number;
				comments: Array<{ id: number; body: string; postId: number }>;
			}>;
		}>`users
			| select id, name
			| bind active_users
active_users | select *, posts.comments.*`;
		const dump = query.dump();
		const rows = await query.all();
		const decisions = dump.plan.decisions.filter(
			(decision) => decision.type === 'include-strategy',
		);

		expect(decisions).toHaveLength(2);
		expect(decisions[0]).toMatchObject({
			choice: 'json_agg',
			context: {
				sourceTable: 'active_users',
				target: 'posts',
				relation: 'posts',
				relationType: 'hasMany',
				foreignKey: ['userId'],
				parentKey: ['id'],
				targetPrimaryKey: ['id'],
				intentPath: 'include[0]',
			},
		});
		expect(decisions[1]).toMatchObject({
			choice: 'json_agg',
			context: {
				sourceTable: 'posts',
				target: 'comments',
				relation: 'comments',
				relationType: 'hasMany',
				foreignKey: 'postId',
				targetPrimaryKey: ['id'],
				intentPath: 'include[0].include[0]',
			},
		});
		expect(dump.sql).toContain('json_agg(to_jsonb(__t__)');
		expect(dump.sql).toContain('ORDER BY __t__.id ASC NULLS LAST');
		expect(dump.sql).toContain('ORDER BY __t1__.id ASC NULLS LAST');
		expect(dump.sql).toContain('jsonb_build_object');
		expect(dump.sql).toContain('AS posts_json');
		expect(dump.sql).toMatch(/WHERE __t__\."userId" = active_users\.id/i);
		expect(dump.sql).toMatch(/WHERE __t1__\."postId" = __t__\.id/i);
		expect(rows).toEqual([
			{
				id: 1,
				name: 'Ada',
				posts: [
					{
						id: 10,
						title: 'First',
						userId: 1,
						comments: [{ id: 100, body: 'Nice', postId: 10 }],
					},
				],
			},
			{ id: 2, name: 'No Posts', posts: [] },
		]);
		expect(rows[0]).not.toHaveProperty('posts_json');
		expect(compile).toHaveBeenCalledTimes(2);
		const bundle = expectCompiledNqlBundle(compile.mock.calls[0]?.[0]);
		expect(bundle.plan?.decisions).toHaveLength(2);
	});

	it('mutation: nested json_agg hydrator scans tail decision as top-level column', async () => {
		const { nql } = createBlogBindingTag([
			{
				id: 1,
				name: 'Ada',
				post_comments_json: '{"owned":true}',
				author_posts_json: JSON.stringify([
					{
						id: 10,
						title: 'First',
						content: 'Post body',
						authorId: 1,
						published: true,
						createdAt: '2026-01-01T00:00:00.000Z',
						post_comments: [
							{
								id: 100,
								postId: 10,
								authorName: 'Lin',
								content: 'Nice',
								createdAt: '2026-01-02T00:00:00.000Z',
							},
						],
					},
				]),
			},
		]);

		const query = nql<{
			id: number;
			name: string;
			post_comments_json: string;
			author_posts: Array<{
				id: number;
				title: string;
				post_comments: Array<{ id: number; postId: number; content: string }>;
			}>;
		}>`authors
			| select id, name, post_comments_json
			| bind active_authors
active_authors | select *, author_posts.post_comments.*`;
		const dump = query.dump();
		const rows = await query.all();
		const decisions = dump.plan.decisions.filter(
			(decision) => decision.type === 'include-strategy',
		);

		expect(decisions).toHaveLength(2);
		expect(decisions[0]).toMatchObject({
			choice: 'json_agg',
			context: {
				relation: 'author_posts',
				targetPrimaryKey: ['id'],
				intentPath: 'include[0]',
			},
		});
		expect(decisions[1]).toMatchObject({
			choice: 'json_agg',
			context: {
				relation: 'post_comments',
				targetPrimaryKey: ['id'],
				intentPath: 'include[0].include[0]',
			},
		});
		expect(dump.sql).toContain('AS author_posts_json');
		expect(dump.sql).toContain('jsonb_build_object');
		expect(dump.sql).toContain('ORDER BY __t__.id ASC NULLS LAST');
		expect(dump.sql).toContain('ORDER BY __t1__.id ASC NULLS LAST');
		expect(rows).toEqual([
			{
				id: 1,
				name: 'Ada',
				post_comments_json: '{"owned":true}',
				author_posts: [
					{
						id: 10,
						title: 'First',
						content: 'Post body',
						authorId: 1,
						published: true,
						createdAt: '2026-01-01T00:00:00.000Z',
						post_comments: [
							{
								id: 100,
								postId: 10,
								authorName: 'Lin',
								content: 'Nice',
								createdAt: '2026-01-02T00:00:00.000Z',
							},
						],
					},
				],
			},
		]);
		expect(rows[0]).not.toHaveProperty('author_posts_json');
		expect(rows[0]).not.toHaveProperty('post_comments');
	});

	it('forces binding-final hasMany tail belongsTo includes through nested json_agg', () => {
		const { nql } = createBindingTag();

		const dump = nql<{
			id: number;
			name: string;
			posts: Array<{
				id: number;
				title: string;
				userId: number;
				user: { id: number; name: string } | null;
			}>;
		}>`users
			| select id, name
			| bind active_users
active_users | select *, posts.user.*`.dump();

		const decisions = dump.plan.decisions.filter(
			(decision) => decision.type === 'include-strategy',
		);
		const tailDecision = decisions[1];

		expect(decisions).toHaveLength(2);
		expect(decisions[0]).toMatchObject({
			choice: 'json_agg',
			context: {
				sourceTable: 'active_users',
				target: 'posts',
				relation: 'posts',
				relationType: 'hasMany',
				foreignKey: ['userId'],
				parentKey: ['id'],
				targetPrimaryKey: ['id'],
				intentPath: 'include[0]',
			},
		});
		expect(tailDecision).toMatchObject({
			choice: 'json_agg',
			context: {
				sourceTable: 'posts',
				target: 'users',
				relation: 'user',
				relationType: 'belongsTo',
				foreignKey: 'userId',
				targetPrimaryKey: ['id'],
				intentPath: 'include[0].include[0]',
			},
		});
		expect(dump.sql.match(/json_agg\(to_jsonb/g)).toHaveLength(2);
		expect(dump.sql).toContain('jsonb_build_object');
		expect(dump.sql).toContain('ORDER BY __t__.id ASC NULLS LAST');
		expect(dump.sql).toContain('ORDER BY __t1__.id ASC NULLS LAST');
		expect(dump.sql).toMatch(/WHERE __t1__\.id = __t__\."userId"/i);
		expect(dump.sql).not.toMatch(/\bJOIN\s+"?users"?\b/i);
		expect(dump.sql).not.toMatch(/cte_posts_user/i);
	});

	it('hydrates binding-final belongsTo includes to objects and nulls', async () => {
		const { nql } = createBindingTag([
			{
				id: 10,
				userId: 1,
				user_json: JSON.stringify([{ id: 1, name: 'Ada' }]),
			},
			{ id: 11, userId: null, user_json: '[]' },
		]);

		const rows = await nql<{
			id: number;
			userId: number | null;
			user: { id: number; name: string } | null;
		}>`posts
			| select id, userId
			| bind projected_posts
projected_posts | select *, user.*`.all();

		expect(rows).toEqual([
			{ id: 10, userId: 1, user: { id: 1, name: 'Ada' } },
			{ id: 11, userId: null, user: null },
		]);
		expect(rows[0]).not.toHaveProperty('user_json');
	});

	it('rejects binding-final relation include limits before creating a synthetic plan', () => {
		const { compile, nql } = createBindingTag();

		expect(() => {
			nql<{ id: number }>`users
				| where active = ${true}
				| select id
				| bind active_users
active_users | select id | limit posts 5`.dump();
		}).toThrow(
			/cannot use relation include limits|cannot select relation columns or use includes/,
		);
		expect(compile).not.toHaveBeenCalled();
	});

	it.each([
		[
			'nested where',
			{
				relation: 'posts',
				where: {
					kind: 'comparison',
					field: 'published',
					operator: '=',
					value: true,
				},
			},
			"unsupported option 'where'",
		],
		['limit', { relation: 'posts', limit: 5 }, "unsupported option 'limit'"],
		[
			'orderBy',
			{
				relation: 'posts',
				orderBy: [{ field: 'createdAt', direction: 'desc' }],
			},
			"unsupported option 'orderBy'",
		],
		[
			'via',
			{ relation: 'posts', via: 'publishedPosts' },
			"unsupported option 'via'",
		],
		[
			'strategy',
			{ relation: 'posts', strategy: 'flat' },
			"unsupported option 'strategy'",
		],
		[
			'recursive',
			{ relation: 'posts', recursive: { maxDepth: 2 } },
			"unsupported option 'recursive'",
		],
		[
			'select',
			{ relation: 'posts', select: { type: 'all' } },
			"unsupported option 'select'",
		],
		[
			'nested include option',
			{ relation: 'posts', include: [{ relation: 'comments', limit: 5 }] },
			"tail relation 'comments' include node carries unsupported option 'limit'",
		],
		[
			'unknown tail include option',
			{
				relation: 'posts',
				include: [
					{
						relation: 'comments',
						futureOption: true,
					} as IncludeIntent,
				],
			},
			"tail relation 'comments' include node carries unsupported option 'futureOption'",
		],
	] satisfies readonly (readonly [
		string,
		IncludeIntent,
		string,
	])[])('rejects binding-final include option %s with ref-#192 fail-loud message', async (_option, include, reason) => {
		const db = schema({
			users: {
				id: { type: 'integer', dbType: 'integer' },
				name: 'string',
			},
		} as const);

		vi.resetModules();
		vi.doMock('@dbsp/nql', async () => {
			const actual =
				await vi.importActual<typeof import('@dbsp/nql')>('@dbsp/nql');
			return {
				...actual,
				compile: vi.fn(() => ({
					success: true,
					ast: createBindingFinalBundle(include),
				})),
			};
		});

		try {
			const { createNqlTag: createMockedNqlTag } = await import('../nql.js');
			const nql = createMockedNqlTag(db.definition, db.model);
			let thrown: unknown;

			try {
				nql<{ id: number }>`active_users | select id`.dump();
			} catch (err) {
				thrown = err;
			}

			expect(thrown).toBeInstanceOf(Error);
			expect((thrown as Error).message).toContain(
				"NQL binding-final query 'active_users' cannot use relation include",
			);
			expect((thrown as Error).message).toContain('(ref-#192)');
			expect((thrown as Error).message).toContain(reason);
		} finally {
			vi.doUnmock('@dbsp/nql');
			vi.resetModules();
		}
	});

	it('executes referenced query-final read-only bindings through the NQL bundle', async () => {
		const rows = [{ id: 1 }];
		const { adapter, compile, nql } = createBindingTag(rows);

		const result = await nql<{ id: number }>`users
			| where active = ${true}
			| select id
			| bind active_users
users | where id in (active_users) | select id`.all();

		expect(result).toEqual(rows);
		expect(adapter.execute).toHaveBeenCalledOnce();
		const bundle = expectCompiledNqlBundle(compile.mock.calls[0]?.[0]);
		expect(bundle.bindings?.has('active_users')).toBe(true);
		expect(bundle.mutationBindings).toBeUndefined();
	});

	it('executes binding-final read-only queries through the NQL bundle', async () => {
		const rows = [{ id: 1 }];
		const { adapter, compile, nql } = createBindingTag(rows);

		const result = await nql<{ id: number }>`users
			| where active = ${true}
			| select id
			| bind active_users
active_users | select id`.all();

		expect(result).toEqual(rows);
		expect(adapter.execute).toHaveBeenCalledOnce();
		const bundle = expectCompiledNqlBundle(compile.mock.calls[0]?.[0]);
		expect(bundle.bindings?.has('active_users')).toBe(true);
		expect(bundle.query?.from).toBe('active_users');
		expect(bundle.mutationBindings).toBeUndefined();
	});

	it('executes mutation bindings before a query-final statement in one transaction', async () => {
		const execute = vi.fn(async () => [{ id: 11 }]);
		const { adapter, compile, nql } = createMutationBindingTag(execute);

		const rows = await nql<{
			id: number;
		}>`insert into users set name = ${'Alice'} | select id | bind new_user
users | where id in (new_user) | select id`.all();

		expect(rows).toEqual([{ id: 11 }]);
		expect(adapter.transaction).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledTimes(2);
		const finalSql = execute.mock.calls[1]?.[0].sql ?? '';
		expect(finalSql).toContain(
			'WITH "new_user" ("id") as (SELECT "id" FROM "users" WHERE false UNION ALL VALUES ($1::integer))',
		);
		expect(finalSql).not.toMatch(/WITH "new_user"\s+as\s+\(\s*insert/i);
		expect(execute.mock.calls[1]?.[0].parameters).toEqual([11]);
		expect(compile).toHaveBeenCalledTimes(2);
	});

	it('dump() globally renumbers top-level params for a query-final mutation binding sequence', () => {
		const execute = vi.fn(async () => [{ id: 11 }]);
		const { adapter, nql } = createMutationBindingTag(execute);

		const dump = nql<{
			id: number;
		}>`insert into users set name = ${'Alice'} | select id | bind new_user
users | where active = ${true} and id in (new_user) | select id`.dump();

		expect(adapter.execute).not.toHaveBeenCalled();
		expect(dump.sequence).toHaveLength(2);
		expect(dump.sequence?.[0]?.sql).toMatch(/\$1\b/);
		expect(dump.sequence?.[1]?.sql).toMatch(/\$1\b/);
		expect(dump.params).toEqual(['Alice', true]);
		const topLevelPlaceholders = Array.from(
			dump.sql.matchAll(/\$(\d+)/g),
			(match) => Number(match[1]),
		);
		expect(topLevelPlaceholders).toEqual([1, 2]);
	});

	it('executes mutation bindings before a mutation-final statement using typed CTE data-flow', async () => {
		const execute = vi
			.fn()
			.mockResolvedValueOnce([{ id: 12 }])
			.mockResolvedValueOnce([{ id: 12 }]);
		const { adapter, nql } = createMutationBindingTag(execute);

		const rows = await nql<{
			id: number;
		}>`insert into users set name = ${'Alice'} | select id | bind new_user
update users set active = ${true} where id in (new_user) | select id`.all();

		expect(rows).toEqual([{ id: 12 }]);
		expect(adapter.transaction).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledTimes(2);
		const update = execute.mock.calls[1]?.[0];
		expect(update.sql).toContain(
			'WITH "new_user" ("id") as (SELECT "id" FROM "users" WHERE false UNION ALL VALUES ($1::integer))',
		);
		expect(update.sql).not.toMatch(/WITH "new_user"\s+as\s+\(\s*insert/i);
		expect(update.parameters).toEqual([12, true]);
	});

	it('uses raw mutation rows for bindings while returning transformed final rows', async () => {
		const afterMutation = vi.fn((ctx, rows: Array<{ id: number }>) => {
			return rows.map((row) => ({
				...row,
				id: ctx.operation === 'insert' ? -1 : -2,
			}));
		});
		const hooks = getHookStore(
			createHookManager().afterMutation(afterMutation as never),
		);
		const execute = vi
			.fn()
			.mockResolvedValueOnce([{ id: 15 }])
			.mockResolvedValueOnce([{ id: 15 }]);
		const { adapter, nql } = createMutationBindingTag(
			execute,
			undefined,
			hooks,
		);

		const rows = await nql<{
			id: number;
		}>`insert into users set name = ${'Alice'} | select id | bind new_user
update users set active = ${true} where id in (new_user) | select id`.all();

		expect(rows).toEqual([{ id: -2 }]);
		expect(afterMutation).toHaveBeenCalledTimes(2);
		expect(afterMutation.mock.calls[0]?.[1]).toEqual([{ id: 15 }]);
		expect(afterMutation.mock.calls[1]?.[1]).toEqual([{ id: 15 }]);
		expect(adapter.transaction).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledTimes(2);
		expect(execute.mock.calls[1]?.[0].parameters).toEqual([15, true]);
	});

	it('executes unreferenced mutation bindings but omits their CTE from later statements', async () => {
		const execute = vi
			.fn()
			.mockResolvedValueOnce([{ id: 21 }])
			.mockResolvedValueOnce([{ id: 22 }])
			.mockResolvedValueOnce([{ id: 22 }]);
		const { adapter, nql } = createMutationBindingTag(execute);

		const program = nql<{
			id: number;
		}>`insert into users set name = ${'Alice'} | select id | bind first_user
insert into users set name = ${'Bob'} | select id | bind second_user
update users set active = ${true} where id in (second_user) | select id`;
		const dump = program.dump() as MutationDump;
		const rows = await program.all();

		expect(rows).toEqual([{ id: 22 }]);
		expect(adapter.transaction).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledTimes(3);
		expect(dump.sequence).toHaveLength(3);
		expect(dump.sequence?.map((step) => step.bindName)).toEqual([
			'first_user',
			'second_user',
			undefined,
		]);
		const finalSql = execute.mock.calls[2]?.[0].sql ?? '';
		expect(finalSql).toContain(
			'WITH "second_user" ("id") as (SELECT "id" FROM "users" WHERE false UNION ALL VALUES ($1::integer))',
		);
		expect(finalSql).not.toContain('"first_user"');
		expect(execute.mock.calls[2]?.[0].parameters).toEqual([22, true]);
	});

	it('does not trip the runtime binding parameter cap for unreferenced mutation bindings', async () => {
		const unusedRows = Array.from({ length: 32_001 }, (_, id) => ({ id }));
		const execute = vi
			.fn()
			.mockResolvedValueOnce(unusedRows)
			.mockResolvedValueOnce([{ id: 33 }])
			.mockResolvedValueOnce([{ id: 33 }]);
		const { adapter, nql } = createMutationBindingTag(execute);

		const rows = await nql<{
			id: number;
		}>`insert into users set name = ${'unused'} | select id | bind unused_users
insert into users set name = ${'kept'} | select id | bind kept_user
users | where id in (kept_user) | select id`.all();

		expect(rows).toEqual([{ id: 33 }]);
		expect(adapter.transaction).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledTimes(3);
		const finalSql = execute.mock.calls[2]?.[0].sql ?? '';
		expect(finalSql).toContain('"kept_user"');
		expect(finalSql).not.toContain('"unused_users"');
		expect(execute.mock.calls[2]?.[0].parameters).toEqual([33]);
	});

	it('emits transitive binding dependencies in dependency order only', async () => {
		const execute = vi
			.fn()
			.mockResolvedValueOnce([{ id: 40 }])
			.mockResolvedValueOnce([{ id: 41 }])
			.mockResolvedValueOnce([{ id: 41 }]);
		const { nql } = createMutationBindingTag(execute);

		await nql<{
			id: number;
		}>`insert into users set name = ${'unused'} | select id | bind unused_user
insert into users set name = ${'Alice'} | select id | bind new_user
new_user | select id | bind new_user_ids
users | where id in (new_user_ids) | select id`.all();

		const finalSql = execute.mock.calls[2]?.[0].sql ?? '';
		const newUserIndex = finalSql.indexOf('"new_user"');
		const newUserIdsIndex = finalSql.indexOf('"new_user_ids"');
		expect(newUserIndex).toBeGreaterThanOrEqual(0);
		expect(newUserIdsIndex).toBeGreaterThan(newUserIndex);
		expect(finalSql).not.toContain('"unused_user"');
		expect(execute.mock.calls[2]?.[0].parameters).toEqual([41]);
	});

	it('executes a final bound mutation exactly once', async () => {
		const execute = vi.fn().mockResolvedValueOnce([{ id: 31 }]);
		const { adapter, nql } = createMutationBindingTag(execute);

		const program = nql<{
			id: number;
		}>`users | where active = ${false} | select id | bind inactive_users
update users set active = ${true} where id in (inactive_users) | select id | bind touched_users`;
		const dump = program.dump() as MutationDump;
		const rows = await program.all();

		expect(rows).toEqual([{ id: 31 }]);
		expect(adapter.transaction).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledOnce();
		expect(dump.sequence).toHaveLength(2);
		expect(dump.sequence?.[1]).toMatchObject({
			kind: 'mutation',
			bindName: 'touched_users',
		});
	});

	it('materializes snake_case mutation RETURNING rows to logical binding columns', async () => {
		const afterMutation = vi.fn((_ctx, rows: unknown[]) => rows);
		const hooks = getHookStore(
			createHookManager().afterMutation(afterMutation as never),
		);
		const execute = vi
			.fn()
			.mockResolvedValueOnce([{ author_id: 7 }])
			.mockResolvedValueOnce([{ authorId: 7 }]);
		const { nql } = createMutationBindingTag(execute, undefined, hooks, {
			dbCasing: 'snake_case',
		});

		const rows = await nql<{
			authorId: number;
		}>`update posts set title = ${'Touched'} where id = ${1} | select authorId | bind touched
posts | where authorId in (touched) | select authorId`.all();

		expect(rows).toEqual([{ authorId: 7 }]);
		expect(afterMutation).toHaveBeenCalledOnce();
		expect(afterMutation.mock.calls[0]?.[1]).toEqual([{ author_id: 7 }]);
		expect(execute).toHaveBeenCalledTimes(2);
		expect(execute.mock.calls[1]?.[0].parameters).toEqual([7]);
	});

	it('materializes identity-cased mutation RETURNING rows to logical binding columns', async () => {
		const execute = vi
			.fn()
			.mockResolvedValueOnce([{ authorId: 8 }])
			.mockResolvedValueOnce([{ authorId: 8 }]);
		const { nql } = createMutationBindingTag(execute, undefined, undefined, {
			dbCasing: 'camelCase',
		});

		const rows = await nql<{
			authorId: number;
		}>`update posts set title = ${'Touched'} where id = ${1} | select authorId | bind touched
posts | where authorId in (touched) | select authorId`.all();

		expect(rows).toEqual([{ authorId: 8 }]);
		expect(execute).toHaveBeenCalledTimes(2);
		expect(execute.mock.calls[1]?.[0].parameters).toEqual([8]);
	});

	it.each([
		['snake_case', 'authorId', 'author_id'],
		['snake_case', 'author_id', 'author_id'],
		['preserve', 'authorId', 'authorId'],
		['preserve', 'author_id', 'authorId'],
	] as const)('materializes %s mutation binding projected as %s through canonical CTE column %s', async (dbCasing, projectedColumn, expectedCteColumn) => {
		await expectAuthorBindingProjectionMaterializes(
			dbCasing,
			projectedColumn,
			expectedCteColumn,
		);
	});

	it('fails loud when a mutation RETURNING row lacks the projected logical column', async () => {
		const execute = vi.fn().mockResolvedValueOnce([{ title: 'Touched' }]);
		const { nql } = createMutationBindingTag(execute, undefined, undefined, {
			dbCasing: 'snake_case',
		});

		await expect(
			nql`update posts set title = ${'Touched'} where id = ${1} | select authorId | bind touched
posts | where authorId in (touched) | select authorId`.all(),
		).rejects.toThrow(
			"NQL mutation binding 'touched' returned a row without projected column 'authorId'.",
		);
		expect(execute).toHaveBeenCalledOnce();
	});

	it('fails loud when a mutation binding projects an unknown column spelling', async () => {
		const execute = vi.fn();
		const { nql } = createMutationBindingTag(execute, undefined, undefined, {
			dbCasing: 'snake_case',
		});

		await expect(
			nql`update posts set title = ${'Touched'} where id = ${1} | select author_uuid | bind touched
posts | where authorId in (touched) | select authorId`.all(),
		).rejects.toThrow("Column 'author_uuid' does not exist on table 'posts'.");
		expect(execute).not.toHaveBeenCalled();
	});

	it('rolls back the whole tag program when a later mutation fails', async () => {
		const events: string[] = [];
		const execute = vi
			.fn()
			.mockResolvedValueOnce([{ id: 13 }])
			.mockRejectedValueOnce(new Error('update failed'));
		const transaction = vi.fn();
		const { nql } = createMutationBindingTag(execute, transaction);
		transaction.mockImplementation(async (fn) => {
			events.push('begin');
			const adapter = createPgsqlCompileOnlyAdapter() as unknown as Adapter;
			adapter.execute = execute;
			adapter.transaction = transaction as Adapter['transaction'];
			try {
				const result = await fn(adapter);
				events.push('commit');
				return result;
			} catch (error) {
				events.push('rollback');
				throw error;
			}
		});

		await expect(
			nql`insert into users set name = ${'Alice'} | select id | bind new_user
update users set active = ${true} where id in (new_user) | select id`.all(),
		).rejects.toThrow('update failed');

		expect(events).toEqual(['begin', 'rollback']);
		expect(execute).toHaveBeenCalledTimes(2);
	});

	it('runs per-mutation hooks in statement order inside the transaction', async () => {
		const events: string[] = [];
		const hooks = getHookStore(
			createHookManager()
				.beforeMutation((ctx) => {
					events.push(`before:${ctx.operation}:${ctx.inTransaction}`);
					return ctx;
				})
				.afterMutation((ctx, rows) => {
					events.push(
						`after:${ctx.operation}:${ctx.inTransaction}:${rows.length}`,
					);
					return rows;
				}),
		);
		const execute = vi
			.fn()
			.mockResolvedValueOnce([{ id: 14 }])
			.mockResolvedValueOnce([{ id: 14 }]);
		const { nql } = createMutationBindingTag(execute, undefined, hooks);

		await nql`insert into users set name = ${'Alice'} | select id | bind new_user
update users set active = ${true} where id in (new_user) | select id`.all();

		expect(events).toEqual([
			'before:insert:true',
			'after:insert:true:1',
			'before:update:true',
			'after:update:true:1',
		]);
	});

	it('fails loud for mutation bind without RETURNING', () => {
		const { nql } = createBindingTag();

		expect(() => {
			nql`insert into users set name = ${'Alice'} | bind new_user
users | select id`.dump();
		}).toThrow(/must include a `returning` clause/);
	});

	it('fails loud when a later statement references a non-projected mutation binding column', () => {
		const { nql } = createBindingTag();

		expect(() => {
			nql`insert into users set name = ${'Alice'} | select id | bind new_user
new_user | select name`.dump();
		}).toThrow(/Column 'name' is not projected by NQL binding 'new_user'/);
	});

	it('dump() exposes a compile-only sequence for mutation bindings without executing', () => {
		const execute = vi.fn(async () => [{ id: 14 }]);
		const { adapter, nql } = createMutationBindingTag(execute);

		const dump =
			nql`insert into users set name = ${'Alice'} | select id | bind new_user
update users set active = ${true} where id in (new_user) | select id`.dump() as MutationDump;

		expect(adapter.execute).not.toHaveBeenCalled();
		expect(dump.sequence).toHaveLength(2);
		expect(dump.sequence?.[0]).toMatchObject({
			kind: 'mutation',
			bindName: 'new_user',
		});
		expect(dump.sequence?.[1]).toMatchObject({ kind: 'mutation' });
		expect(dump.sequence?.[1]?.sql).toContain('WITH "new_user" ("id") as (');
		expect(dump.sequence?.[1]?.sql).toContain(
			'SELECT "id" FROM "users" WHERE false',
		);
		expect(dump.sequence?.[1]?.sql).not.toContain('NULL::');
		expect(dump.sequence?.[1]?.sql).not.toContain('VALUES (NULL)');
		expect(dump.sequence?.[1]?.sql).not.toMatch(
			/WITH "new_user"\s+as\s+\(\s*insert/i,
		);
		expect(dump.parameters).toEqual(['Alice', true]);
		expect(dump.sequence?.[0]?.sql).toMatch(/\$1\b/);
		expect(dump.sequence?.[1]?.sql).toMatch(/\$1\b/);
		const topLevelPlaceholders = Array.from(
			dump.sql.matchAll(/\$(\d+)/g),
			(match) => Number(match[1]),
		);
		expect(topLevelPlaceholders).toEqual([1, 2]);
		expect(dump.sql).toContain('$2');
	});

	it('dump() emits table-derived empty bindings for shorthand schema columns without originalDbType', () => {
		const execute = vi.fn(async () => [{ title: 'Touched' }]);
		const { nql } = createMutationBindingTag(execute);

		const dump =
			nql`update posts set title = ${'Touched'} where id = ${1} | select title | bind touched
posts | where title in (touched) | select title`.dump();

		expect(dump.sequence).toHaveLength(2);
		expect(dump.sequence?.[1]?.sql).toContain(
			'WITH "touched" ("title") as (SELECT "title" FROM "posts" WHERE false)',
		);
		expect(dump.sequence?.[1]?.sql).not.toContain('NULL::');
		expect(dump.sequence?.[1]?.sql).not.toContain('VALUES (NULL)');
	});
});
