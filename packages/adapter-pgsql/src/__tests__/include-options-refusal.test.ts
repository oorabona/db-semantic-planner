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
		authorId: ref('users', { inverse: 'posts' }),
		rank: { type: 'integer', nullable: true },
		title: 'text',
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		postId: ref('posts', { inverse: 'comments' }),
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
			'Invalid Include include[0].include[0](comments) limit: Include include[0].include[0](comments) limit must be a non-negative safe integer',
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
				`Invalid include: Include include[0].include[0](comments) ${option} is not supported by 'cte' strategy.`,
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
			`SELECT users.*, COALESCE((SELECT json_agg(to_jsonb(__t__) ORDER BY __t__.rank DESC, __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__."authorId" = users.id), '[]'::json) AS posts_json FROM users`,
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
			`SELECT users.*, posts_lat_0.* FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.* FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id ORDER BY posts_inner_0.rank DESC NULLS LAST, posts_inner_0.id ASC NULLS LAST LIMIT 1) AS posts_lat_0 ON true`,
		);
		expect(result.parameters).toEqual([]);
	});
});

it('refuses missing total order', () => {
	const keyed = schema({
		users: { id: { type: 'integer', primaryKey: true } },
		posts: { authorId: ref('users', { inverse: 'posts' }), rank: 'integer' },
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
			authorId: ref('users', { inverse: 'posts' }),
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
		`SELECT users.*, posts_lat_0.*, comments_lat_1.* FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.* FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id ORDER BY posts_inner_0.rank DESC, posts_inner_0.id ASC NULLS LAST LIMIT 2) AS posts_lat_0 ON true LEFT JOIN LATERAL (SELECT comments_inner_1.* FROM comments AS comments_inner_1 WHERE comments_inner_1."postId" = posts_lat_0.id ORDER BY comments_inner_1.id ASC NULLS LAST LIMIT 1) AS comments_lat_1 ON true`,
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
			`Invalid include: Include include[0].include[0](children) ${option} is not supported by 'cte' strategy.`,
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
	expect(result.hydrationPlan).toBeUndefined();
});

for (const strategy of ['join', 'cte'] as const) {
	for (const select of [
		{ type: 'all' as const },
		{ type: 'fields' as const, fields: ['id'] },
		{ type: 'fields' as const, fields: ['*'] },
	]) {
		if (
			strategy === 'join' &&
			select.type === 'fields' &&
			select.fields[0] !== '*'
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
		'SELECT users.*, posts.id AS "posts.id" FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId"',
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

it('refuses builder join all', () => {
	const orm = createOrm({ model, adapter: createPgCompileOnlyAdapter() });
	exactError(
		() =>
			orm
				.select('users')
				.include('posts', { join: 'left', select: { type: 'all' } })
				.dump(),
		"Invalid include: Include include[0](posts) select is not supported by 'join' strategy. Received select form: all.",
	);
});
for (const strategy of ['join', 'cte'] as const) {
	it(`names nested all ${strategy} select`, () =>
		exactError(
			() =>
				compile(
					{
						relation: 'posts',
						...(strategy === 'join' && { join: 'left' }),
						include: [
							{
								relation: 'comments',
								...(strategy === 'join' && { join: 'left' }),
								select: { type: 'all' },
							},
						],
					},
					strategy === 'cte' ? 'cte' : undefined,
				),
			`Invalid include: Include include[0].include[0](comments) select is not supported by '${strategy}' strategy.${strategy === 'join' ? ' Received select form: all.' : ''}`,
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
		"Invalid include: Include include[0].include[0](comments) select is not supported by 'cte' strategy.",
	));

it('preserves explicit join field projection', () => {
	const result = compile({
		relation: 'posts',
		join: 'left',
		select: { type: 'fields', fields: ['title'] },
	});
	expect(result.sql).toBe(
		'SELECT users.*, posts.id AS "posts.id", posts.title AS "posts.title" FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId"',
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
			`Invalid include: Include include[0](posts) select is not supported by 'join' strategy. Received select form: ${select.type}${select.type === 'fields' ? ` ${JSON.stringify(select.fields)}` : ''}.`,
		);
	});
	it(`excludes join alternative for ${JSON.stringify(select)}`, () => {
		const report = plan(
			{
				type: 'select',
				from: 'users',
				include: [{ relation: 'posts', select }],
			},
			model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		expect(
			report.decisions.find((d) => d.type === 'include-strategy')?.alternatives,
		).toEqual([]);
	});
}
