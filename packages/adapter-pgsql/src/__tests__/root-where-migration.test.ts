import {
	and,
	any,
	caseWhen,
	createOrm,
	ExpressionRef,
	eq,
	exists,
	exprRef,
	fn,
	inArray,
	inSubquery,
	isNull,
	like,
	literal,
	none,
	not,
	notExists,
	or,
	outerRef,
	param,
	rangeContains,
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
		expect(result.sql).toMatch(/daterange\(\$\d+, \$\d+, '\[\)'\)/);
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
		"daterange($1, $2, '[)')",
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
	expect(any.sql).toContain("daterange($1, $2, '[)')");
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
		'SELECT users.* FROM users WHERE (SELECT posts.score FROM posts) > $1',
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

		it('a generated subquery alias does not capture a NQL binding of the same name', () => {
			const any =
				'users.id = ANY (SELECT p_subq_0_1."authorId" FROM p AS p_subq_0_1)';
			const ctes =
				'WITH p_subq_0 AS (SELECT "blogPosts".id AS x FROM "blogPosts"), p AS (SELECT "blogPosts"."authorId" FROM "blogPosts")';
			expect(
				plain.nql`blogPosts | select id as x | bind p_subq_0
blogPosts | select authorId | bind p
delete from users where id in (p)`.dump().sql,
			).toBe(`${ctes} DELETE FROM users WHERE ${any}`);
			expect(
				plain.nql`blogPosts | select id as x | bind p_subq_0
blogPosts | select authorId | bind p
update users set displayName = 'n' where id in (p)`.dump().sql,
			).toBe(`${ctes} UPDATE users SET "displayName" = $1 WHERE ${any}`);
			expect(
				plain.nql`blogPosts | select id as x | bind p_subq_0
blogPosts | select authorId | bind p
upsert into users on id set id = 1, displayName = 'n' where id in (p)`.dump()
					.sql,
			).toBe(
				`${ctes} INSERT INTO users (id, "displayName") VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET id = $3, "displayName" = $4 WHERE ${any}`,
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

describe('HAVING, CASE WHEN and aggregate FILTER resolve through the root resolver (#891 slice 3)', () => {
	const tables = {
		users: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			score: 'integer',
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			score: 'integer',
			period: { type: 'daterange' },
			data: { type: 'jsonb' },
			deletedAt: { type: 'timestamp', nullable: true },
			authorId: ref('users', { as: 'author', inverse: 'posts' }),
		},
		comments: {
			id: { type: 'integer', primaryKey: true },
			body: 'text',
			deletedAt: { type: 'timestamp', nullable: true },
			postId: ref('posts', { as: 'post', inverse: 'comments' }),
		},
		categories: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			deletedAt: { type: 'timestamp', nullable: true },
			parentId: ref('categories', {
				nullable: true,
				as: 'parent',
				inverse: 'children',
				roles: { parent: 'parent', children: 'children' },
			}),
		},
	} as const;
	const plainDb = schema(tables);
	const filteredDb = schema(tables, undefined, {
		defaultFilters: {
			posts: isNull('deletedAt'),
			comments: isNull('deletedAt'),
			categories: isNull('deletedAt'),
		},
	});
	const plain = createOrm({
		schema: plainDb,
		adapter: createPgCompileOnlyAdapter(),
		suppressDxWarnings: true,
	});
	const filtered = createOrm({
		schema: filteredDb,
		adapter: createPgCompileOnlyAdapter(),
		suppressDxWarnings: true,
	});
	type SliceOrm = typeof plain;
	const sql = (d: { sql: string; params: readonly unknown[] }) => ({
		sql: d.sql,
		params: d.params,
	});
	const deleted = (alias: string, on: boolean) =>
		on ? ` AND ${alias}."deletedAt" IS NULL` : '';
	const relationExists = (n: number, on = false) =>
		`EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId"${deleted('posts_exists_0', on)} AND posts_exists_0.title = $${n})`;

	// Each condition: how it is built, its SQL at parameter $n, and its parameters.
	const conditionCases: readonly {
		readonly name: string;
		readonly build: (o: SliceOrm) => WhereIntent;
		readonly fragment: (n: number, on: boolean) => string;
		readonly params: readonly unknown[];
	}[] = [
		{
			name: 'EQ',
			build: () => eq('score', 1),
			fragment: (n) => `users.score = $${n}`,
			params: [1],
		},
		{
			name: 'REL',
			build: () => exists('posts', { where: eq('title', 'x') }),
			fragment: relationExists,
			params: ['x'],
		},
		{
			name: 'DOTTED',
			build: () => eq('posts.title', 'x'),
			fragment: relationExists,
			params: ['x'],
		},
		{
			name: 'SOME',
			build: (o) =>
				some(
					o.tables.users?.posts as unknown as Parameters<typeof some>[0],
					() => eq('title', 'x'),
				),
			fragment: relationExists,
			params: ['x'],
		},
		{
			name: 'NONE',
			build: (o) =>
				none(
					o.tables.users?.posts as unknown as Parameters<typeof none>[0],
					() => eq('title', 'x'),
				),
			fragment: (n, on) => `NOT (${relationExists(n, on)})`,
			params: ['x'],
		},
		{
			name: 'RAWEXISTS',
			build: () =>
				rawExists(subquery('posts').select('id').where(eq('title', 'x'))),
			fragment: (n, on) =>
				`EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.title = $${n}${deleted('posts_sq', on)})`,
			params: ['x'],
		},
		{
			name: 'ISSUED',
			build: (o) =>
				rawExists(
					o
						.select('posts')
						.columns(['id'])
						.where(eq('title', 'x')) as unknown as Parameters<
						typeof rawExists
					>[0],
				),
			fragment: (n, on) =>
				`EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.title = $${n}${deleted('posts_sq', on)})`,
			params: ['x'],
		},
		{
			name: 'INSUB',
			build: () => inSubquery('id', subquery('posts').select('authorId')),
			fragment: (_n, on) =>
				`users.id = ANY (SELECT posts_subq_0."authorId" FROM posts AS posts_subq_0${on ? ' WHERE posts_subq_0."deletedAt" IS NULL' : ''})`,
			params: [],
		},
	];
	// Each position: how it wraps a condition, and the SQL it emits around the fragment.
	const positions: readonly {
		readonly name: string;
		readonly having: boolean;
		readonly run: (
			o: SliceOrm,
			c: WhereIntent,
		) => { sql: string; params: readonly unknown[] };
		readonly expected: (
			fragment: (n: number) => string,
			params: readonly unknown[],
		) => { sql: string; params: readonly unknown[] };
	}[] = [
		{
			name: 'HAVING',
			having: true,
			run: (o, c) =>
				o.select('users').groupBy(['id']).count('id', 'n').having(c).dump(),
			expected: (f, p) => ({
				sql: `SELECT users.id, count(users.id) AS n FROM users GROUP BY users.id HAVING ${f(1)}`,
				params: p,
			}),
		},
		{
			name: 'FILTER in HAVING',
			having: true,
			run: (o, c) =>
				o
					.select('users')
					.groupBy(['id'])
					.having(fn('count', star()).filter(c).gt(19))
					.dump(),
			expected: (f, p) => ({
				sql: `SELECT users.* FROM users GROUP BY users.id HAVING count(*) FILTER (WHERE ${f(1)}) > $${p.length + 1}`,
				params: [...p, 19],
			}),
		},
		{
			name: 'CASE in the projection',
			having: false,
			run: (o, c) =>
				o
					.select('users')
					.columns([caseWhen(c, literal(1)).else(literal(0)).as('flag')])
					.dump(),
			expected: (f, p) => ({
				sql: `SELECT CASE WHEN ${f(1)} THEN 1 ELSE 0 END AS flag FROM users`,
				params: p,
			}),
		},
		{
			name: 'CASE in ORDER BY',
			having: false,
			run: (o, c) =>
				o
					.select('users')
					.orderBy(caseWhen(c, literal(1)).else(literal(0)).as('flag'), 'desc')
					.dump(),
			expected: (f, p) => ({
				sql: `SELECT users.* FROM users ORDER BY CASE WHEN ${f(1)} THEN 1 ELSE 0 END DESC`,
				params: p,
			}),
		},
		{
			name: 'CASE nested as a THEN value',
			having: false,
			run: (o, c) =>
				o
					.select('users')
					.columns([
						caseWhen(eq('id', 7), caseWhen(c, literal(1)).else(literal(2)))
							.else(literal(0))
							.as('flag'),
					])
					.dump(),
			expected: (f, p) => ({
				sql: `SELECT CASE WHEN users.id = $1 THEN CASE WHEN ${f(2)} THEN 1 ELSE 2 END ELSE 0 END AS flag FROM users`,
				params: [7, ...p],
			}),
		},
		{
			name: 'FILTER in the projection',
			having: false,
			run: (o, c) =>
				o
					.select('users')
					.columns([fn('count', star()).filter(c).as('n')])
					.dump(),
			expected: (f, p) => ({
				sql: `SELECT count(*) FILTER (WHERE ${f(1)}) AS n FROM users`,
				params: p,
			}),
		},
	];

	// AC1 and AC5: every condition compiles the same with and without default filters,
	// apart from the filter predicates; dotted fields under HAVING keep main's route (AC18).
	for (const position of positions)
		for (const condition of conditionCases) {
			if (position.having && condition.name === 'DOTTED') continue;
			it(`AC5 ${condition.name} in ${position.name} does not depend on default filters`, () => {
				expect(sql(position.run(plain, condition.build(plain)))).toEqual(
					position.expected(
						(n) => condition.fragment(n, false),
						condition.params,
					),
				);
				expect(sql(position.run(filtered, condition.build(filtered)))).toEqual(
					position.expected(
						(n) => condition.fragment(n, true),
						condition.params,
					),
				);
			});
		}

	it('AC1 a FILTER inside a function argument compiles a dotted path to EXISTS', () => {
		const d = plain
			.select('users')
			.columns([
				fn(
					'coalesce',
					fn('count', star()).filter(eq('posts.title', 'x')),
					literal(0),
				).as('v'),
			])
			.dump();
		expect(sql(d)).toEqual({
			sql: `SELECT "coalesce"(count(*) FILTER (WHERE ${relationExists(1)}), 0) AS v FROM users`,
			params: ['x'],
		});
	});

	it('AC1 every field-bearing condition kind with a dotted field compiles to EXISTS', () => {
		const flag = (c: WhereIntent) =>
			sql(
				plain
					.select('users')
					.columns([caseWhen(c, literal(1)).else(literal(0)).as('f')])
					.dump(),
			);
		const wrapped = (inner: string) =>
			`SELECT CASE WHEN EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND ${inner}) THEN 1 ELSE 0 END AS f FROM users`;
		expect(flag(like('posts.title', 'x%'))).toEqual({
			sql: wrapped('posts_exists_0.title LIKE $1'),
			params: ['x%'],
		});
		expect(flag(isNull('posts.deletedAt'))).toEqual({
			sql: wrapped('posts_exists_0."deletedAt" IS NULL'),
			params: [],
		});
		expect(flag(inArray('posts.score', [1, 2]))).toEqual({
			sql: wrapped('posts_exists_0.score = ANY ($1)'),
			params: [[1, 2]],
		});
		expect(flag(any('posts.score', [1, 2]))).toEqual({
			sql: wrapped('posts_exists_0.score = ANY (CAST($1 AS int4[]))'),
			params: [[1, 2]],
		});
		expect(flag(rangeContains('posts.period', '2024-01-05'))).toEqual({
			sql: wrapped('posts_exists_0.period @> CAST($1 AS date)'),
			params: ['2024-01-05'],
		});
		expect(
			flag({
				kind: 'jsonContains',
				field: 'posts.data',
				value: { a: 1 },
			} as WhereIntent),
		).toEqual({
			sql: wrapped('posts_exists_0.data @> $1'),
			params: [{ a: 1 }],
		});
		expect(
			flag({
				kind: 'jsonExists',
				field: 'posts.data',
				key: 'active',
			} as WhereIntent),
		).toEqual({ sql: wrapped('posts_exists_0.data ? $1'), params: ['active'] });
	});

	it('AC2 NQL CASE compiles a dotted path to EXISTS, in a projection and inside a function argument', () => {
		const projection = (o: SliceOrm) =>
			sql(
				o.nql`users | select id, case when posts.title = 'x' then 1 else 0 end as flag`.dump() as {
					sql: string;
					params: readonly unknown[];
				},
			);
		const inFunction = (o: SliceOrm) =>
			sql(
				o.nql`users | select id, coalesce(case when posts.title = 'x' then 1 end, 0) as v`.dump() as {
					sql: string;
					params: readonly unknown[];
				},
			);
		expect(projection(plain)).toEqual({
			sql: `SELECT users.id, CASE WHEN ${relationExists(1)} THEN 1 ELSE 0 END AS flag FROM users`,
			params: ['x'],
		});
		expect(projection(filtered)).toEqual({
			sql: `SELECT users.id, CASE WHEN ${relationExists(1, true)} THEN 1 ELSE 0 END AS flag FROM users`,
			params: ['x'],
		});
		expect(inFunction(plain)).toEqual({
			sql: `SELECT users.id, COALESCE(CASE WHEN ${relationExists(1)} THEN $2 END, $3) AS v FROM users`,
			params: ['x', 1, 0],
		});
		expect(inFunction(filtered)).toEqual({
			sql: `SELECT users.id, COALESCE(CASE WHEN ${relationExists(1, true)} THEN $2 END, $3) AS v FROM users`,
			params: ['x', 1, 0],
		});
	});

	it('AC7 visible qualifiers keep binding their range; a join alias then a relation path compiles to EXISTS', () => {
		const joined = () => plain.select('posts').join('author');
		const join =
			'FROM posts JOIN users AS author ON posts."authorId" = author.id';
		expect(
			sql(
				joined()
					.columns([fn('count', star()).filter(eq('author.name', 'x')).as('n')])
					.dump(),
			),
		).toEqual({
			sql: `SELECT count(*) FILTER (WHERE author.name = $1) AS n ${join}`,
			params: ['x'],
		});
		expect(
			sql(
				joined()
					.groupBy(['id'])
					.count('id', 'n')
					.having(eq('author.name', 'x'))
					.dump(),
			),
		).toEqual({
			sql: `SELECT posts.id, count(posts.id) AS n ${join} GROUP BY posts.id HAVING author.name = $1`,
			params: ['x'],
		});
		expect(
			sql(
				joined()
					.columns([
						caseWhen(eq('author.name', 'x'), literal(1))
							.else(literal(0))
							.as('f'),
					])
					.dump(),
			),
		).toEqual({
			sql: `SELECT CASE WHEN author.name = $1 THEN 1 ELSE 0 END AS f ${join}`,
			params: ['x'],
		});
		expect(
			sql(
				plain
					.select('posts')
					.columns([fn('count', star()).filter(eq('posts.title', 'x')).as('n')])
					.dump(),
			),
		).toEqual({
			sql: 'SELECT count(*) FILTER (WHERE posts.title = $1) AS n FROM posts',
			params: ['x'],
		});
		expect(
			sql(
				joined()
					.columns([
						fn('count', star()).filter(eq('author.posts.title', 'x')).as('n'),
					])
					.dump(),
			),
		).toEqual({
			sql: `SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE author.id = posts_exists_0."authorId" AND posts_exists_0.title = $1)) AS n ${join}`,
			params: ['x'],
		});
	});

	it('AC10 with a joined include, a CASE compiles the same as without it', () => {
		const flagged = (c: WhereIntent) =>
			caseWhen(c, literal(1)).else(literal(0)).as('flag');
		const correlated = () =>
			rawExists(
				subquery('posts')
					.select('id')
					.where(eq('authorId', outerRef('authorId'))),
			);
		const authorColumns =
			'author.id AS "author.id", author.name AS "author.name", author.score AS "author.score", author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id';
		expect(
			sql(
				plain
					.select('posts')
					.include('author', { join: 'left' })
					.columns(['id', flagged(correlated())])
					.dump(),
			),
		).toEqual({
			sql: `SELECT posts.id, CASE WHEN EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq."authorId" = posts."authorId") THEN 1 ELSE 0 END AS flag, ${authorColumns}`,
			params: [],
		});
		expect(
			sql(
				plain
					.select('posts')
					.include('author', { join: 'left' })
					.columns(['id', flagged(eq('comments.body', 'x'))])
					.dump(),
			),
		).toEqual({
			sql: `SELECT posts.id, CASE WHEN EXISTS (SELECT 1 FROM comments AS comments_exists_0 WHERE posts.id = comments_exists_0."postId" AND comments_exists_0.body = $1) THEN 1 ELSE 0 END AS flag, ${authorColumns}`,
			params: ['x'],
		});
		expect(
			sql(
				plain
					.select('posts')
					.include('author', { join: 'left' })
					.columns([
						'id',
						caseWhen(eq('author.name', null), literal(1))
							.else(literal(0))
							.as('f'),
					])
					.dump(),
			),
		).toEqual({
			sql: `SELECT posts.id, CASE WHEN author.name IS NULL THEN 1 ELSE 0 END AS f, ${authorColumns}`,
			params: [],
		});
	});

	it('AC10 a body issued by another policy keeps that policy in FILTER, CASE WHEN and HAVING', () => {
		const off = filtered.withoutDefaultFilters();
		const issued = (o: SliceOrm) =>
			rawExists(
				o.select('posts').columns(['id']) as unknown as Parameters<
					typeof rawExists
				>[0],
			);
		const body = (on: boolean) =>
			`EXISTS (SELECT posts_sq.id FROM posts AS posts_sq${on ? ' WHERE posts_sq."deletedAt" IS NULL' : ''})`;
		for (const [outer, issuer, on] of [
			[off, filtered, true],
			[filtered, off, false],
		] as const) {
			expect(
				outer
					.select('users')
					.columns([fn('count', star()).filter(issued(issuer)).as('n')])
					.dump().sql,
			).toBe(`SELECT count(*) FILTER (WHERE ${body(on)}) AS n FROM users`);
			expect(
				outer
					.select('users')
					.columns([
						caseWhen(issued(issuer), literal(1)).else(literal(0)).as('f'),
					])
					.dump().sql,
			).toBe(`SELECT CASE WHEN ${body(on)} THEN 1 ELSE 0 END AS f FROM users`);
			expect(
				outer
					.select('users')
					.groupBy(['id'])
					.count('id', 'n')
					.having(issued(issuer))
					.dump().sql,
			).toBe(
				`SELECT users.id, count(users.id) AS n FROM users GROUP BY users.id HAVING ${body(on)}`,
			);
		}
	});

	it('AC10 an aggregate expression carrying a dotted field is not taken for a condition', () => {
		const aggregate = {
			kind: 'expression',
			expr: { kind: 'aggregate', function: 'max', field: 'author.score' },
			operator: 'gt',
			value: 1,
		} as unknown as WhereIntent;
		const grouped = () => plain.select('posts').join('author').groupBy(['id']);
		// Resolved by core, as in WHERE: the dotted field is the joined range's column.
		expect(sql(grouped().having(aggregate).dump())).toEqual({
			sql: 'SELECT posts.* FROM posts JOIN users AS author ON posts."authorId" = author.id GROUP BY posts.id HAVING max(author.score) > $1',
			params: [1],
		});
		expect(
			sql(
				grouped()
					.columns([
						'id',
						caseWhen(aggregate, literal(1)).else(literal(0)).as('f'),
					])
					.dump(),
			),
		).toEqual({
			sql: 'SELECT posts.id, CASE WHEN max(author.score) > $1 THEN 1 ELSE 0 END AS f FROM posts JOIN users AS author ON posts."authorId" = author.id GROUP BY posts.id',
			params: [1],
		});
		expect(
			sql(grouped().having(fn('max', 'author.score').gt(1)).dump()),
		).toEqual({
			sql: 'SELECT posts.* FROM posts JOIN users AS author ON posts."authorId" = author.id GROUP BY posts.id HAVING max(author.score) > $1',
			params: [1],
		});
	});

	it('AC10 NQL binding-final queries keep their current output', () => {
		for (const o of [plain, filtered]) {
			expect(() =>
				o.nql`users | select id, name | bind u
u | select id, case when posts.title = 'x' then 1 else 0 end as flag`.dump(),
			).toThrow(
				"Query 'u' reads from an NQL binding and cannot reference relation path 'posts.title'. Relation paths require a physical model table, not a CTE binding.",
			);
			expect(
				(
					o.nql`users | select id, name | bind u
u | select id, case when name = 'x' then 1 else 0 end as flag`.dump() as {
						sql: string;
					}
				).sql,
			).toBe(
				'WITH u AS (SELECT users.id, users.name FROM users) SELECT u.id, CASE WHEN u.name = $1 THEN 1 ELSE 0 END AS flag FROM u',
			);
		}
	});

	it('AC14 expression aliases avoid the WHERE names; a scalar body with its own aggregate FILTER is refused', () => {
		expect(
			sql(
				plain
					.select('users')
					.where(exists('posts'))
					.columns([fn('count', star()).filter(exists('posts')).as('n')])
					.dump(),
			),
		).toEqual({
			sql: 'SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_1 WHERE users.id = posts_exists_1."authorId")) AS n FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId")',
			params: [],
		});
		expect(
			sql(
				plain
					.select('posts')
					.where(exists('comments'))
					.columns([fn('count', star()).filter(exists('author')).as('n')])
					.dump(),
			),
		).toEqual({
			sql: 'SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts."authorId" = users_exists_0.id)) AS n FROM posts WHERE EXISTS (SELECT 1 FROM comments AS comments_exists_0 WHERE posts.id = comments_exists_0."postId")',
			params: [],
		});
		expect(() =>
			plain
				.select('users')
				.columns([
					fn('count', star())
						.filter({
							kind: 'subquery',
							field: 'score',
							operator: 'gt',
							subquery: {
								type: 'select',
								from: 'posts',
								select: {
									type: 'aggregate',
									aggregates: [
										{
											function: 'count',
											field: '*',
											as: 'c',
											filter: eq('title', 'x'),
										},
									],
								},
							},
						} as WhereIntent)
						.as('n'),
				])
				.dump(),
		).toThrow(
			'scalar subquery with an aggregate FILTER is not supported — it would silently change which rows match; restructure the query or use a CTE.',
		);
	});

	it('AC19 an expressions-select scalar operand of a resolved condition compiles as a nested select (#1007)', () => {
		const expr = () =>
			new ExpressionRef({
				kind: 'subquery',
				query: {
					type: 'select',
					from: 'posts',
					select: {
						type: 'expressions',
						columns: [fn('max', exprRef('score')).intent],
					},
				},
			} as never);
		const filterSql = (o: typeof plain, field: string) =>
			sql(
				o
					.select('users')
					.columns([fn('count', star()).filter(eq(field, expr())).as('n')])
					.dump(),
			);
		const caseSql = (o: typeof plain) =>
			sql(
				o
					.select('users')
					.columns([
						caseWhen(eq('users.score', expr()), literal(1))
							.else(literal(0))
							.as('f'),
					])
					.dump(),
			);
		expect([
			filterSql(plain, 'users.score'),
			caseSql(plain),
			filterSql(plain, 'score'),
			filterSql(filtered, 'users.score'),
			caseSql(filtered),
			filterSql(filtered, 'score'),
		]).toEqual([
			{
				sql: 'SELECT count(*) FILTER (WHERE users.score = (SELECT max(score) FROM posts)) AS n FROM users',
				params: [],
			},
			{
				sql: 'SELECT CASE WHEN users.score = (SELECT max(score) FROM posts) THEN 1 ELSE 0 END AS f FROM users',
				params: [],
			},
			{
				sql: 'SELECT count(*) FILTER (WHERE users.score = (SELECT max(score) FROM posts)) AS n FROM users',
				params: [],
			},
			{
				sql: 'SELECT count(*) FILTER (WHERE users.score = (SELECT max(score) FROM posts WHERE posts."deletedAt" IS NULL)) AS n FROM users',
				params: [],
			},
			{
				sql: 'SELECT CASE WHEN users.score = (SELECT max(score) FROM posts WHERE posts."deletedAt" IS NULL) THEN 1 ELSE 0 END AS f FROM users',
				params: [],
			},
			{
				sql: 'SELECT count(*) FILTER (WHERE users.score = (SELECT max(score) FROM posts WHERE posts."deletedAt" IS NULL)) AS n FROM users',
				params: [],
			},
		]);
	});

	it('R1 a qualifier naming no visible range and no relation is refused in CASE WHEN and FILTER', () => {
		const message = (name: string) =>
			`exists('${name}'): no relation '${name}' is declared on table 'categories'. Use rawExists(subquery(...)) for an EXISTS over an undeclared or uncorrelated subquery.`;
		for (const o of [plain, filtered])
			for (const name of ['users', 'nope']) {
				const c = () => eq(`${name}.name`, 'x');
				expect(() =>
					o
						.select('categories')
						.columns([caseWhen(c(), literal(1)).else(literal(0)).as('f')])
						.dump(),
				).toThrow(message(name));
				expect(() =>
					o
						.select('categories')
						.columns([fn('count', star()).filter(c()).as('n')])
						.dump(),
				).toThrow(message(name));
			}
	});

	it("R1 in HAVING an unknown qualifier gets the root WHERE's refusal", () => {
		const having = (o: SliceOrm, c: WhereIntent) =>
			o.select('categories').groupBy(['id']).count('id', 'n').having(c).dump();
		for (const o of [plain, filtered])
			for (const name of ['users', 'nope'])
				expect(() => having(o, eq(`${name}.title`, 'x'))).toThrow(
					`exists('${name}'): no relation '${name}' is declared on table 'categories'. Use rawExists(subquery(...)) for an EXISTS over an undeclared or uncorrelated subquery.`,
				);
	});
});

describe('root WHERE resolved parameters and EXISTS projections (#891 slice 4)', () => {
	const local = schema({
		categories: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			score: 'integer',
			data: { type: 'json', dbType: 'jsonb' },
			parentId: ref('categories', {
				nullable: true,
				as: 'parent',
				inverse: 'children',
				roles: { parent: 'parent', children: 'children' },
			}),
		},
	});
	const orm = createOrm({
		schema: local,
		adapter: createPgCompileOnlyAdapter(),
	});
	const where = (condition: WhereIntent) =>
		orm.select('categories').where(condition).dump();
	const select = (condition: string) =>
		`SELECT categories.* FROM categories WHERE ${condition}`;
	const pr = { paramIndex: 7, value: 'payload' };
	for (const [key, name, condition, sql, params] of [
		[
			'paramref-root',
			'eq',
			eq('data', pr),
			'categories.data = CAST($1 AS jsonb)',
			[pr],
		],
		[
			'paramref-root',
			'jsonContains',
			{ kind: 'jsonContains', field: 'data', value: pr, reversed: false },
			'categories.data @> $1',
			[pr],
		],
		[
			'paramintent-nested',
			'eq',
			eq('data', { kind: 'param', value: { kind: 'param', value: 'payload' } }),
			'categories.data = CAST($1 AS jsonb)',
			[{ kind: 'param', value: 'payload' }],
		],
		[
			'param-wrapper',
			'jsonContains',
			{
				kind: 'jsonContains',
				field: 'data',
				value: param({ active: true }),
				reversed: false,
			},
			'categories.data @> $1',
			[{ active: true }],
		],
		[
			'param-wrapper',
			'like',
			{ kind: 'like', field: 'name', pattern: param('x%') },
			'categories.name LIKE $1',
			['x%'],
		],
		[
			'param-wrapper',
			'jsonExists',
			{ kind: 'jsonExists', field: 'data', key: param('k') },
			'categories.data ? $1',
			['k'],
		],
		[
			'in-param-wrapper',
			'elements',
			inArray('id', [param(1), param(2)]),
			'categories.id = ANY ($1)',
			[[1, 2]],
		],
		[
			'in-param-wrapper',
			'single array',
			inArray('id', [param([1, 2])]),
			'categories.id = ANY ($1)',
			[[1, 2]],
		],
		[
			'in-param-wrapper',
			'whole list',
			{ kind: 'in', field: 'id', values: param([1, 2]) },
			'categories.id = ANY ($1)',
			[[1, 2]],
		],
	] as const) {
		it(`AC12 ${key} ${name}: the resolved value binds as data`, () => {
			const dump = where(condition as WhereIntent);
			expect(dump.sql).toBe(select(sql));
			expect(dump.params).toEqual(params);
		});
	}
	const recursion = {
		kind: 'exists',
		relation: 'children',
		where: eq('score', 71),
		recursive: { direction: 'down', through: 'children', maxDepth: 3 },
	} as const;
	it('AC13 exists-projection-recursion: recursion in a dropped EXISTS projection compiles', () => {
		const dump = where(
			rawExists(
				// rawExists() accepts an ORM builder at runtime but not in its type (#994).
				orm
					.select('categories')
					.columns([
						caseWhen(recursion, literal(1)).else(literal(0)).as('flag'),
					]) as unknown as Parameters<typeof rawExists>[0],
			),
		);
		expect(dump.sql).toBe(
			select('EXISTS (SELECT 1 FROM categories AS categories_sq)'),
		);
		expect(dump.params).toEqual([]);
	});
	it('AC13 exists-aggregate-filter-recursion: the aggregate stays, its FILTER goes', () => {
		const dump = where({
			kind: 'rawExists',
			subquery: {
				type: 'select',
				from: 'categories',
				where: or(),
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count', field: '*', filter: recursion }],
				},
			},
		} as WhereIntent);
		expect(dump.sql).toBe(
			select(
				'EXISTS (SELECT count(*) FROM categories AS categories_sq WHERE false)',
			),
		);
		expect(dump.params).toEqual([]);
	});
});
