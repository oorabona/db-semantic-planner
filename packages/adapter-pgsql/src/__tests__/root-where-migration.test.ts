import {
	and,
	createOrm,
	eq,
	exists,
	fn,
	inSubquery,
	not,
	notExists,
	or,
	outerRef,
	rangeOverlaps,
	ref,
	schema,
	star,
	subquery,
} from '@dbsp/core';
import type { WhereIntent } from '@dbsp/types';
import { deparseSync } from 'pgsql-deparser';
import { afterEach, expect, it, vi } from 'vitest';
import * as conditions from '../condition-compiler.js';
import type { ConditionCompilerCtx } from '../condition-context.js';
import { createWhereDispatcher } from '../handlers/index.js';
import {
	type CompilerContext,
	createCompilerState,
	type Decision,
} from '../handlers/types.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

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
		const spy = vi.spyOn(conditions, 'compileCondition');
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
			predicate,
			expect.objectContaining({
				position: 'where',
				logicalSourceTable: 'users',
				emittedAlias: 'users',
				model: db.model,
				defaultPkColumnName: 'custom_pk',
				visibleAliases: expect.any(Map),
				paramState: expect.any(Object),
			}),
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
	const spy = vi.spyOn(conditions, 'compileCondition');
	createOrm({
		schema: db,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	})
		.select('users')
		.where(eq('posts.score', 2))
		.dump();
	expect(spy).not.toHaveBeenCalled();
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
	const spy = vi.spyOn(conditions, 'compileCondition');
	const predicate = eq('score', 9);
	orm
		.select('users')
		.join('posts', { as: 'p', on: eq('id', 1) })
		.where(predicate)
		.dump();
	const call = spy.mock.calls.find(([intent]) => intent === predicate);
	expect(call?.[1].visibleAliases.get('p')).toBe('p');
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
it('only a positive root relation leaf reuses its planned JOIN', () => {
	const positive = orm
		.select('posts')
		.where(exists('author', { where: eq('score', 3) }))
		.dump();
	expect(positive.sql).toContain('JOIN users AS author');
	expect(positive.sql).toContain('WHERE author.score = $1');
	expect(positive.sql).not.toContain('EXISTS');
	expect(orm.select('posts').where(exists('author')).dump().sql).not.toContain(
		'WHERE',
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
it('4a item 1 preserves the outer row during relationFilter join reuse', () => {
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
		'SELECT posts.* FROM posts JOIN users AS author ON author.id = posts."authorId" WHERE author.id = posts.id',
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
