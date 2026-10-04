import {
	createOrm,
	InvalidOperationError,
	nqlRaw,
	ResultHydrator,
	ref,
	schema,
} from '@dbsp/core';
import type { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import {
	createPgAdapter,
	createPgCompileOnlyAdapter,
} from '../pgsql-adapter.js';
import { compileSetOperation } from '../set-operation.js';

const db = schema({
	files: { id: { type: 'integer', primaryKey: true }, path: 'string' },
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		fileId: ref('files', { as: 'file' }),
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
		title: 'string',
	},
});
const cases = [
	[
		'users | select *, posts.title',
		"SELECT users.*, COALESCE((SELECT json_agg(jsonb_build_object('title', __t__.title) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__.\"authorId\" = users.id), '[]'::json) AS posts_json FROM users",
	],
	[
		'users | select *, posts.title | flat',
		'SELECT users.*, posts.title AS "posts.title" FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId"',
	],
	[
		'posts | select *, author.name',
		"SELECT posts.*, COALESCE((SELECT json_agg(jsonb_build_object('name', __t__.name) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts.\"authorId\"), '[]'::json) AS author_json FROM posts",
	],
	[
		'posts | select *, author.name | flat',
		'SELECT posts.*, author.name AS "author.name" FROM posts JOIN users AS author ON posts."authorId" = author.id',
	],
	[
		'posts | select *, author.file.path as fp',
		"SELECT posts.*, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'name', __t__.name, 'fileId', __t__.\"fileId\") || jsonb_build_object('file', COALESCE((SELECT json_agg(jsonb_build_object('fp', __t1__.path) ORDER BY __t1__.id ASC NULLS LAST) FROM files AS __t1__ WHERE __t1__.id = __t__.\"fileId\"), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts.\"authorId\"), '[]'::json) AS author_json FROM posts",
	],
	[
		'posts | select *, author.file.path as fp | flat',
		'SELECT posts.*, file.path AS fp FROM posts JOIN users AS author ON posts."authorId" = author.id JOIN files AS file ON author."fileId" = file.id',
	],
] as const;
const orm = createOrm({
	model: db.model,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});
it.each(cases)('tag plans %s with adapter capabilities', (text, sql) => {
	const query = orm.nql`${nqlRaw(text)}`;
	expect(query.dump().sql).toBe(sql);
	const dump = query.dump();
	expect('params' in dump && dump.params).toEqual([]);
	expect(query.plan().decisions).toEqual(
		'plan' in dump && dump.plan?.decisions,
	);
});

it('hydrates JSON strings from non-binding all()', async () => {
	const pool = {
		query: vi.fn().mockResolvedValue({
			rows: [
				{
					id: 1,
					name: 'Ada',
					fileId: null,
					posts_json: '[{"title":"First"},{"title":"Second"}]',
				},
				{ id: 2, name: 'Grace', fileId: null, posts_json: '[]' },
			],
		}),
	} as unknown as Pool;
	const executingOrm = createOrm({
		model: db.model,
		adapter: createPgAdapter(pool, { model: db.model }),
	});
	expect(await executingOrm.nql`users | select *, posts.title`.all()).toEqual([
		{
			id: 1,
			name: 'Ada',
			fileId: null,
			posts: [{ title: 'First' }, { title: 'Second' }],
		},
		{ id: 2, name: 'Grace', fileId: null, posts: [] },
	]);
});

it.each(cases)(
	'program-sequence dump plans %s with adapter capabilities',
	(text, sql) => {
		const query = orm.nql`insert into users set id = 3, name = 'New' | select id | bind created
${nqlRaw(text)}`;
		const dump = query.dump();
		expect('sequence' in dump && dump.sequence?.at(-1)?.sql).toBe(sql);
		expect('sequence' in dump && dump.sequence?.at(-1)?.params).toEqual([]);
		expect('plan' in dump && dump.plan?.decisions).toEqual(
			query.plan().decisions,
		);
	},
);

const nestedRead = 'users | select id, posts.title';
const programRead =
	"insert into users set id = 3, name = 'New' | select id | bind created\nusers | select id, posts.title";
const cteRead =
	'with enriched as (users | select id, posts.title)\nenriched | select *';

it.each([nestedRead, programRead])(
	'hydrates final read all() and first(): %s',
	async (text) => {
		const query = vi.fn(async (sql: string) => ({
			rows:
				sql.startsWith('SELECT') || sql.startsWith('WITH')
					? [{ id: 1, posts_json: '[{"title":"First"}]' }]
					: [{ id: 3 }],
		}));
		const client = { query, release: vi.fn() };
		const pool = {
			query,
			connect: vi.fn(async () => client),
		} as unknown as Pool;
		const executingOrm = createOrm({
			model: db.model,
			adapter: createPgAdapter(pool, { model: db.model }),
		});
		expect(await executingOrm.nql`${nqlRaw(text)}`.all()).toEqual([
			{ id: 1, posts: [{ title: 'First' }] },
		]);
		expect(await executingOrm.nql`${nqlRaw(text)}`.first()).toEqual({
			id: 1,
			posts: [{ title: 'First' }],
		});
	},
);

it('run discards program read rows without parsing JSON', async () => {
	const query = vi.fn(async (sql: string) => ({
		rows: sql.startsWith('SELECT')
			? [{ id: 1, posts_json: 'invalid JSON' }]
			: [{ id: 3 }],
	}));
	const client = { query, release: vi.fn() };
	const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
	const executingOrm = createOrm({
		model: db.model,
		adapter: createPgAdapter(pool, { model: db.model }),
	});
	await expect(
		executingOrm.nql`${nqlRaw(programRead)}`.run(),
	).resolves.toBeUndefined();
});

function hintedModel(strategy: 'join' | 'lateral' | 'json_agg' | 'cte') {
	const hints = {
		getRelation: (name: string) => {
			const relation = db.model.getRelation(name);
			return relation ? { ...relation, includeStrategy: strategy } : relation;
		},
		getRelationsFrom: (name: string) =>
			db.model
				.getRelationsFrom(name)
				?.map((relation) => ({ ...relation, includeStrategy: strategy })),
	};
	return new Proxy(db.model, {
		get(target, property) {
			if (property === 'getRelation') return hints.getRelation;
			if (property === 'getRelationsFrom') return hints.getRelationsFrom;
			const value = Reflect.get(target, property, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}
const operators = [
	'union',
	'union all',
	'intersect',
	'intersect all',
	'except',
	'except all',
];
const refusal =
	"Set operations with nested relation output are not supported; use | flat in every branch. A relation with includeStrategy hint 'json_agg' or 'cte' cannot be flattened; change that hint or select from the joined table.";
for (const strategy of ['join', 'lateral', 'json_agg', 'cte'] as const) {
	for (const flat of [false, true]) {
		if (strategy === 'cte' || (flat && strategy === 'json_agg')) continue;
		const read = `posts | select id, author.name${flat ? ' | flat' : ''}`;
		for (const text of [
			read,
			...(flat ? [`with enriched as (${read})\nenriched | select *`] : []),
			`posts | select id | bind source\n${read}`,
			...(flat ? [`${read} | bind source\nsource | select *`] : []),
			`insert into users set id = 3, name = 'New' | select id | bind created\n${read}`,
		]) {
			it(`hydrates requested shape ${strategy} flat=${flat}: ${text}`, async () => {
				const query = vi.fn(async (sql: string) => ({
					rows:
						sql.startsWith('SELECT') || sql.startsWith('WITH')
							? [
									strategy === 'json_agg'
										? { id: 10, author_json: '[{"name":"Ada"}]' }
										: {
												id: 10,
												'author.name': 'Ada',
												...(!flat ? { __dbsp_presence_author: 1 } : {}),
											},
								]
							: [{ id: 3 }],
				}));
				const pool = {
					query,
					connect: vi.fn(async () => ({ query, release: vi.fn() })),
				} as unknown as Pool;
				const model = hintedModel(strategy);
				const orm = createOrm({
					model,
					adapter: createPgAdapter(pool, { model }),
				});
				if (!flat && strategy !== 'json_agg')
					expect(orm.nql`${nqlRaw(text)}`.dump().sql).toContain(
						'AS __dbsp_presence_author',
					);
				const expected = flat
					? { id: 10, 'author.name': 'Ada' }
					: { id: 10, author: { name: 'Ada' } };
				expect(await orm.nql`${nqlRaw(text)}`.all()).toEqual([expected]);
				expect(await orm.nql`${nqlRaw(text)}`.first()).toEqual(expected);
			});
		}
	}
	for (const op of operators) {
		for (const text of [
			`posts | select id, author.name | ${op} (posts | select id, title)`,
			`posts | select id, title | ${op} (posts | select id, author.name)`,
			`posts | select id, title | ${op} (posts | select id, title | union (posts | select id, author.name))`,
		]) {
			it(`refuses nested ${strategy}: ${text}`, () => {
				const model = hintedModel(strategy);
				const orm = createOrm({
					model,
					adapter: createPgCompileOnlyAdapter({ model }),
				});
				expect(() => orm.nql`${nqlRaw(text)}`.dump()).toThrow(
					new Error(refusal),
				);
			});
		}
		if (strategy !== 'json_agg' && strategy !== 'cte')
			it(`allows flat ${strategy} ${op}`, () => {
				const model = hintedModel(strategy);
				const orm = createOrm({
					model,
					adapter: createPgCompileOnlyAdapter({ model }),
				});
				const dump =
					orm.nql`${nqlRaw(`posts | select id, author.name | flat | ${op} (posts | select id, author.name | flat)`)}`.dump();
				expect(dump.sql).toContain(op.toUpperCase());
				expect('params' in dump && dump.params).toEqual([]);
			});
	}
}

const bodyRefusal = refusal.replace('Set operations', 'Relational bodies');
for (const strategy of ['join', 'lateral', 'json_agg', 'cte'] as const) {
	it.each([
		cteRead,
		'with enriched as (posts | select id, author.name)\nenriched | select id, "author.name"',
		'posts | select id, author.name | bind enriched\nenriched | select *',
	])(`refuses relational body ${strategy}: %s`, (text) => {
		const model = hintedModel(strategy);
		const orm = createOrm({
			model,
			adapter: createPgCompileOnlyAdapter({ model }),
		});
		expect(() => orm.nql`${nqlRaw(text)}`.dump()).toThrow(
			strategy === 'join' && text === cteRead
				? new InvalidOperationError(
						'include',
						"Include include[0](posts) cannot use 'join' for a to-many relation. Use .join(), NQL | flat, or a json_agg/lateral include.",
					)
				: new Error(bodyRefusal),
		);
	});
}
it('refuses left branch before compiling the right subtree', () => {
	const adapter = createPgCompileOnlyAdapter({ model: db.model });
	const left = adapter.compile(orm.nql`posts | select id, author.name`.plan(), {
		model: db.model,
	});
	const compile = vi.fn(() => {
		if (compile.mock.calls.length > 1)
			throw new Error('right subtree compiled');
		return left;
	});
	expect(() =>
		compileSetOperation(
			{
				kind: 'setOperation',
				op: 'union',
				all: false,
				left: { type: 'select', from: 'posts' },
				right: { type: 'select', from: 'posts' },
			},
			compile,
		),
	).toThrow(new Error(refusal));
	expect(compile).toHaveBeenCalledTimes(1);
});
it.each([nestedRead, programRead])(
	'malformed JSON throws a named read error: %s',
	async (text) => {
		const query = vi.fn(async (sql: string) => ({
			rows: sql.startsWith('SELECT')
				? [{ id: 1, posts_json: 'invalid' }]
				: [{ id: 3 }],
		}));
		const pool = {
			query,
			connect: vi.fn(async () => ({ query, release: vi.fn() })),
		} as unknown as Pool;
		const orm = createOrm({
			model: db.model,
			adapter: createPgAdapter(pool, { model: db.model }),
		});
		await expect(orm.nql`${nqlRaw(text)}`.all()).rejects.toMatchObject({
			name: 'InvalidJsonAggPayloadError',
			message: "Invalid JSON in json_agg payload 'posts'.",
		});
		await expect(orm.nql`${nqlRaw(text)}`.first()).rejects.toMatchObject({
			name: 'InvalidJsonAggPayloadError',
		});
	},
);

it('skips hydration entirely when compiled read has no payload', async () => {
	const json = vi.spyOn(ResultHydrator.prototype, 'hydrateJsonAggIncludes');
	const join = vi.spyOn(ResultHydrator.prototype, 'hydrateJoinIncludes');
	try {
		const pool = {
			query: vi.fn(async () => ({ rows: [{ id: 1 }] })),
		} as unknown as Pool;
		const orm = createOrm({
			model: db.model,
			adapter: createPgAdapter(pool, { model: db.model }),
		});
		expect(await orm.nql`users | select id`.all()).toEqual([{ id: 1 }]);
		expect(json).not.toHaveBeenCalled();
		expect(join).not.toHaveBeenCalled();
	} finally {
		json.mockRestore();
		join.mockRestore();
	}
});

for (const relations of [
	['r'.repeat(62)],
	[`${'r'.repeat(63)}a`, `${'r'.repeat(63)}b`],
]) {
	const [first, second] = relations;
	const model = schema({
		roots: { id: { type: 'integer', primaryKey: true } },
		children: {
			id: { type: 'integer', primaryKey: true },
			rootId: ref('roots', { inverse: first! }),
		},
		...(second
			? {
					siblings: {
						id: { type: 'integer', primaryKey: true },
						rootId: ref('roots', { inverse: second }),
					},
				}
			: {}),
	}).model;
	const read = `roots | where id = 1 | select id, ${relations.map((r) => `${r}.id`).join(', ')}`;
	const expected = {
		id: 1,
		...Object.fromEntries(relations.map((r) => [r, [{ id: 2 }]])),
	};
	for (const program of [false, true]) {
		const text = `${program ? 'insert into roots set id = 3 | select id | bind created\n' : ''}${read}`;
		it(`terminal label all/first program=${program} relations=${relations.length}`, async () => {
			const adapter = createPgCompileOnlyAdapter({ model });
			const compileOrm = createOrm({ model, adapter });
			const compiled = adapter.compile(compileOrm.nql`${nqlRaw(read)}`.plan(), {
				model,
			});
			const shapes = compiled.hydrationPlan!.includePayloads!;
			expect(Buffer.byteLength(shapes[0]!.outputLabel)).toBe(63);
			if (second) expect(shapes[1]!.outputLabel).toBe(`${'r'.repeat(61)}_1`);
			const raw = Object.fromEntries(
				shapes.map((shape) => [shape.outputLabel, '[{"id":2}]']),
			);
			const query = vi.fn(async (sql: string) => ({
				rows: sql.startsWith('SELECT') ? [{ id: 1, ...raw }] : [{ id: 3 }],
			}));
			const pool = {
				query,
				connect: vi.fn(async () => ({ query, release: vi.fn() })),
			} as unknown as Pool;
			const orm = createOrm({
				model,
				adapter: createPgAdapter(pool, { model }),
			});
			expect(await orm.nql`${nqlRaw(text)}`.all()).toEqual([expected]);
			expect(await orm.nql`${nqlRaw(text)}`.first()).toEqual(expected);
		});
	}
	for (const body of [
		`with enriched as (${read})\nenriched | select *`,
		`${read} | bind enriched\nenriched | select *`,
	]) {
		it(`refuses long/collision body ${relations.length}: ${body}`, () => {
			const orm = createOrm({
				model,
				adapter: createPgCompileOnlyAdapter({ model }),
			});
			expect(() => orm.nql`${nqlRaw(body)}`.dump()).toThrow(
				new Error(bodyRefusal),
			);
		});
	}
}

it.each(['json_agg', 'cte'] as const)(
	'terminal flat refuses %s hint',
	(strategy) => {
		const model = new Proxy(db.model, {
			get(target, property) {
				if (property === 'getRelation')
					return (name: string) => {
						const r = target.getRelation(name);
						return r ? { ...r, includeStrategy: strategy } : r;
					};
				if (property === 'getRelationsFrom')
					return (name: string) =>
						target
							.getRelationsFrom(name)
							.map((r) => ({ ...r, includeStrategy: strategy }));
				const value = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const orm = createOrm({
			model,
			adapter: createPgCompileOnlyAdapter({ model }),
		});
		const message = `Flat output for relation 'author' cannot use relation includeStrategy hint '${strategy}'. Use 'auto', 'join', or 'lateral'.`;
		for (const prefix of [
			'',
			"insert into users set id = 3, name = 'New' | select id | bind created\n",
		]) {
			expect(() =>
				orm.nql`${nqlRaw(`${prefix}posts | select id, author.name | flat`)}`.dump(),
			).toThrow(message);
		}
	},
);

it('keeps fluent recursive CTE include root rows unchanged', async () => {
	const db = schema({
		categories: {
			id: { type: 'integer', primaryKey: true },
			parent_id: ref('categories', {
				roles: { parent: 'parent', children: 'children' },
				nullable: true,
			}),
		},
	});
	const roots = [
		{ id: 1, parent_id: null },
		{ id: 2, parent_id: null },
	];
	const query = vi.fn(async () => ({
		rows: roots.map((row) => ({ ...row, children_json: [] })),
	}));
	const orm = createOrm({
		schema: db,
		adapter: createPgAdapter({ query } as unknown as Pool, { model: db.model }),
	});
	const read = orm.select('categories').include('children', {
		recursive: true,
		direction: 'descendants',
		omitSelf: true,
	});
	expect(
		read
			.plan()
			.decisions.filter((d) => d.type === 'include-strategy')
			.map((d) => d.choice),
	).toEqual(['cte']);
	expect(read.dump().sql).toMatchSnapshot();
	expect(await read.execute()).toEqual(
		roots.map((row) => ({ ...row, children: [] })),
	);
	expect(query).toHaveBeenCalledTimes(1);
});
