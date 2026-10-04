import {
	createOrm,
	POSTGRESQL_CAPABILITIES,
	plan,
	ref,
	schema,
} from '@dbsp/core';
import type { IncludeIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const model = schema({
	users: { id: { type: 'integer', primaryKey: true } },
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', { unique: true, inverse: 'posts' }),
		rank: { type: 'integer', nullable: true },
		title: 'text',
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		postId: ref('posts', { unique: true, inverse: 'comments' }),
	},
}).model;
function compile(include: IncludeIntent, includeStrategy?: 'cte' | 'lateral') {
	const report = plan(
		{ type: 'select', from: 'users', include: [include] },
		model,
		{
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
			...(includeStrategy && { defaultIncludeStrategy: includeStrategy }),
		},
	);
	return createPgCompileOnlyAdapter({ model }).compile(report, { model });
}
function exactError(fn: () => unknown, message: string) {
	let error: unknown;
	try {
		fn();
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toBe(message);
}
describe('include option refusals', () => {
	for (const limit of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		it(`refuses limit ${limit}`, () =>
			exactError(
				() => compile({ relation: 'posts', limit }),
				'Invalid Include include[0](posts) limit: Include include[0](posts) limit must be a non-negative safe integer',
			));
	}
	it('refuses nested invalid limit', () =>
		exactError(
			() =>
				compile({
					relation: 'posts',
					include: [{ relation: 'comments', limit: -1 }],
				}),
			'Invalid Include include[0].include[0](posts.comments) limit: Include include[0].include[0](posts.comments) limit must be a non-negative safe integer',
		));
	it('refuses join orderBy', () =>
		exactError(
			() =>
				compile({
					relation: 'posts',
					join: 'left',
					orderBy: [{ field: 'rank', direction: 'desc' }],
				}),
			"Invalid include: Include include[0](posts) orderBy is not supported by 'join' strategy.",
		));
	it('refuses join limit with useful guidance', () =>
		exactError(
			() => compile({ relation: 'posts', join: 'left', limit: 1 }),
			"Invalid include: Include include[0](posts) limit is not supported by 'join' strategy. Remove the explicit join or use a strategy that limits per parent (json_agg, lateral).",
		));
	it('refuses lateral orderBy without limit', () =>
		exactError(
			() =>
				compile(
					{
						relation: 'posts',
						orderBy: [{ field: 'rank', direction: 'desc' }],
					},
					'lateral',
				),
			"Invalid include: Include include[0](posts) orderBy requires limit with 'lateral' strategy",
		));
	it('refuses partial lateral select', () =>
		exactError(
			() =>
				compile({
					relation: 'posts',
					strategy: 'flat',
					limit: 1,
					select: { type: 'fields', fields: ['id'] },
				}),
			"Invalid include: Include include[0](posts) select must select all columns with 'lateral' strategy",
		));
	for (const option of ['limit', 'orderBy'] as const) {
		it(`refuses cte ${option}`, () =>
			exactError(
				() =>
					compile(
						{
							relation: 'posts',
							[option]:
								option === 'limit' ? 1 : [{ field: 'rank', direction: 'desc' }],
						},
						'cte',
					),
				`Invalid include: Include include[0](posts) ${option} is not supported by 'cte' strategy.`,
			));
		it(`refuses nested cte ${option}`, () =>
			exactError(
				() =>
					compile(
						{
							relation: 'posts',
							join: 'left',
							include: [
								{
									relation: 'comments',
									[option]:
										option === 'limit'
											? 1
											: [{ field: 'id', direction: 'asc' }],
								},
							],
						},
						'cte',
					),
				`Invalid include: Include include[0].include[0](posts.comments) ${option} is not supported by 'cte' strategy.`,
			));
	}
	it('refuses runtime expression order', () =>
		exactError(
			() =>
				compile({
					relation: 'posts',
					orderBy: [
						{ expression: { type: 'literal', value: 1 }, direction: 'asc' },
					] as unknown as IncludeIntent['orderBy'],
				}),
			'Include posts orderBy requires fields, asc/desc direction and first/last nulls',
		));
});

describe('ordered includes', () => {
	it('orders json_agg without limit using PostgreSQL DESC defaults', () => {
		const result = compile({
			relation: 'posts',
			orderBy: [{ field: 'rank', direction: 'desc' }],
		});
		expect(result.sql).toBe(
			"SELECT users.*, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'authorId', __t__.\"authorId\", 'rank', __t__.rank, 'title', __t__.title) ORDER BY __t__.rank DESC, __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__.\"authorId\" = users.id), '[]'::json) AS posts_json FROM users",
		);
		expect(result.parameters).toEqual([]);
	});
	it('orders lateral before limit', () => {
		const result = compile({
			relation: 'posts',
			strategy: 'flat',
			limit: 1,
			orderBy: [{ field: 'rank', direction: 'desc', nulls: 'last' }],
		});
		expect(result.sql).toBe(
			'SELECT users.*, posts_lat_0.id AS "posts.id", posts_lat_0."authorId" AS "posts.authorId", posts_lat_0.rank AS "posts.rank", posts_lat_0.title AS "posts.title" FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.id, posts_inner_0."authorId", posts_inner_0.rank, posts_inner_0.title FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id ORDER BY posts_inner_0.rank DESC NULLS LAST, posts_inner_0.id ASC NULLS LAST LIMIT 1) AS posts_lat_0 ON true',
		);
		expect(result.parameters).toEqual([]);
	});
});

it('refuses missing total order', () => {
	const keyed = schema({
		users: { id: { type: 'integer', primaryKey: true } },
		posts: {
			authorId: ref('users', { unique: true, inverse: 'posts' }),
			rank: 'integer',
		},
	}).model;
	const noKey: typeof keyed = Object.assign(Object.create(keyed), {
		getTable(name: string) {
			const table = keyed.getTable(name);
			return name === 'posts' && table ? { ...table, primaryKey: [] } : table;
		},
	});
	exactError(() => {
		const report = plan(
			{
				type: 'select',
				from: 'users',
				include: [{ relation: 'posts', limit: 1 }],
			},
			noKey,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		createPgCompileOnlyAdapter({ model: noKey }).compile(report, {
			model: noKey,
		});
	}, 'Include posts limit requires a primary key or unique ordering for a total order');
});
for (const option of ['limit', 'orderBy'] as const) {
	it(`refuses recursive ${option}`, () => {
		const tree = schema({
			nodes: {
				id: { type: 'integer', primaryKey: true },
				parentId: ref('nodes', {
					nullable: true,
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		}).model;
		exactError(
			() =>
				plan(
					{
						type: 'select',
						from: 'nodes',
						include: [
							{
								relation: 'children',
								recursive: { maxDepth: 3 },
								[option]:
									option === 'limit' ? 2 : [{ field: 'id', direction: 'asc' }],
							},
						],
					},
					tree,
					{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
				),
			`Invalid include: Include include[0](children) ${option} is not supported by 'cte' strategy.`,
		);
	});
}

it('chunks 51 selected fields independently', () => {
	const fields = Array.from({ length: 51 }, (_, i) => `f${i}`);
	const wide = schema({
		users: { id: { type: 'integer', primaryKey: true } },
		posts: {
			id: { type: 'integer', primaryKey: true },
			authorId: ref('users', { unique: true, inverse: 'posts' }),
			...Object.fromEntries(fields.map((field) => [field, 'text' as const])),
		},
	}).model;
	const report = plan(
		{
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts', select: { type: 'fields', fields } }],
		},
		wide,
		{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
	);
	const result = createPgCompileOnlyAdapter({ model: wide }).compile(report, {
		model: wide,
	});
	const args = fields
		.slice(0, 50)
		.map((field) => `'${field}', __t__.${field}`)
		.join(', ');
	expect(result.sql).toBe(
		`SELECT users.*, COALESCE((SELECT json_agg(jsonb_build_object(${args}) || jsonb_build_object('f50', __t__.f50) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__."authorId" = users.id), '[]'::json) AS posts_json FROM users`,
	);
	expect(result.parameters).toEqual([]);
});

it('orders nested lateral limits', () => {
	const result = compile({
		relation: 'posts',
		strategy: 'flat',
		limit: 2,
		orderBy: [{ field: 'rank', direction: 'desc' }],
		include: [{ relation: 'comments', strategy: 'flat', limit: 1 }],
	});
	expect(result.sql).toBe(
		'SELECT users.*, posts_lat_0.id AS "posts.id", posts_lat_0."authorId" AS "posts.authorId", posts_lat_0.rank AS "posts.rank", posts_lat_0.title AS "posts.title", comments_lat_1.id AS "posts.comments.id", comments_lat_1."postId" AS "posts.comments.postId" FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.id, posts_inner_0."authorId", posts_inner_0.rank, posts_inner_0.title FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id ORDER BY posts_inner_0.rank DESC, posts_inner_0.id ASC NULLS LAST LIMIT 2) AS posts_lat_0 ON true LEFT JOIN LATERAL (SELECT comments_inner_1.id, comments_inner_1."postId" FROM comments AS comments_inner_1 WHERE comments_inner_1."postId" = posts_lat_0.id ORDER BY comments_inner_1.id ASC NULLS LAST LIMIT 1) AS comments_lat_1 ON true',
	);
	expect(result.parameters).toEqual([]);
});

for (const option of ['limit', 'orderBy'] as const) {
	it(`refuses nested recursive ${option}`, () => {
		const tree = schema({
			nodes: {
				id: { type: 'integer', primaryKey: true },
				parentId: ref('nodes', {
					nullable: true,
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		}).model;
		exactError(
			() =>
				plan(
					{
						type: 'select',
						from: 'nodes',
						include: [
							{
								relation: 'children',
								recursive: { maxDepth: 3 },
								include: [
									{
										relation: 'children',
										recursive: { maxDepth: 3 },
										[option]:
											option === 'limit'
												? 2
												: [{ field: 'id', direction: 'asc' }],
									},
								],
							},
						],
					},
					tree,
					{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
				),
			`Invalid include: Include include[0].include[0](children.children) ${option} is not supported by 'cte' strategy.`,
		);
	});
}
it('refuses nested runtime expression order with full relation path', () =>
	exactError(
		() =>
			compile({
				relation: 'posts',
				include: [
					{
						relation: 'comments',
						orderBy: [
							{ expression: { type: 'literal', value: 1 }, direction: 'asc' },
						] as unknown as IncludeIntent['orderBy'],
					},
				],
			}),
		'Include posts.comments orderBy requires fields, asc/desc direction and first/last nulls',
	));

it('keeps empty projection hydration metadata empty', () => {
	const result = compile({
		relation: 'posts',
		select: { type: 'fields', fields: [] },
	});
	expect(result.hydrationPlan?.includePayloads?.[0]?.columns).toEqual([]);
});

for (const strategy of ['join', 'cte'] as const) {
	for (const select of [
		{ type: 'all' as const },
		{ type: 'fields' as const, fields: ['id'] },
		{ type: 'fields' as const, fields: ['*'] },
	]) {
		if (
			strategy === 'join' &&
			(select.type === 'all' || select.type === 'fields') &&
			(select.type === 'all' || select.fields[0] !== '*')
		)
			continue;
		it(`refuses ${strategy} select ${JSON.stringify(select)}`, () =>
			exactError(
				() =>
					compile(
						{
							relation: 'posts',
							...(strategy === 'join' && { join: 'left' }),
							select,
						},
						strategy === 'cte' ? 'cte' : undefined,
					),
				`Invalid include: Include include[0](posts) select is not supported by '${strategy}' strategy.${strategy === 'join' ? ` Received select form: ${select.type}${select.type === 'fields' ? ` ${JSON.stringify(select.fields)}` : ''}.` : ''}`,
			));
	}
}
it('refuses sparse order entries', () =>
	exactError(
		() => compile({ relation: 'posts', orderBy: new Array(1) }),
		'Include posts orderBy requires fields, asc/desc direction and first/last nulls',
	));
it('preserves the omitted-select join projection', () => {
	expect(compile({ relation: 'posts', join: 'left' }).sql).toBe(
		'SELECT users.*, posts.id AS "posts.id", posts."authorId" AS "posts.authorId", posts.rank AS "posts.rank", posts.title AS "posts.title", posts.id AS __dbsp_presence_posts FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId"',
	);
});
it('excludes partial-select alternatives', () => {
	const report = plan(
		{
			type: 'select',
			from: 'users',
			include: [
				{ relation: 'posts', select: { type: 'fields', fields: ['id'] } },
			],
		},
		model,
		{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
	);
	expect(
		report.decisions.find((d) => d.type === 'include-strategy')?.alternatives,
	).toEqual(['join']);
});

it('accepts builder join all as the whole related row', () => {
	const orm = createOrm({ model, adapter: createPgCompileOnlyAdapter() });
	expect(
		orm
			.select('users')
			.include('posts', { join: 'left', select: { type: 'all' } })
			.dump().sql,
	).toBe(compile({ relation: 'posts', join: 'left' }).sql);
});

for (const strategy of ['join', 'cte'] as const) {
	if (strategy === 'join') {
		it('accepts nested all join selection', () => {
			const result = compile({
				relation: 'posts',
				join: 'left',
				include: [
					{ relation: 'comments', join: 'left', select: { type: 'all' } },
				],
			});
			expect(
				result.hydrationPlan?.includePayloads?.[0]?.children[0]?.columns.map(
					(column) => column.publicKey,
				),
			).toEqual(['id', 'postId']);
		});
		continue;
	}
	it(`names nested all ${strategy} select`, () =>
		exactError(
			() =>
				compile(
					{
						relation: 'posts',

						include: [
							{
								relation: 'comments',

								select: { type: 'all' },
							},
						],
					},
					'cte',
				),
			`Invalid include: Include include[0].include[0](posts.comments) select is not supported by '${strategy}' strategy.`,
		));
}

it('names nested cte field selection', () =>
	exactError(
		() =>
			compile(
				{
					relation: 'posts',
					include: [
						{
							relation: 'comments',
							select: { type: 'fields', fields: ['id'] },
						},
					],
				},
				'cte',
			),
		"Invalid include: Include include[0].include[0](posts.comments) select is not supported by 'cte' strategy.",
	));

it('preserves explicit join field projection', () => {
	const result = compile({
		relation: 'posts',
		join: 'left',
		select: { type: 'fields', fields: ['title'] },
	});
	expect(result.sql).toBe(
		'SELECT users.*, posts.title AS "posts.title", posts.id AS __dbsp_presence_posts FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId"',
	);
	expect(result.parameters).toEqual([]);
});

for (const select of [
	{ type: 'expressions', columns: [] },
	{
		type: 'aggregate',
		aggregates: [{ function: 'count', field: '*', as: 'n' }],
	},
	{ type: 'fields', fields: ['*', 'id'] },
] as const) {
	it(`refuses join select form ${JSON.stringify(select)}`, () => {
		const orm = createOrm({ model, adapter: createPgCompileOnlyAdapter() });
		exactError(
			() =>
				orm.select('users').include('posts', { join: 'left', select }).dump(),
			select.type === 'fields'
				? "Include posts select cannot mix '*' with other fields"
				: `Invalid include: Include include[0](posts) select is not supported by 'join' strategy. Received select form: ${select.type}.`,
		);
	});
	it(`refuses default json_agg select form ${JSON.stringify(select)} during planning`, () => {
		expect(() =>
			plan(
				{
					type: 'select',
					from: 'users',
					include: [{ relation: 'posts', select }],
				},
				model,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			),
		).toThrow(
			select.type === 'fields'
				? "Include posts select cannot mix '*' with other fields"
				: `JSON_AGG include 'posts' does not support select form '${select.type}'`,
		);
	});
}

for (const strategy of ['json_agg', 'lateral', 'join', 'cte'] as const) {
	it(`planning refuses nested mixed wildcards for ${strategy}`, () => {
		exactError(
			() =>
				plan(
					{
						type: 'select',
						from: 'users',
						include: [
							{
								relation: 'posts',
								include: [
									{
										relation: 'comments',
										select: { type: 'fields', fields: ['*', 'id'] },
									},
								],
							},
						],
					},
					model,
					{
						dialectCapabilities: POSTGRESQL_CAPABILITIES,
						defaultIncludeStrategy: strategy,
					},
				),
			"Include posts.comments select cannot mix '*' with other fields",
		);
	});
	for (const select of [
		{ type: 'aggregate', aggregates: [{ function: 'count' }] },
		{ type: 'expressions', columns: [] },
	] as const) {
		it(`planning refuses nested ${select.type} for ${strategy}`, () => {
			expect(() =>
				plan(
					{
						type: 'select',
						from: 'users',
						include: [
							{
								relation: 'posts',
								include: [{ relation: 'comments', select }],
							},
						],
					},
					model,
					{
						dialectCapabilities: POSTGRESQL_CAPABILITIES,
						defaultIncludeStrategy: strategy,
					},
				),
			).toThrow(
				strategy === 'json_agg'
					? `JSON_AGG include 'posts.comments' does not support select form '${select.type}'`
					: strategy === 'lateral'
						? "Invalid include: Include include[0].include[0](posts.comments) select must select all columns with 'lateral' strategy"
						: `Invalid include: Include include[0].include[0](posts.comments) select is not supported by '${strategy}' strategy.`,
			);
		});
	}
}
it('refuses a wildcard limited include without an enumerable compile model', () => {
	const report = plan(
		{
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts', limit: 1 }],
		},
		model,
		{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
	);
	exactError(
		() => createPgCompileOnlyAdapter().compile(report),
		"Include payload 'posts' cannot enumerate wildcard keys for opaque target 'posts'.",
	);
});
it('builder plan refuses aggregate json_agg select', () => {
	const orm = createOrm({ model, adapter: createPgCompileOnlyAdapter() });
	exactError(
		() =>
			orm
				.select('users')
				.include('posts', {
					select: { type: 'aggregate', aggregates: [{ function: 'count' }] },
				})
				.plan(),
		"JSON_AGG include 'posts' does not support select form 'aggregate'",
	);
});

for (const select of [
	{ type: 'aggregate', aggregates: [{ function: 'count' }] },
	{ type: 'expressions', columns: [] },
	{ type: 'fields', fields: ['*', 'id'] },
] as const) {
	it(`adapter defence matches planning for nested ${JSON.stringify(select)}`, () => {
		const intent = {
			type: 'select' as const,
			from: 'users',
			include: [
				{ relation: 'posts', include: [{ relation: 'comments', select }] },
			],
		};
		const message =
			select.type === 'fields'
				? "Include posts.comments select cannot mix '*' with other fields"
				: `JSON_AGG include 'posts.comments' does not support select form '${select.type}'`;
		exactError(
			() =>
				plan(intent, model, { dialectCapabilities: POSTGRESQL_CAPABILITIES }),
			message,
		);
		const valid = plan(
			{
				type: 'select',
				from: 'users',
				include: [{ relation: 'posts', include: [{ relation: 'comments' }] }],
			},
			model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		exactError(
			() => createPgCompileOnlyAdapter().compile({ ...valid, intent }),
			message,
		);
	});
}
for (const strategy of ['json_agg', 'lateral'] as const) {
	it(`keeps singleton wildcard as all columns for ${strategy}`, () => {
		const makePlan = (select?: IncludeIntent['select']) =>
			plan(
				{
					type: 'select',
					from: 'users',
					include: [{ relation: 'posts', limit: 1, ...(select && { select }) }],
				},
				model,
				{
					dialectCapabilities: POSTGRESQL_CAPABILITIES,
					defaultIncludeStrategy: strategy,
				},
			);
		const adapter = createPgCompileOnlyAdapter({ model });
		expect(
			adapter.compile(makePlan({ type: 'fields', fields: ['*'] })).sql,
		).toBe(adapter.compile(makePlan()).sql);
		expect(adapter.compile(makePlan()).sql).toBe(
			strategy === 'json_agg'
				? `SELECT users.*, COALESCE((SELECT json_agg(__lim.__row ORDER BY __lim.__key0 ASC NULLS LAST) FROM (SELECT jsonb_build_object('id', __t__.id, 'authorId', __t__."authorId", 'rank', __t__.rank, 'title', __t__.title) AS __row, __t__.id AS __key0 FROM posts AS __t__ WHERE __t__."authorId" = users.id ORDER BY __t__.id ASC NULLS LAST LIMIT 1) AS __lim), '[]'::json) AS posts_json FROM users`
				: 'SELECT users.*, posts_lat_0.id AS "posts.id", posts_lat_0."authorId" AS "posts.authorId", posts_lat_0.rank AS "posts.rank", posts_lat_0.title AS "posts.title", posts_lat_0.__dbsp_presence_posts AS __dbsp_presence_posts FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.id, posts_inner_0."authorId", posts_inner_0.rank, posts_inner_0.title, posts_inner_0.id AS __dbsp_presence_posts FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id ORDER BY posts_inner_0.id ASC NULLS LAST LIMIT 1) AS posts_lat_0 ON true',
		);
	});
}

it('revalidates recorded total order against a compile model without a key', () => {
	const report = plan(
		{
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts', limit: 1 }],
		},
		model,
		{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
	);
	const noKey: typeof model = Object.assign(Object.create(model), {
		getTable(name: string) {
			const table = model.getTable(name);
			return name === 'posts' && table ? { ...table, primaryKey: [] } : table;
		},
	});
	expect(() =>
		createPgCompileOnlyAdapter().compile(report, { model: noKey }),
	).toThrowError(
		'Include posts limit requires a primary key or unique ordering for a total order',
	);
});
