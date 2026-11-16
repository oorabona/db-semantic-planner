import {
	and,
	createOrm,
	eq,
	exists,
	fn,
	inSubquery,
	isNull,
	like,
	none,
	not,
	notExists,
	or,
	outerRef,
	rangeOverlaps,
	rawExists,
	ref,
	schema,
	some,
	star,
	subquery,
} from '@dbsp/core';
import type { WhereIntent } from '@dbsp/types';
import { deparseSync } from 'pgsql-deparser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as conditions from '../condition-compiler.js';
import type { ConditionCompilerCtx } from '../condition-context.js';
import { createWhereDispatcher } from '../handlers/index.js';
import {
	type CompilerContext,
	createCompilerState,
	type Decision,
} from '../handlers/types.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import * as resolvedConditions from '../resolved-condition-compiler.js';

const db = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		score: { type: 'integer' },
		period: { type: 'daterange' },
	},
	profiles: {
		id: { type: 'integer', primaryKey: true },
		userId: ref('users', { inverse: 'profiles' }),
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		score: { type: 'integer' },
		period: { type: 'daterange' },
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
		parentId: ref('posts', {
			roles: { parent: 'parent', children: 'children' },
		}),
	},
} as const);
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({
		model: db.model,
		defaultPkColumnName: 'custom_pk',
		deriveFkColumnName: (table, pk) => `z_${table}_${pk}`,
	}),
});
const ctx = (): ConditionCompilerCtx => ({
	logicalSourceTable: 'users',
	emittedAlias: 'users',
	visibleAliases: new Map(),
	position: 'where',
	model: db.model,
	paramState: createCompilerState(),
	compileSubquery: () => {
		throw new Error('unexpected subquery');
	},
});
afterEach(() => vi.restoreAllMocks());
const shapes = [
	(c: WhereIntent) => c,
	(c: WhereIntent) => and(c, eq('score', 2)),
	(c: WhereIntent) => or(c, eq('score', 2)),
	(c: WhereIntent) => not(c),
	(c: WhereIntent) => and(eq('score', 1), or(not(c), eq('score', 2))),
];
for (const [index, wrap] of shapes.entries()) {
	it(`root shape ${index} enters compileCondition with root authorities and leaves dump().plan intact`, () => {
		const spy = vi.spyOn(resolvedConditions, 'compileResolvedCondition');
		const predicate = wrap(
			rangeOverlaps('period', { lower: '2026-01-01', upper: '2026-02-01' }),
		);
		const query = orm.select('users').where(predicate);
		const planned = query.plan();
		const result = query.dump();
		expect(result.plan).toEqual({
			...planned,
			metadata: {
				...planned.metadata,
				planningTimeMs: result.plan?.metadata.planningTimeMs,
			},
		});
		expect(spy).toHaveBeenCalledWith(
			planned.execution?.where,
			expect.objectContaining({
				rootTable: 'users',
				currentAlias: 'users',
				model: db.model,
				defaultPkColumnName: 'custom_pk',
			}),
			expect.any(Object),
		);
		expect(result.sql).toContain('CAST(');
		expect(result.sql).toContain('AS daterange)');
	});
}
it('declared relation keys precede custom authorities and nested relations share aliases and parameters', () => {
	const result = orm
		.select('users')
		.columns([fn('count', star()).filter(eq('score', 4)).as('n')])
		.where(
			and(
				eq('score', 1),
				exists('posts', {
					where: and(
						eq('score', 2),
						exists('children', { where: eq('score', 3) }),
					),
				}),
			),
		)
		.dump();
	expect(result.params).toEqual([4, 1, 2, 3]);
	expect(result.sql).toContain('users.id = posts_exists_0."authorId"');
	expect(result.sql).toContain('posts_exists_0.id = posts_exists_1."parentId"');
});
it('hand-built relations declare their intended keys', () => {
	const context = ctx();
	const model = {
		...db.model,
		getTable: () => undefined,
		getRelation: (name: string) => {
			const relation = db.model.getRelation(name);
			return (
				relation && {
					...relation,
					foreignKey: 'z_users_custom_pk',
					sourceKey: 'custom_pk',
					targetKey: undefined,
				}
			);
		},
	};
	const node = conditions.compileCondition(
		exists('posts', { where: eq('score', 7) }),
		{
			...context,
			model,
			defaultPkColumnName: 'custom_pk',
			deriveFkColumnName: (table, pk) => `z_${table}_${pk}`,
		},
	);
	expect(deparseSync(node).replace(/\s+/g, ' ')).toContain(
		'users.custom_pk = posts_exists_0.z_users_custom_pk',
	);
	expect(context.paramState.parameters).toEqual([7]);
});
it('every empty and validates the relation then yields true', () => {
	const predicate: WhereIntent = {
		kind: 'relationFilter',
		mode: 'every',
		relation: 'posts',
		where: and(),
	};
	expect(orm.select('users').where(predicate).dump().sql).toBe(
		'SELECT users.* FROM users WHERE true',
	);
	expect(() =>
		orm
			.select('users')
			.where({ ...predicate, relation: 'typo' })
			.dump(),
	).toThrow(/no relation/);
});
it('refuses undeclared root relations', () => {
	expect(() => conditions.compileCondition(exists('typo'), ctx())).toThrow(
		/no relation 'typo'/,
	);
});
it('refuses forged root relation target and key hints', () => {
	for (const hint of [
		{ targetTable: 'evil' },
		{ sourceColumn: 'evil' },
		{ targetColumn: 'evil' },
	]) {
		expect(() =>
			conditions.compileCondition(
				{ ...exists('posts'), ...hint } as WhereIntent,
				ctx(),
			),
		).toThrow(/supplied relation target or keys differ/);
	}
});
for (const predicate of [exists, notExists]) {
	it(`refuses root ${predicate.name} recursive options`, () => {
		expect(() =>
			orm
				.select('users')
				.where(
					and(
						eq('score', 1),
						predicate('posts', {
							recursive: {
								maxDepth: 5,
								direction: 'down',
								through: 'children',
							},
						}),
					),
				)
				.dump(),
		).toThrow(/recursive relation predicates are not supported inside WHERE/);
	});
}
it('refuses recursive root relationFilter options', () => {
	expect(() =>
		conditions.compileCondition(
			{
				kind: 'relationFilter',
				mode: 'some',
				relation: 'posts',
				recursive: { maxDepth: 5 },
			} as unknown as WhereIntent,
			ctx(),
		),
	).toThrow(/recursive relation predicates/);
});
it('refuses an unknown root predicate kind by name', () => {
	expect(() =>
		conditions.compileCondition(
			{ kind: 'unknownRoot' } as unknown as WhereIntent,
			ctx(),
		),
	).toThrow("Unsupported root WHERE predicate kind 'unknownRoot'");
});
it('refuses raw EXISTS modifiers before they can be discarded', () => {
	expect(() =>
		orm
			.select('users')
			.where({
				kind: 'rawExists',
				subquery: {
					type: 'select',
					from: 'posts',
					select: { type: 'fields', fields: ['id'] },
					groupBy: ['id'],
				},
			} as WhereIntent)
			.dump(),
	).toThrow(/GROUP BY/);
});
it('validates raw entries and lets declared relation keys win over a decision’s columns', () => {
	const predicate = {
		...exists('posts'),
		targetTable: 'evil',
		sourceColumn: 'score',
		targetColumn: 'score',
	};
	expect(() => conditions.compileCondition(predicate, ctx())).toThrow(
		/supplied relation target or keys differ/,
	);
	const state = createCompilerState();
	const node = createWhereDispatcher(conditions.compileWhereIntent)(
		{
			type: 'exists',
			operator: 'exists',
			relation: 'posts',
			targetTable: 'posts',
			sourceColumn: 'score',
			targetColumn: 'score',
		} as Decision,
		{
			rootTable: 'users',
			position: 'where',
			directRootWhere: true,
			model: db.model,
			dbCasing: 'preserve',
			maxRecursiveDepth: 100,
		} as CompilerContext,
		state,
	);
	expect(deparseSync(node).replace(/\s+/g, ' ')).toContain(
		'users.id = posts_exists_0."authorId"',
	);
});
it('dotted fields retain legacy lowering and scalar and ANY bodies keep canonical range casts', () => {
	const spy = vi.spyOn(resolvedConditions, 'compileResolvedCondition');
	createOrm({
		schema: db,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	})
		.select('users')
		.where(eq('posts.score', 2))
		.dump();
	expect(spy).toHaveBeenCalledWith(
		expect.objectContaining({ kind: 'relation' }),
		expect.any(Object),
		expect.any(Object),
	);
	const scalar: WhereIntent = {
		kind: 'subquery',
		field: 'score',
		operator: 'eq',
		subquery: {
			type: 'select',
			from: 'posts',
			select: { type: 'fields', fields: ['score'] },
			where: and(
				rangeOverlaps('period', { lower: '2026-01-01', upper: '2026-02-01' }),
				eq('score', 2),
			),
		},
	};
	expect(orm.select('users').where(scalar).dump().sql).toContain(
		'CAST($1 AS daterange)',
	);
	const any = orm
		.select('users')
		.where(
			inSubquery(
				'score',
				subquery('posts').select('score').where(scalar.subquery.where!),
			),
		)
		.dump();
	expect(any.sql).toContain('= ANY (SELECT');
	expect(any.sql).toContain('CAST($1 AS daterange)');
});
it('root context sees manual JOIN aliases allocated before predicate compilation', () => {
	const spy = vi.spyOn(resolvedConditions, 'compileResolvedCondition');
	const predicate = eq('score', 9);
	orm
		.select('users')
		.join('posts', { as: 'p', on: eq('id', 1) })
		.where(predicate)
		.dump();
	const call = spy.mock.calls.find(([tree]) => tree.kind === 'comparison');
	expect(call?.[1].scope?.bindings.has('p')).toBe(true);
});
it('binds expression-valued scalar subqueries at the root (#891 step 4c decision)', () => {
	const result = orm
		.select('users')
		.where({
			kind: 'expression',
			expr: subquery('posts').select('score').asExpr('s').intent,
			operator: 'gt',
			value: 0,
		})
		.dump();
	expect(result.sql).toBe(
		'SELECT users.* FROM users WHERE (SELECT posts.score FROM posts AS posts) > $1',
	);
	expect(result.params).toEqual([0]);
});
it('refuses a root relation without model authority', () => {
	const { model, ...context } = ctx();
	expect(model).toBe(db.model);
	expect(() => conditions.compileCondition(exists('posts'), context)).toThrow(
		/cannot resolve relation 'posts'.*no model/,
	);
});
it('positive root relation leaves use EXISTS like boolean predicates', () => {
	const positive = orm
		.select('posts')
		.where(exists('author', { where: eq('score', 3) }))
		.dump();
	expect(positive.sql).toBe(
		'SELECT posts.* FROM posts WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts."authorId" = users_exists_0.id AND users_exists_0.score = $1)',
	);
	expect(orm.select('posts').where(exists('author')).dump().sql).toContain(
		'WHERE EXISTS',
	);
	for (const predicate of [
		notExists('author'),
		not(exists('author')),
		or(exists('author'), eq('score', 3)),
	]) {
		const result = orm.select('posts').where(predicate).dump();
		expect(result.sql).not.toContain('JOIN users');
		expect(result.sql).toContain('EXISTS');
	}
});

const reuseOrm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});
it('4a item 1 preserves the outer row during relationFilter EXISTS', () => {
	const result = reuseOrm
		.select('posts')
		.where({
			kind: 'relationFilter',
			relation: 'author',
			mode: 'some',
			where: eq('id', outerRef('id')),
		})
		.dump();
	expect(result.sql).toBe(
		'SELECT posts.* FROM posts WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts."authorId" = users_exists_0.id AND users_exists_0.id = posts.id)',
	);
	expect(result.params).toEqual([]);
});
it('4a item 2 requires a predicate join rather than a matching visible alias', () => {
	for (const query of [
		reuseOrm.select('posts').include('author', { join: 'left' }),
		reuseOrm.select('posts').include('author', { join: 'inner' }),
		reuseOrm.select('posts').join('users', { as: 'author', on: eq('id', 1) }),
	]) {
		const result = query.where(exists('author')).dump();
		expect(result.sql).toMatch(
			/WHERE EXISTS \(SELECT 1 FROM users AS users_exists_\d+ WHERE posts\."authorId" = users_exists_\d+\.id\)/,
		);
	}
});
it('4a item 3 retains nested includes in EXISTS', () => {
	const result = reuseOrm
		.select('posts')
		.where(exists('author', { include: { profiles: { join: 'inner' } } }))
		.dump();
	expect(result.sql).toContain('WHERE EXISTS');
	expect(result.sql).toContain('JOIN profiles');
	expect(result.params).toEqual([]);
});
it('4a item 4 refuses recursive relations before dotted sibling routing', () => {
	for (const kind of ['exists', 'notExists', 'relationFilter'] as const) {
		for (const field of ['posts.score', 'score']) {
			const condition = {
				kind,
				relation: 'posts',
				mode: 'some',
				recursive: { direction: 'down', through: 'posts', maxDepth: 3 },
			} as WhereIntent;
			expect(() =>
				reuseOrm
					.select('users')
					.where(and(condition, eq(field, 2)))
					.dump(),
			).toThrow(
				`WHERE ${kind}('posts'): recursive relation predicates are not supported inside WHERE.`,
			);
		}
	}
});

describe('mutation WHERE resolves through the root resolver (#891)', () => {
	const mutationDb = schema({
		users: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			score: 'integer',
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			author_id: ref('users', { as: 'author', inverse: 'posts' }),
			parent_id: ref('posts', {
				roles: { parent: 'parent', children: 'children' },
			}),
		},
	} as const);
	const mutationAdapter = createPgCompileOnlyAdapter({
		model: mutationDb.model,
	});
	const mutationOrm = createOrm({
		schema: mutationDb,
		adapter: mutationAdapter,
		suppressDxWarnings: true,
	});
	const { users } = mutationOrm.tables;
	const update = (c: WhereIntent) =>
		mutationOrm.update('users').set({ name: 'n' }).where(c).dump();
	const remove = (c: WhereIntent) =>
		mutationOrm.delete('users').where(c).dump();
	const guard = (c: WhereIntent) =>
		mutationOrm
			.upsertInto(users)
			.values({ id: 1, name: 'a', score: 0 })
			.onConflict(['id'])
			.doUpdate({ name: 'b' }, c)
			.dump();
	const titled = () =>
		exists('posts', { where: eq('title', 'x') }) as WhereIntent;
	const relationExists = (n: number) =>
		`EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND posts_exists_0.title = $${n})`;

	it('AC1 some() compiles in UPDATE and DELETE', () => {
		const c = () => some(users.posts, () => eq('title', 'x'));
		expect(update(c())).toMatchObject({
			sql: `UPDATE users SET name = $1 WHERE ${relationExists(2)}`,
			parameters: ['n', 'x'],
		});
		expect(remove(c())).toMatchObject({
			sql: `DELETE FROM users WHERE ${relationExists(1)}`,
			parameters: ['x'],
		});
	});

	it('AC2 none() compiles in UPDATE and DELETE', () => {
		const c = () => none(users.posts, () => eq('title', 'x'));
		expect(update(c())).toMatchObject({
			sql: `UPDATE users SET name = $1 WHERE NOT (${relationExists(2)})`,
			parameters: ['n', 'x'],
		});
		expect(remove(c())).toMatchObject({
			sql: `DELETE FROM users WHERE NOT (${relationExists(1)})`,
			parameters: ['x'],
		});
	});

	it('AC3 rawExists() compiles in UPDATE and DELETE', () => {
		const c = () =>
			rawExists(subquery('posts').select('id').where(eq('title', 'x')));
		expect(update(c())).toMatchObject({
			sql: 'UPDATE users SET name = $1 WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.title = $2)',
			parameters: ['n', 'x'],
		});
		expect(remove(c())).toMatchObject({
			sql: 'DELETE FROM users WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.title = $1)',
			parameters: ['x'],
		});
	});

	it('AC4 a dotted relation path compiles to the relation EXISTS in UPDATE, DELETE and the upsert guard', () => {
		const c = () => eq('posts.title', 'x');
		expect(update(c())).toMatchObject({
			sql: `UPDATE users SET name = $1 WHERE ${relationExists(2)}`,
			parameters: ['n', 'x'],
		});
		expect(remove(c())).toMatchObject({
			sql: `DELETE FROM users WHERE ${relationExists(1)}`,
			parameters: ['x'],
		});
		expect(guard(c())).toMatchObject({
			sql: `INSERT INTO users (id, name, score) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = $4 WHERE ${relationExists(5)}`,
			parameters: [1, 'a', 0, 'b', 'x'],
		});
	});

	it('AC5 eq, exists and inSubquery keep their SQL in every mutation position', () => {
		const head =
			'INSERT INTO users (id, name, score) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = $4 WHERE';
		const any = (n: string) =>
			`users.id = ANY (SELECT posts_subq_0.author_id FROM posts AS posts_subq_0)${n}`;
		const insub = () => inSubquery('id', subquery('posts').select('author_id'));
		const rows = [
			[
				update(eq('score', 1)),
				'UPDATE users SET name = $1 WHERE users.score = $2',
				['n', 1],
			],
			[remove(eq('score', 1)), 'DELETE FROM users WHERE users.score = $1', [1]],
			[guard(eq('score', 1)), `${head} users.score = $5`, [1, 'a', 0, 'b', 1]],
			[
				update(titled()),
				`UPDATE users SET name = $1 WHERE ${relationExists(2)}`,
				['n', 'x'],
			],
			[remove(titled()), `DELETE FROM users WHERE ${relationExists(1)}`, ['x']],
			[guard(titled()), `${head} ${relationExists(5)}`, [1, 'a', 0, 'b', 'x']],
			[update(insub()), `UPDATE users SET name = $1 WHERE ${any('')}`, ['n']],
			[remove(insub()), `DELETE FROM users WHERE ${any('')}`, []],
			[guard(insub()), `${head} ${any('')}`, [1, 'a', 0, 'b']],
		] as const;
		for (const [result, sql, parameters] of rows) {
			expect(result.sql).toBe(sql);
			expect(result.parameters).toEqual(parameters);
		}
	});

	it('AC9 LIKE keeps its ESCAPE clause in UPDATE', () => {
		expect(update(like('name', 'c!_%', { escape: '!' }))).toMatchObject({
			sql: 'UPDATE users SET name = $1 WHERE users.name LIKE $2 ESCAPE $3',
			parameters: ['n', 'c!_%', '!'],
		});
	});

	it('AC10 refuses a recursive relation predicate in every mutation position', () => {
		const c = () =>
			exists('posts', {
				recursive: { maxDepth: 5, direction: 'down', through: 'children' },
			});
		for (const compile of [update, remove, guard]) {
			expect(() => compile(c())).toThrow(
				"WHERE exists('posts'): recursive relation predicates are not supported inside WHERE.",
			);
		}
	});

	it('R1 refuses an undeclared relation with the root resolver message', () => {
		for (const compile of [update, remove]) {
			expect(() => compile(exists('nope'))).toThrow(
				"exists('nope'): no relation 'nope' is declared on table 'users'. Use rawExists(subquery(...)) for an EXISTS over an undeclared or uncorrelated subquery.",
			);
		}
	});

	it('C2 without a model, the old route keeps its outcome per position', () => {
		const noModel = createPgCompileOnlyAdapter();
		const quantifier = some(users.posts, () => eq('title', 'x'));
		const raw = rawExists(
			subquery('posts').select('id').where(eq('title', 'x')),
		);
		for (const where of [quantifier, raw]) {
			expect(() =>
				noModel.compileUpdate({
					type: 'update',
					table: 'users',
					set: { name: 'n' },
					where,
				}),
			).toThrow('No WHERE handler registered for operator: undefined');
			expect(() =>
				noModel.compileDelete({ type: 'delete', table: 'users', where }),
			).toThrow('No WHERE handler registered for operator: undefined');
		}
		const spy = vi.spyOn(mutationAdapter, 'compileUpsert');
		guard(raw);
		const intent = spy.mock.calls[0]?.[0];
		expect(intent).toBeDefined();
		expect(noModel.compileUpsert(intent!)).toMatchObject({
			sql: 'INSERT INTO users (id, name, score) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = $4 WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.title = $5)',
			parameters: [1, 'a', 0, 'b', 'x'],
		});
	});

	describe('a snake_case target and nested read policies', () => {
		const policyDb = schema(
			{
				userProfiles: {
					id: { type: 'integer', primaryKey: true },
					displayName: 'text',
				},
				posts: {
					id: { type: 'integer', primaryKey: true },
					title: 'text',
					deleted_at: { type: 'timestamp', nullable: true },
					authorId: ref('userProfiles', { as: 'author', inverse: 'posts' }),
				},
			} as const,
			undefined,
			{ defaultFilters: { posts: isNull('deleted_at') } },
		);
		const snake = createOrm({
			schema: policyDb,
			adapter: createPgCompileOnlyAdapter({
				model: policyDb.model,
				dbCasing: 'snake_case',
			}),
			suppressDxWarnings: true,
		});
		const filtered = createOrm({
			schema: policyDb,
			adapter: createPgCompileOnlyAdapter({ model: policyDb.model }),
			suppressDxWarnings: true,
		});
		const outer = filtered.withoutDefaultFilters();
		// rawExists() accepts an ORM builder at runtime; its public type does not
		// list QueryBuilder yet (#994), hence the cast.
		const issued = (builder: unknown) =>
			builder as Parameters<typeof rawExists>[0];
		const snakeGuard = (c: WhereIntent) =>
			snake
				.upsertInto(snake.tables.userProfiles)
				.values({ id: 1, displayName: 'a' })
				.onConflict(['id'])
				.doUpdate({ displayName: 'b' }, c)
				.dump().sql;
		const snakeHead =
			'INSERT INTO user_profiles (id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET display_name = $3 WHERE';

		it('AC11 UPDATE and DELETE keep the physical target name', () => {
			expect(
				snake
					.update('userProfiles')
					.set({ displayName: 'n' })
					.where(eq('id', 1))
					.dump().sql,
			).toBe(
				'UPDATE user_profiles SET display_name = $1 WHERE user_profiles.id = $2',
			);
			expect(snake.delete('userProfiles').where(eq('id', 1)).dump().sql).toBe(
				'DELETE FROM user_profiles WHERE user_profiles.id = $1',
			);
		});

		it('AC11 the upsert guard qualifies by the physical target name', () => {
			expect(snakeGuard(eq('id', 1))).toBe(
				`${snakeHead} user_profiles.id = $4`,
			);
			expect(snakeGuard(exists('posts', { where: eq('title', 'x') }))).toBe(
				`${snakeHead} EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE user_profiles.id = posts_exists_0.author_id AND posts_exists_0.title = $4)`,
			);
		});

		it('AC12 a nested filtered builder keeps its policy under an unfiltered ORM', () => {
			expect(
				outer
					.update('userProfiles')
					.set({ displayName: 'n' })
					.where(rawExists(issued(filtered.select('posts').columns(['id']))))
					.dump().sql,
			).toBe(
				'UPDATE "userProfiles" SET "displayName" = $1 WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.deleted_at IS NULL)',
			);
		});

		it('AC12 a nested opted-out builder applies no filter', () => {
			expect(
				outer
					.delete('userProfiles')
					.where(
						rawExists(
							issued(
								filtered
									.withoutDefaultFilters()
									.select('posts')
									.columns(['id']),
							),
						),
					)
					.dump().sql,
			).toBe(
				'DELETE FROM "userProfiles" WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq)',
			);
		});

		it('AC12 a plain exists in a filtered ORM mutation stays unfiltered', () => {
			expect(
				filtered
					.update('userProfiles')
					.set({ displayName: 'n' })
					.where(exists('posts', { where: eq('title', 'x') }))
					.dump(),
			).toMatchObject({
				sql: 'UPDATE "userProfiles" SET "displayName" = $1 WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE "userProfiles".id = posts_exists_0."authorId" AND posts_exists_0.title = $2)',
				parameters: ['n', 'x'],
			});
		});

		it('AC13 the unnest upsert compiles a dotted guard after the unnest arrays', () => {
			const rows = Array.from({ length: 200 }, (_, i) => ({
				id: i + 1,
				displayName: 'a',
			}));
			const result = filtered
				.upsertInto(filtered.tables.userProfiles)
				.values(rows)
				.onConflict(['id'])
				.doUpdate({ displayName: 'b' }, eq('posts.title', 'x'))
				.dump();
			expect(result.sql).toBe(
				'INSERT INTO "userProfiles" (id, "displayName") SELECT unnest(CAST($1 AS int4[])) AS id, unnest(CAST($2 AS text[])) AS "displayName" ON CONFLICT (id) DO UPDATE SET "displayName" = $3 WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE "userProfiles".id = posts_exists_0."authorId" AND posts_exists_0.title = $4)',
			);
			expect(result.parameters).toHaveLength(4);
			expect(result.parameters.slice(2)).toEqual(['b', 'x']);
		});
	});

	describe('AC7 schema, casing and NQL context', () => {
		const blogDb = schema({
			users: { id: { type: 'integer', primaryKey: true }, displayName: 'text' },
			blogPosts: {
				id: { type: 'integer', primaryKey: true },
				postTitle: 'text',
				authorId: ref('users', { as: 'author', inverse: 'posts' }),
			},
		} as const);
		const plain = createOrm({
			schema: blogDb,
			adapter: createPgCompileOnlyAdapter({ model: blogDb.model }),
			suppressDxWarnings: true,
		});
		const snake = createOrm({
			schema: blogDb,
			adapter: createPgCompileOnlyAdapter({
				model: blogDb.model,
				dbCasing: 'snake_case',
			}),
			suppressDxWarnings: true,
		});
		const titledPost = () =>
			exists('posts', { where: eq('postTitle', 'x') }) as WhereIntent;

		it('withSchema qualifies the target and the relation table', () => {
			expect(
				plain
					.withSchema('t1')
					.update('users')
					.set({ displayName: 'n' })
					.where(titledPost())
					.dump().sql,
			).toBe(
				'UPDATE t1.users SET "displayName" = $1 WHERE EXISTS (SELECT 1 FROM t1."blogPosts" AS "blogPosts_exists_0" WHERE users.id = "blogPosts_exists_0"."authorId" AND "blogPosts_exists_0"."postTitle" = $2)',
			);
		});

		it('snake_case casing applies inside the resolved condition', () => {
			expect(
				snake
					.update('users')
					.set({ displayName: 'n' })
					.where(titledPost())
					.dump().sql,
			).toBe(
				'UPDATE users SET display_name = $1 WHERE EXISTS (SELECT 1 FROM blog_posts AS "blogPosts_exists_0" WHERE users.id = "blogPosts_exists_0".author_id AND "blogPosts_exists_0".post_title = $2)',
			);
			expect(
				snake
					.delete('users')
					.where(some(snake.tables.users.posts, () => eq('postTitle', 'x')))
					.dump().sql,
			).toBe(
				'DELETE FROM users WHERE EXISTS (SELECT 1 FROM blog_posts AS "blogPosts_exists_0" WHERE users.id = "blogPosts_exists_0".author_id AND "blogPosts_exists_0".post_title = $1)',
			);
		});

		it('NQL mutations compile their WHERE through the same route', () => {
			const v = 'n';
			expect(
				plain.nql`update users set displayName = ${v} where id = 1`.dump().sql,
			).toBe('UPDATE users SET "displayName" = $1 WHERE users.id = $2');
			expect(
				plain.nql`delete from users where posts.postTitle = 'x'`.dump().sql,
			).toBe(
				'DELETE FROM users WHERE EXISTS (SELECT 1 FROM "blogPosts" AS "blogPosts_exists_0" WHERE users.id = "blogPosts_exists_0"."authorId" AND "blogPosts_exists_0"."postTitle" = $1)',
			);
		});
	});
});
