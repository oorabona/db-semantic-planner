/**
 * ADR 0011 delivery 4: the values of `set()`, `values()`, `doUpdate()` and
 * `batchSet().set()` are value leaves. Expressions compile, `param()` binds
 * its content on both INSERT strategies, and a batch whose cells a column
 * array cannot carry takes VALUES.
 */
import {
	caseWhen,
	cast,
	createOrm,
	eq,
	exprRef,
	fn,
	isNull,
	literal,
	op,
	outerRef,
	param,
	ref,
	schema,
	sql,
	subquery,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const tables = {
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'text',
		deleted_at: { type: 'timestamp', nullable: true },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'text',
		score: 'integer',
		meta: { type: 'jsonb', nullable: true },
		created: { type: 'timestamp', nullable: true },
		data: { type: 'text', dbType: 'bytea', nullable: true },
		user_id: ref('users', { as: 'author' }),
	},
} as const;
const db = schema(tables);
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
	suppressDxWarnings: true,
});
const P = orm.tables.posts;
const UNNEST = { batchThreshold: 0 } as const;

const dumped = (d: { sql: string; parameters: readonly unknown[] }) => ({
	sql: d.sql,
	params: d.parameters,
});
// Expression values are not part of every row type; exercise the runtime contract.
const update = (score: unknown) =>
	dumped(
		orm
			.update('posts')
			.set({ score: score as never })
			.where(eq('id', 1))
			.dump(),
	);
const insert = (
	rows: Record<string, unknown> | Record<string, unknown>[],
	options?: { batchThreshold: number },
) =>
	dumped(
		orm
			.insert('posts')
			.values(rows as never)
			.dump(options),
	);
const CASE = () => caseWhen(eq('score', 1), literal(2)).else(literal(3));

describe('ADR 0011 delivery 4: mutation value leaves', () => {
	it('update set compiles expression values', () => {
		expect(update(op('+', exprRef('score'), 1))).toEqual({
			sql: 'UPDATE posts SET score = posts.score + 1 WHERE posts.id = $1',
			params: [1],
		});
		expect(update(literal(5))).toEqual({
			sql: 'UPDATE posts SET score = 5 WHERE posts.id = $1',
			params: [1],
		});
		expect(update(CASE())).toEqual({
			sql: 'UPDATE posts SET score = CASE WHEN posts.score = $1 THEN 2 ELSE 3 END WHERE posts.id = $2',
			params: [1, 1],
		});
		for (const subqueryValue of [
			subquery('users').count(),
			subquery('users').count().asExpr('n'),
		])
			expect(update(subqueryValue)).toEqual({
				sql: 'UPDATE posts SET score = (SELECT count(*) FROM users) WHERE posts.id = $1',
				params: [1],
			});
		expect(
			update(
				subquery('users')
					.where(eq('id', outerRef('user_id')))
					.count(),
			),
		).toEqual({
			sql: 'UPDATE posts SET score = (SELECT count(*) FROM users WHERE users.id = posts.user_id) WHERE posts.id = $1',
			params: [1],
		});
		expect(update(P.id)).toEqual({
			sql: 'UPDATE posts SET score = posts.id WHERE posts.id = $1',
			params: [1],
		});
		expect(update(op('+', param(2), literal(1)))).toEqual({
			sql: 'UPDATE posts SET score = $1 + 1 WHERE posts.id = $2',
			params: [2, 1],
		});
		expect(update(ref('posts.id'))).toEqual({
			sql: 'UPDATE posts SET score = posts.id WHERE posts.id = $1',
			params: [1],
		});
	});

	it('update set subqueries inherit no default filter', () => {
		const filtered = schema(tables, undefined, {
			defaultFilters: { users: isNull('deleted_at') },
		});
		const o = createOrm({
			schema: filtered,
			adapter: createPgCompileOnlyAdapter({ model: filtered.model }),
			suppressDxWarnings: true,
		});
		expect(
			dumped(
				o
					.update('posts')
					.set({ score: subquery('users').count() as never })
					.where(eq('id', 1))
					.dump(),
			),
		).toEqual({
			sql: 'UPDATE posts SET score = (SELECT count(*) FROM users) WHERE posts.id = $1',
			params: [1],
		});
	});

	it('direct adapter calls coerce ColumnRef and SubqueryExpression values', () => {
		const adapter = createPgCompileOnlyAdapter({ model: db.model });
		const where = {
			kind: 'comparison',
			field: 'id',
			operator: 'eq',
			value: 1,
		} as const;
		expect(
			dumped(
				adapter.compileUpdate(
					{ type: 'update', table: 'posts', set: { score: P.id }, where },
					{ model: db.model },
				),
			),
		).toEqual({
			sql: 'UPDATE posts SET score = posts.id WHERE posts.id = $1',
			params: [1],
		});
		expect(
			dumped(
				adapter.compileUpdate(
					{
						type: 'update',
						table: 'posts',
						set: { score: subquery('users').count() },
						where,
					},
					{ model: db.model },
				),
			),
		).toEqual({
			sql: 'UPDATE posts SET score = (SELECT count(*) FROM users) WHERE posts.id = $1',
			params: [1],
		});
	});

	it('doUpdate set compiles expression values', () => {
		const upsert = (score: unknown) =>
			dumped(
				orm
					.upsert('posts')
					.values({ id: 1, score: 2 })
					.onConflict(['id'])
					.doUpdate({ score: score as never })
					.dump(),
			);
		expect(upsert(op('+', exprRef('score'), 1))).toEqual({
			sql: 'INSERT INTO posts (id, score) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET score = posts.score + 1',
			params: [1, 2],
		});
		expect(upsert(CASE())).toEqual({
			sql: 'INSERT INTO posts (id, score) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET score = CASE WHEN posts.score = $3 THEN 2 ELSE 3 END',
			params: [1, 2, 1],
		});
		expect(
			dumped(
				orm
					.upsert('posts')
					.values([
						{ id: 1, score: 1 },
						{ id: 2, score: 2 },
					])
					.onConflict(['id'])
					.doUpdate({
						score: op('+', exprRef('score'), param(1)) as never,
					})
					.dump(UNNEST),
			),
		).toEqual({
			sql: 'INSERT INTO posts (id, score) SELECT unnest(CAST($1 AS int4[])) AS id, unnest(CAST($2 AS int4[])) AS score ON CONFLICT (id) DO UPDATE SET score = posts.score + $3',
			params: [[1, 2], [1, 2], 1],
		});
	});

	it('batchSet scalar set compiles expression values', () => {
		const batch = (score: unknown) =>
			orm
				.update('posts')
				.batchSet('id', [
					{ id: 1, title: 'a' },
					{ id: 2, title: 'b' },
				])
				.set({ score: score as never });
		expect(dumped(batch(op('+', exprRef('score'), 1)).dump())).toEqual({
			sql: 'UPDATE posts SET title = t.title,score = posts.score + 1 FROM unnest(CAST($1 AS int4[]), CAST($2 AS text[])) AS t(id, title) WHERE posts.id = t.id',
			params: [
				[1, 2],
				['a', 'b'],
			],
		});
		expect(dumped(batch(op('+', param(2), literal(1))).dump())).toEqual({
			sql: 'UPDATE posts SET title = t.title,score = $3 + 1 FROM unnest(CAST($1 AS int4[]), CAST($2 AS text[])) AS t(id, title) WHERE posts.id = t.id',
			params: [[1, 2], ['a', 'b'], 2],
		});
		expect(
			dumped(
				batch(op('+', param(9), literal(1)))
					.where(eq('score', 7))
					.dump(),
			),
		).toEqual({
			sql: 'UPDATE posts SET title = t.title,score = $4 + 1 FROM unnest(CAST($2 AS int4[]), CAST($3 AS text[])) AS t(id, title) WHERE posts.id = t.id AND posts.score = $1',
			params: [7, [1, 2], ['a', 'b'], 9],
		});
	});

	it('insert values compiles expression cells', () => {
		expect(
			insert([
				{ id: 1, score: op('+', literal(1), literal(2)) },
				{ id: 2, score: 5 },
			]),
		).toEqual({
			sql: 'INSERT INTO posts (id, score) VALUES ($1, 1 + 2), ($2, $3)',
			params: [1, 2, 5],
		});
		expect(insert({ id: 1, created: fn('now') })).toEqual({
			sql: 'INSERT INTO posts (id, created) VALUES ($1, now())',
			params: [1],
		});
		expect(insert({ id: 1, score: subquery('users').count() })).toEqual({
			sql: 'INSERT INTO posts (id, score) VALUES ($1, (SELECT count(*) FROM users))',
			params: [1],
		});
		expect(insert({ id: 1, score: cast(param('7'), 'int4') })).toEqual({
			sql: 'INSERT INTO posts (id, score) VALUES ($1, CAST($2 AS int4))',
			params: [1, '7'],
		});
		expect(insert({ id: 1, score: op('+', param(2), literal(1)) })).toEqual({
			sql: 'INSERT INTO posts (id, score) VALUES ($1, $2 + 1)',
			params: [1, 2],
		});
		expect(
			insert({
				id: 1,
				score: subquery('users')
					.where(
						eq(
							'id',
							subquery('posts')
								.where(eq('user_id', outerRef('users.id')))
								.max('user_id'),
						),
					)
					.count(),
			}),
		).toEqual({
			sql: 'INSERT INTO posts (id, score) VALUES ($1, (SELECT count(*) FROM users WHERE users.id = (SELECT max(posts_1.user_id) FROM posts AS posts_1 WHERE posts_1.user_id = users.id)))',
			params: [1],
		});
		expect(
			insert([{ id: 1, score: op('+', literal(1), literal(2)) }, { id: 2 }]),
		).toEqual({
			sql: 'INSERT INTO posts (id, score) VALUES ($1, 1 + 2), ($2, DEFAULT)',
			params: [1, 2],
		});
	});

	it('upsert values compiles expression cells', () => {
		expect(
			dumped(
				orm
					.upsert('posts')
					.values({ id: 1, score: op('+', literal(1), literal(2)) as never })
					.onConflict(['id'])
					.doUpdate({ title: 'u' })
					.dump(),
			),
		).toEqual({
			sql: 'INSERT INTO posts (id, score) VALUES ($1, 1 + 2) ON CONFLICT (id) DO UPDATE SET title = $2',
			params: [1, 'u'],
		});
	});

	it('unnest-eligible batches take VALUES for uncarried cells', () => {
		expect(
			insert(
				[
					{ id: 1, score: 1 },
					{ id: 2, score: fn('abs', literal(-1)) },
				],
				UNNEST,
			),
		).toEqual({
			sql: 'INSERT INTO posts (id, score) VALUES ($1, $2), ($3, abs(-1))',
			params: [1, 1, 2],
		});
		expect(
			insert(
				[
					{ id: 1, created: sql('now()') },
					{ id: 2, created: sql('now()') },
				],
				UNNEST,
			),
		).toEqual({
			sql: 'INSERT INTO posts (id, created) VALUES ($1, now()), ($2, now())',
			params: [1, 2],
		});
		expect(
			insert(
				[
					{ id: 1, meta: [1, 2] },
					{ id: 2, meta: [3] },
				],
				UNNEST,
			),
		).toEqual({
			sql: 'INSERT INTO posts (id, meta) VALUES ($1, $2), ($3, $4)',
			params: [1, [1, 2], 2, [3]],
		});
		expect(
			insert(
				[
					{ id: 1, meta: param([1]) },
					{ id: 2, meta: param([2]) },
				],
				UNNEST,
			),
		).toEqual({
			sql: 'INSERT INTO posts (id, meta) VALUES ($1, $2), ($3, $4)',
			params: [1, [1], 2, [2]],
		});
		expect(
			dumped(
				orm
					.upsert('posts')
					.values([
						{ id: 1, score: literal(5) as never },
						{ id: 2, score: 6 },
					])
					.onConflict(['id'])
					.doUpdate({ title: 'u' })
					.dump(UNNEST),
			),
		).toEqual({
			sql: 'INSERT INTO posts (id, score) VALUES ($1, 5), ($2, $3) ON CONFLICT (id) DO UPDATE SET title = $4',
			params: [1, 2, 6, 'u'],
		});
		const ab = Buffer.from('ab');
		const c = new Uint8Array([99]);
		expect(
			insert(
				[
					{ id: 1, data: ab },
					{ id: 2, data: c },
				],
				UNNEST,
			),
		).toEqual({
			sql: 'INSERT INTO posts (id, data) SELECT unnest(CAST($1 AS int4[])) AS id, unnest(CAST($2 AS bytea[])) AS data',
			params: [
				[1, 2],
				[ab, c],
			],
		});
		expect(
			insert(
				[
					{ id: 1, score: 1 },
					{ id: 2, score: subquery('users').count().asExpr('n') },
				],
				UNNEST,
			),
		).toEqual({
			sql: 'INSERT INTO posts (id, score) VALUES ($1, $2), ($3, (SELECT count(*) FROM users))',
			params: [1, 1, 2],
		});
		const bare = Object.assign(Object.create(null), { a: 1 });
		expect(
			insert(
				[
					{ id: 1, meta: bare },
					{ id: 2, meta: bare },
				],
				UNNEST,
			),
		).toEqual({
			sql: 'INSERT INTO posts (id, meta) SELECT unnest(CAST($1 AS int4[])) AS id, unnest(CAST($2 AS jsonb[])) AS meta',
			params: [
				[1, 2],
				[bare, bare],
			],
		});
		class Doc {
			a = 1;
		}
		const doc = new Doc();
		const instance = insert(
			[
				{ id: 1, meta: doc },
				{ id: 2, meta: doc },
			],
			UNNEST,
		);
		expect(instance.sql).toBe(
			'INSERT INTO posts (id, meta) VALUES ($1, $2), ($3, $4)',
		);
		expect(instance.params[1]).toBe(doc);
		expect(instance.params[3]).toBe(doc);
		for (const custom of [
			{ toPostgres: () => null },
			{ toJSON: () => undefined },
		]) {
			const converted = insert(
				[
					{ id: 1, meta: custom },
					{ id: 2, meta: custom },
				],
				UNNEST,
			);
			expect(converted.sql).toBe(
				'INSERT INTO posts (id, meta) VALUES ($1, $2), ($3, $4)',
			);
			expect(converted.params).toEqual([1, custom, 2, custom]);
		}
		let getterCalls = 0;
		const accessor = Object.defineProperty({}, 'toJSON', {
			enumerable: false,
			get() {
				getterCalls++;
				return () => undefined;
			},
		});
		const viaAccessor = insert(
			[
				{ id: 1, meta: accessor },
				{ id: 2, meta: accessor },
			],
			UNNEST,
		);
		expect(viaAccessor.sql).toBe(
			'INSERT INTO posts (id, meta) VALUES ($1, $2), ($3, $4)',
		);
		expect(viaAccessor.params[1]).toBe(accessor);
		expect(viaAccessor.params[3]).toBe(accessor);
		expect(getterCalls).toBe(0);
		expect(
			insert(
				[
					{ id: 1, score: 1 },
					{ id: 2, score: 2 },
				],
				UNNEST,
			),
		).toEqual({
			sql: 'INSERT INTO posts (id, score) SELECT unnest(CAST($1 AS int4[])) AS id, unnest(CAST($2 AS int4[])) AS score',
			params: [
				[1, 2],
				[1, 2],
			],
		});
	});

	it('unnest casts keep the physical type of timestamp, json, number and float(1..24) columns', () => {
		const typed = schema({
			c: {
				id: { type: 'integer', primaryKey: true },
				ts: { type: 'timestamp', dbType: 'timestamp', nullable: true },
				j: { type: 'json', dbType: 'json', nullable: true },
				lts: { type: 'timestamp', nullable: true },
				lj: { type: 'json', nullable: true },
				n: { type: 'number', nullable: true },
				f: { type: 'decimal', dbType: 'float(24)', nullable: true },
				d: { type: 'decimal', dbType: 'float(25)', nullable: true },
			},
		});
		const o = createOrm({
			schema: typed,
			adapter: createPgCompileOnlyAdapter({ model: typed.model }),
			suppressDxWarnings: true,
		});
		const row = {
			ts: null,
			j: null,
			lts: null,
			lj: null,
			n: null,
			f: null,
			d: null,
		};
		expect(
			o
				.insert('c')
				.values([
					{ id: 1, ...row },
					{ id: 2, ...row },
				])
				.dump(UNNEST).sql,
		).toBe(
			'INSERT INTO c (id, ts, j, lts, lj, n, f, d) SELECT unnest(CAST($1 AS int4[])) AS id, unnest(CAST($2 AS timestamp[])) AS ts, unnest(CAST($3 AS json[])) AS j, unnest(CAST($4 AS timestamptz[])) AS lts, unnest(CAST($5 AS jsonb[])) AS lj, unnest(CAST($6 AS int4[])) AS n, unnest(CAST($7 AS float4[])) AS f, unnest(CAST($8 AS float8[])) AS d',
		);
	});

	it('param cells bind their value in unnest arrays', () => {
		const head =
			'INSERT INTO posts (id, score) SELECT unnest(CAST($1 AS int4[])) AS id, unnest(CAST($2 AS int4[])) AS score';
		expect(
			insert(
				[
					{ id: 1, score: param(5) },
					{ id: 2, score: param(5) },
				],
				UNNEST,
			),
		).toEqual({
			sql: head,
			params: [
				[1, 2],
				[5, 5],
			],
		});
		expect(
			insert(
				[
					{ id: 1, score: param(null) },
					{ id: 2, score: param(undefined) },
				],
				UNNEST,
			),
		).toEqual({
			sql: head,
			params: [
				[1, 2],
				[null, null],
			],
		});
		expect(
			dumped(
				orm
					.upsert('posts')
					.values([
						{ id: 1, score: param(5) as never },
						{ id: 2, score: param(5) as never },
					])
					.onConflict(['id'])
					.doUpdate({ title: 'u' })
					.dump(UNNEST),
			),
		).toEqual({
			sql: `${head} ON CONFLICT (id) DO UPDATE SET title = $3`,
			params: [[1, 2], [5, 5], 'u'],
		});
	});

	it('sql markers compile in insert and upsert values', () => {
		expect(insert({ id: 1, created: sql('now()') })).toEqual({
			sql: 'INSERT INTO posts (id, created) VALUES ($1, now())',
			params: [1],
		});
		expect(
			dumped(
				orm
					.upsert('posts')
					.values({ id: 1, created: sql('now()') })
					.onConflict(['id'])
					.doUpdate({ title: 'u' })
					.dump(),
			),
		).toEqual({
			sql: 'INSERT INTO posts (id, created) VALUES ($1, now()) ON CONFLICT (id) DO UPDATE SET title = $2',
			params: [1, 'u'],
		});
	});

	it('plain objects with a kind key stay bound values', () => {
		for (const document of [
			{ kind: 'article', title: 'x' },
			{ kind: 'ref', column: 'id' },
		]) {
			expect(
				dumped(
					orm.update('posts').set({ meta: document }).where(eq('id', 1)).dump(),
				),
			).toEqual({
				sql: 'UPDATE posts SET meta = $1 WHERE posts.id = $2',
				params: [document, 1],
			});
			expect(insert({ id: 1, meta: document })).toEqual({
				sql: 'INSERT INTO posts (id, meta) VALUES ($1, $2)',
				params: [1, document],
			});
		}
		const paramShaped = [
			{ id: 1, meta: { kind: 'param', value: 5 } },
			{ id: 2, meta: { kind: 'param', value: 6 } },
		];
		for (const options of [undefined, UNNEST])
			expect(insert(paramShaped, options)).toEqual({
				sql: 'INSERT INTO posts (id, meta) VALUES ($1, $2), ($3, $4)',
				params: [1, 5, 2, 6],
			});
		const x = { kind: 'literal', value: 'x' };
		const y = { kind: 'literal', value: 'y' };
		expect(
			insert(
				[
					{ id: 1, meta: x },
					{ id: 2, meta: y },
				],
				UNNEST,
			),
		).toEqual({
			sql: 'INSERT INTO posts (id, meta) SELECT unnest(CAST($1 AS int4[])) AS id, unnest(CAST($2 AS jsonb[])) AS meta',
			params: [
				[1, 2],
				[x, y],
			],
		});
	});

	it('an NQL insert above the threshold takes VALUES with unwrapped cells', () => {
		const strings = ['insert into posts values '];
		const args: number[] = [];
		const expected: number[] = [];
		for (let i = 0; i < 51; i++) {
			strings[strings.length - 1] += `${i ? ', ' : ''}(id = `;
			args.push(i + 1);
			strings.push(', score = ');
			args.push(7);
			strings.push(')');
			expected.push(i + 1, 7);
		}
		const template = Object.assign([...strings], { raw: [...strings] });
		const d = orm.nql(template as TemplateStringsArray, ...args).dump() as {
			sql: string;
			parameters: readonly unknown[];
		};
		expect(d.sql).toBe(
			`INSERT INTO posts (id, score) VALUES ${Array.from({ length: 51 }, (_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(', ')}`,
		);
		expect(d.parameters).toEqual(expected);
	});
});
