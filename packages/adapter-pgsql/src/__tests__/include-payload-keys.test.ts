import {
	col,
	createOrm,
	fn,
	literal,
	POSTGRESQL_CAPABILITIES,
	param,
	plan,
	ResultHydrator,
	ref,
	relationColumn,
	rowNumber,
	schema,
	star,
} from '@dbsp/core';
import type { IncludeIntent, IncludePayloadShape } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

function payloadModel(toOne = false) {
	return schema({
		roots: { id: { type: 'integer', primaryKey: true } },
		authors: {
			id: { type: 'integer', primaryKey: true },
			rootId: ref('roots', { unique: toOne, inverse: 'authors' }),
			firstName: 'text',
			amount: { type: 'bigint', js: 'bigint' },
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			authorId: ref('authors', { unique: toOne, inverse: 'posts' }),
			firstName: 'text',
			amount: { type: 'bigint', js: 'bigint' },
		},
		comments: {
			id: { type: 'integer', primaryKey: true },
			postId: ref('posts', { unique: toOne, inverse: 'comments' }),
			firstName: 'text',
			amount: { type: 'bigint', js: 'bigint' },
		},
	}).model;
}
const model = payloadModel();

function compile(
	strategy: 'json_agg' | 'lateral' | 'join',
	casing: 'preserve' | 'snake_case',
	projection: readonly ReturnType<typeof relationColumn>[],
	include: IncludeIntent = {
		relation: 'authors',
		include: [{ relation: 'posts', include: [{ relation: 'comments' }] }],
	},
) {
	const model = payloadModel(strategy === 'join');
	const adapter = createPgCompileOnlyAdapter({ model, dbCasing: casing });
	const report = createOrm({ model, adapter })
		.select('roots')
		.withPlanOptions({ defaultIncludeStrategy: strategy })
		.include(include.relation, {
			...(include.include && {
				include: include.include.map((child) => ({
					relation: child.relation,
					...(child.include && {
						include: child.include.map((leaf) => ({ relation: leaf.relation })),
					}),
				})),
			}),
		})
		.columns([...projection])
		.plan();
	return { report, query: adapter.compile(report, { model }) };
}

for (const strategy of ['json_agg', 'lateral', 'join'] as const)
	for (const casing of ['preserve', 'snake_case'] as const) {
		describe(`${strategy} ${casing}`, () => {
			it('owns exact keys and aliased bigint reads at depths 1-3', () => {
				const projection = [
					'authors',
					'authors.posts',
					'authors.posts.comments',
				].flatMap((path) => [
					relationColumn(path, 'firstName', 'first_name'),
					relationColumn(path, 'amount', 'value'),
				]);
				const { report, query } = compile(strategy, casing, projection);
				const shapes = query.hydrationPlan?.includePayloads;
				expect(shapes).toHaveLength(1);
				const leaf = { first_name: 'C', value: 9007199254740993n };
				const post = {
					first_name: 'P',
					value: 9007199254740993n,
					comments: strategy === 'json_agg' ? [leaf] : leaf,
				};
				const author = {
					first_name: 'A',
					value: 9007199254740993n,
					posts: strategy === 'json_agg' ? [post] : post,
				};
				const rows: Record<string, unknown>[] = [{}];
				if (strategy === 'json_agg')
					rows[0]!.authors_json = [
						{
							first_name: 'A',
							value: '9007199254740993',
							posts: [
								{
									first_name: 'P',
									value: '9007199254740993',
									comments: [{ first_name: 'C', value: '9007199254740993' }],
								},
							],
						},
					];
				else {
					const populate = (shape: IncludePayloadShape, name: string): void => {
						if (shape.presence) rows[0]![shape.presence.outputLabel] = 1;
						for (const column of shape.columns)
							rows[0]![column.outputLabel] =
								column.publicKey === 'value' ? '9007199254740993' : name;
						for (const child of shape.children)
							populate(child, name === 'A' ? 'P' : 'C');
					};
					populate(shapes![0]!, 'A');
				}
				const hydrator = new ResultHydrator(model, 'roots');
				hydrator.hydrateJsonAggIncludes(rows, report, query);
				hydrator.hydrateJoinIncludes(rows, report, query);
				expect(rows).toEqual([
					{ authors: strategy === 'json_agg' ? [author] : author },
				]);
				expect(query.sql).not.toContain('_lat_0.*');
				expect(shapes![0]!.columns.map((column) => column.publicKey)).toEqual([
					'first_name',
					'value',
				]);
			});
			for (const path of ['authors', 'authors.posts']) {
				for (const [name, columns, key] of [
					[
						'two aliases',
						[
							relationColumn(path, 'firstName', 'x'),
							relationColumn(path, 'amount', 'x'),
						],
						'x',
					],
					[
						'alias vs declared',
						[
							relationColumn(path, 'firstName', 'amount'),
							relationColumn(path, 'amount', 'amount'),
						],
						'amount',
					],
					[
						'alias vs child',
						[
							relationColumn(
								path,
								'firstName',
								path === 'authors' ? 'posts' : 'comments',
							),
						],
						path === 'authors' ? 'posts' : 'comments',
					],
				] as const)
					it(`refuses ${name} at ${path}`, () => {
						expect(() => compile(strategy, casing, columns)).toThrow(
							`Include payload '${path}' has conflicting public key '${key}'`,
						);
					});
			}
			it('deduplicates an exact source/key request', () => {
				const col = relationColumn('authors', 'firstName', 'label');
				const { query } = compile(strategy, casing, [col, col], {
					relation: 'authors',
				});
				expect(query.hydrationPlan?.includePayloads?.[0]?.columns).toHaveLength(
					1,
				);
			});
		});
	}
it('refuses an opaque wildcard before SQL', () => {
	const report = plan(
		{ type: 'select', from: 'roots', include: [{ relation: 'authors' }] },
		model,
		{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
	);
	expect(() => createPgCompileOnlyAdapter().compile(report)).toThrow(
		"cannot enumerate wildcard keys for opaque target 'authors'",
	);
});
it('refuses a root scalar alias owned by an include', () => {
	const adapter = createPgCompileOnlyAdapter({ model });
	expect(() =>
		createOrm({ model, adapter })
			.select('roots')
			.columns([col('id', 'authors')])
			.include('authors')
			.dump(),
	).toThrow("Include payload '$' has conflicting public key 'authors'");
});

for (const casing of ['preserve', 'snake_case'] as const)
	for (const strategy of ['json_agg', 'lateral', 'join'] as const) {
		it(`emits exact aliased SQL for ${strategy} ${casing}`, () => {
			const { query } = compile(
				strategy,
				casing,
				[relationColumn('authors', 'firstName', 'first_name')],
				{ relation: 'authors' },
			);
			const field = casing === 'preserve' ? '"firstName"' : 'first_name';
			const fk = casing === 'preserve' ? '"rootId"' : 'root_id';
			const expected =
				strategy === 'json_agg'
					? `SELECT COALESCE((SELECT json_agg(jsonb_build_object('first_name', __t__.${field}) ORDER BY __t__.id ASC NULLS LAST) FROM authors AS __t__ WHERE __t__.${fk} = roots.id), '[]'::json) AS authors_json FROM roots`
					: strategy === 'lateral'
						? `SELECT authors_lat_0.${field} AS "authors.first_name", authors_lat_0.__dbsp_presence_authors AS __dbsp_presence_authors FROM roots LEFT JOIN LATERAL (SELECT authors_inner_0.${field}, authors_inner_0.id AS __dbsp_presence_authors FROM authors AS authors_inner_0 WHERE authors_inner_0.${fk} = roots.id) AS authors_lat_0 ON true`
						: `SELECT authors.${field} AS "authors.first_name", authors.id AS __dbsp_presence_authors FROM roots LEFT JOIN authors AS authors ON roots.id = authors.${fk}`;
			expect(query.sql).toBe(expected);
		});
	}
it('deduplicates a root scalar source/key request', () => {
	const adapter = createPgCompileOnlyAdapter({ model });
	const report = plan(
		{
			type: 'select',
			from: 'roots',
			select: {
				type: 'expressions',
				columns: [
					{ kind: 'columnAlias', column: 'id', alias: 'value' },
					{ kind: 'columnAlias', column: 'id', alias: 'value' },
				],
			},
		},
		model,
		{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
	);
	expect(adapter.compile(report, { model }).sql).toBe(
		'SELECT roots.id AS value FROM roots',
	);
});
it('refuses a root scalar alias owned by a generated JSON field', () => {
	const adapter = createPgCompileOnlyAdapter({ model });
	expect(() =>
		createOrm({ model, adapter })
			.select('roots')
			.columns([col('id', 'authors_json')])
			.include('authors')
			.dump(),
	).toThrow("Include payload '$' has conflicting public key 'authors_json'");
});

for (const strategy of ['json_agg', 'lateral', 'join'] as const)
	it(`uses requested child names at depths 1-3 with ${strategy}`, () => {
		const namedModel = schema({
			authors: { id: { type: 'integer', primaryKey: true } },
			posts: {
				id: { type: 'integer', primaryKey: true },
				authorId: ref('authors', {
					unique: strategy === 'join',
					inverse: 'author_posts',
				}),
			},
			comments: {
				id: { type: 'integer', primaryKey: true },
				postId: ref('posts', {
					unique: strategy === 'join',
					inverse: 'post_comments',
				}),
			},
			votes: {
				id: { type: 'integer', primaryKey: true },
				commentId: ref('comments', {
					inverse: 'comment_votes',
					unique: strategy === 'join',
				}),
			},
		}).model;
		const adapter = createPgCompileOnlyAdapter({
			model: namedModel,
			dbCasing: 'snake_case',
		});
		const report = createOrm({ model: namedModel, adapter })
			.select('authors')
			.withPlanOptions({ defaultIncludeStrategy: strategy })
			.include('posts', {
				include: [{ relation: 'comments', include: [{ relation: 'votes' }] }],
			})
			.columns(
				['posts', 'posts.comments', 'posts.comments.votes'].map((path) =>
					relationColumn(path, 'id', 'id'),
				),
			)
			.plan();
		const query = adapter.compile(report, { model: namedModel });
		const payload = query.hydrationPlan?.includePayloads?.[0];
		expect(payload?.publicKey).toBe('posts');
		expect(payload?.children[0]?.publicKey).toBe('comments');
		expect(payload?.children[0]?.children[0]?.publicKey).toBe('votes');
		const rows: Record<string, unknown>[] =
			strategy === 'json_agg'
				? [
						{
							[payload!.outputLabel]: [
								{ id: 1, comments: [{ id: 2, votes: [{ id: 3 }] }] },
							],
						},
					]
				: [
						{
							'posts.id': 1,
							'posts.comments.id': 2,
							'posts.comments.votes.id': 3,
						},
					];
		const supply = (shape: IncludePayloadShape) => {
			if (shape.presence) rows[0]![shape.presence.outputLabel] = 1;
			for (const child of shape.children) supply(child);
		};
		supply(payload!);
		const hydrator = new ResultHydrator(namedModel, 'authors');
		hydrator.hydrateJsonAggIncludes(rows, report, query);
		hydrator.hydrateJoinIncludes(rows, report, query);
		expect(rows).toEqual(
			strategy === 'json_agg'
				? [{ posts: [{ id: 1, comments: [{ id: 2, votes: [{ id: 3 }] }] }] }]
				: [{ posts: { id: 1, comments: { id: 2, votes: { id: 3 } } } }],
		);
	});

it('907 owns function labels, expands stars, and refuses unknown labels', () => {
	const labelModel = schema({
		roots: { id: { type: 'integer', primaryKey: true }, now: 'text' },
		events: {
			id: { type: 'integer', primaryKey: true },
			rootId: ref('roots', { inverse: 'now' }),
		},
	}).model;
	const adapter = createPgCompileOnlyAdapter({ model: labelModel });
	const orm = createOrm({ model: labelModel, adapter });
	expect(() =>
		orm
			.select('roots')
			.columns([fn('now')])
			.include('now')
			.dump(),
	).toThrow("Include payload '$' has conflicting public key 'now'");
	expect(() =>
		orm.select('roots').columns([star()]).include('now').dump(),
	).toThrow("Include payload '$' has conflicting public key 'now'");
	expect(() =>
		orm
			.select('roots')
			.columns([literal(1)])
			.include('now')
			.dump(),
	).toThrow('use .as(...)');
	const report = orm
		.select('roots')
		.columns([fn('now').as('ts')])
		.include('now')
		.plan();
	const query = adapter.compile(report, { model: labelModel });
	expect(query.sql).toContain('now() AS ts');
	const rows = [{ ts: 'timestamp', now_json: [{ id: 1, rootId: 2 }] }];
	new ResultHydrator(labelModel, 'roots').hydrateJsonAggIncludes(
		rows,
		report,
		query,
	);
	expect(rows).toEqual([{ ts: 'timestamp', now: [{ id: 1, rootId: 2 }] }]);
});

it('907 collapses exact aggregate requests and refuses different owners', () => {
	const model = payloadModel(true);
	const adapter = createPgCompileOnlyAdapter({ model });
	const orm = createOrm({ model, adapter });
	const query = orm
		.select('authors')
		.include('posts', { join: 'left' })
		.count('id', 'n')
		.count('id', 'n')
		.dump();
	expect(query.sql).toBe(
		'SELECT count(authors.id) AS n FROM authors LEFT JOIN posts AS posts ON authors.id = posts."authorId"',
	);
	expect(query.sql.match(/count\(/g)).toHaveLength(1);
	expect(query.sql).toContain('AS n');
	expect(() =>
		orm
			.select('authors')
			.include('posts', { join: 'left' })
			.count('id', 'n')
			.count('amount', 'n')
			.dump(),
	).toThrow("Include payload '$' has conflicting public key 'n'");
});

for (const strategy of ['json_agg', 'join'] as const)
	it(`907 stages every ${strategy} read before changing a row`, () => {
		const atomicModel = schema({
			roots: { id: { type: 'integer', primaryKey: true } },
			children: {
				id: { type: 'integer', primaryKey: true },
				rootId: ref('roots', {
					unique: strategy === 'join',
					inverse: 'children',
				}),
				good: { type: 'bigint', js: 'bigint' },
				bad: { type: 'bigint', js: 'number' },
			},
		}).model;
		const adapter = createPgCompileOnlyAdapter({ model: atomicModel });
		const report = createOrm({ model: atomicModel, adapter })
			.select('roots')
			.withPlanOptions({ defaultIncludeStrategy: strategy })
			.include('children')
			.columns([
				col('id', 'id'),
				...['id', 'rootId', 'good', 'bad'].map((name) =>
					relationColumn('children', name, name),
				),
			])
			.plan();
		const query = adapter.compile(report, { model: atomicModel });
		const rows =
			strategy === 'json_agg'
				? [
						{
							id: 1,
							children_json: [
								{ id: 2, rootId: 1, good: '1', bad: '9007199254740993' },
							],
						},
					]
				: [
						{
							id: 1,
							'children.id': 2,
							'children.rootId': 1,
							'children.good': '1',
							'children.bad': '9007199254740993',
						},
					];
		const before = structuredClone(rows);
		const hydrator = new ResultHydrator(atomicModel, 'roots');
		expect(() =>
			strategy === 'json_agg'
				? hydrator.hydrateJsonAggIncludes(rows, report, query)
				: hydrator.hydrateJoinIncludes(rows, report, query),
		).toThrow(
			new RangeError(
				'Cannot convert PostgreSQL bigint column "children.bad" output key "bad" value "9007199254740993" to number: outside Number.MAX_SAFE_INTEGER; use js:\'bigint\' or omit js.',
			),
		);
		expect(rows).toEqual(before);
	});

it('907k resolves window and NQL scalar function labels', () => {
	const model = payloadModel(true);
	const orm = createOrm({
		model,
		adapter: createPgCompileOnlyAdapter({ model }),
	});
	expect(
		orm
			.select('roots')
			.columns([rowNumber().orderBy('id').as('rn')])
			.include('authors')
			.dump().sql,
	).toBe(
		"SELECT row_number() OVER (ORDER BY roots.id ASC) AS rn, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'rootId', __t__.\"rootId\", 'firstName', __t__.\"firstName\", 'amount', CAST(__t__.amount AS text)) ORDER BY __t__.id ASC NULLS LAST) FROM authors AS __t__ WHERE __t__.\"rootId\" = roots.id), '[]'::json) AS authors_json FROM roots",
	);
	expect(orm.nql`roots | select now(), authors.*`.dump().sql).toContain(
		'now()',
	);
	const collisionModel = schema({
		roots: { id: { type: 'integer', primaryKey: true } },
		events: {
			id: { type: 'integer', primaryKey: true },
			rootId: ref('roots', { inverse: 'now', unique: true }),
		},
	}).model;
	const collisionOrm = createOrm({
		model: collisionModel,
		adapter: createPgCompileOnlyAdapter({ model: collisionModel }),
	});
	expect(() => collisionOrm.nql`roots | select now(), now.*`.dump()).toThrow(
		"Include payload '$' has conflicting public key 'now' (function:now and relation:now).",
	);
});

it('907k diagnostics never expose bound values', () => {
	const orm = createOrm({
		model,
		adapter: createPgCompileOnlyAdapter({ model }),
	});
	const secret = 'sk_live_DO_NOT_LOG';
	const message = (run: () => unknown) => {
		try {
			run();
		} catch (error) {
			return (error as Error).message;
		}
		throw new Error('Expected refusal');
	};
	const unlabeled = message(() =>
		orm
			.select('roots')
			.columns([param(secret)])
			.include('authors')
			.dump(),
	);
	expect(unlabeled).not.toContain(secret);
	expect(unlabeled).toBe(
		'Root projection expression param has no established output label; use .as(...).',
	);
	const collision = message(() =>
		orm
			.select('roots')
			.columns([param(secret).as('authors')])
			.include('authors')
			.dump(),
	);
	expect(collision).toBe(
		"Include payload '$' has conflicting public key 'authors' (param:authors and relation:authors).",
	);
	expect(collision).not.toContain(secret);
});

it('907k normalizes aggregate source and output key', () => {
	const model = payloadModel(true);
	const orm = createOrm({
		model,
		adapter: createPgCompileOnlyAdapter({ model }),
	});
	for (const fn of ['count', 'sum', 'avg', 'min', 'max'] as const) {
		const query = orm
			.select('authors')
			.include('posts', { join: 'left' })
			[fn]('id')
			[fn]('id', fn)
			.dump();
		expect(query.sql).toBe(
			`SELECT ${fn}(authors.id) AS ${fn} FROM authors LEFT JOIN posts AS posts ON authors.id = posts."authorId"`,
		);
		expect(() =>
			orm
				.select('authors')
				.include('posts', { join: 'left' })
				[fn]('id')
				[fn]('amount', fn)
				.dump(),
		).toThrow(
			`Include payload '$' has conflicting public key '${fn}' (aggregate:${fn} and aggregate:${fn}).`,
		);
	}
});
