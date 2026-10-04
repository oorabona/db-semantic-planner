import {
	and,
	createOrm,
	eq,
	every,
	exists,
	fn,
	gt,
	inSubquery,
	none,
	not,
	notExists,
	or,
	planRecursive,
	rawExists,
	ref,
	schema,
	some,
	star,
	subquery,
} from '@dbsp/core';
import type { WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compilePlan } from '../compiler.js';
import { convertWhereCondition } from '../intent-to-decisions.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { convertWhereToDecisions } from '../plan-decision-extractor.js';

const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		tenantId: { type: 'integer' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
	teams: { id: { type: 'integer', primaryKey: true } },
	edges: {
		id: { type: 'integer', primaryKey: true },
		from_id: { type: 'integer' },
		to_id: { type: 'integer' },
	},
} as const);
const model = testSchema.model;
const adapter = createPgCompileOnlyAdapter({ model });
const orm = createOrm({ schema: testSchema, adapter });
type Result =
	| { sql: string; params: readonly unknown[] }
	| { sql: string; parameters: readonly unknown[] };
const cases: [string, () => Result][] = [];
function add(name: string, run: () => Result) {
	cases.push([name, run]);
}
for (const [name, condition] of [
	['or root', or()],
	['and root', and()],
	['and eq or', and(eq('tenantId', 1), or())],
	['or eq or', or(eq('tenantId', 1), or())],
	['not or', not(or())],
	['not and', not(and())],
	['and eq not and', and(eq('tenantId', 1), not(and()))],
	['constant before param', and(or(), eq('tenantId', 1))],
	['constant between params', and(eq('tenantId', 1), or(), eq('id', 2))],
] as const)
	add(name, () => orm.select('users').where(condition).dump());
for (const [name, helper] of [
	['exists', exists],
	['notExists', notExists],
] as const)
	add(name, () =>
		orm
			.select('users')
			.where(helper('posts', { where: or() }))
			.dump(),
	);
for (const [name, helper] of [
	['some', some],
	['every', every],
	['none', none],
] as const)
	for (const [constant, condition] of [
		['false', or()],
		['true', and()],
	] as const)
		add(`${name} ${constant}`, () =>
			orm
				.select('users')
				.where(helper(orm.tables.users.posts, () => condition))
				.dump(),
		);
add('include join', () => {
	const toOne = schema({
		users: { id: { type: 'integer', primaryKey: true }, tenantId: 'integer' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			authorId: ref('users', { as: 'author', inverse: 'posts', unique: true }),
		},
	});
	return createOrm({
		schema: toOne,
		adapter: createPgCompileOnlyAdapter({ model: toOne.model }),
	})
		.select('users')
		.include('posts', { join: 'inner', where: or() })
		.dump();
});
add('IN inner where', () =>
	orm
		.select('users')
		.where(inSubquery('id', subquery('posts').select('authorId').where(or())))
		.dump(),
);
add('scalar inner where', () =>
	orm
		.select('users')
		.where({
			kind: 'subquery',
			field: 'id',
			operator: 'eq',
			subquery: {
				type: 'select',
				from: 'posts',
				select: { type: 'fields', fields: ['id'] },
				where: or(),
			},
		} as WhereIntent)
		.dump(),
);
add('raw exists inner where', () =>
	orm
		.select('users')
		.where(rawExists(subquery('posts').select('id').where(or())))
		.dump(),
);
for (const [name, condition] of [
	['false', or()],
	['true', and()],
] as const) {
	add(`join ${name}`, () =>
		orm.select('users').join('teams', { on: condition, as: 't' }).dump(),
	);
	add(`filter ${name}`, () =>
		orm
			.select('users')
			.columns([fn('count', star()).filter(condition).as('n')])
			.dump(),
	);
}
for (const [name, condition] of [
	['false', or()],
	['or', or(gt('n', 1), eq('n', 0))],
	['and', and(gt('n', 1), eq('n', 0))],
] as const)
	add(`having ${name}`, () =>
		orm
			.select('users')
			.count({ as: 'n' })
			.groupBy(['tenantId'])
			.having(condition)
			.dump(),
	);
add('delete lock', () =>
	orm
		.removeFrom(orm.tables.users)
		.where(and(eq('tenantId', 1), or()))
		.dump(),
);
add('update lock', () =>
	orm
		.modify(orm.tables.users)
		.set({ tenantId: 2 })
		.where(and(eq('id', 1), or()))
		.dump(),
);
for (const [name, condition] of [
	['recursive anchor', or()],
	['recursive and anchor', and()],
	['recursive not and anchor', not(and())],
	['recursive and false anchor', and(eq('tenantId', 1), or())],
] as const)
	add(name, () =>
		adapter.compileRecursive(
			planRecursive(
				{
					type: 'recursive',
					cteName: 'tree',
					start: {
						from: 'users',
						nodeIdExpr: { kind: 'column', name: 'id' },
						where: condition,
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'users',
						nodeId: 'id',
						edgeTable: 'edges',
						edgeFrom: 'from_id',
						edgeTo: 'to_id',
						direction: 'out',
					},
					maxDepth: 2,
				},
				model,
			),
			model,
		),
	);

const expected: Record<string, { sql: string; params: readonly unknown[] }> = {
	'or root': {
		sql: 'SELECT users.* FROM users WHERE false',
		params: [],
	},
	'and root': {
		sql: 'SELECT users.* FROM users WHERE true',
		params: [],
	},
	'and eq or': {
		sql: 'SELECT users.* FROM users WHERE users."tenantId" = $1 AND false',
		params: [1],
	},
	'or eq or': {
		sql: 'SELECT users.* FROM users WHERE users."tenantId" = $1 OR false',
		params: [1],
	},
	'not or': {
		sql: 'SELECT users.* FROM users WHERE NOT (false)',
		params: [],
	},
	'not and': {
		sql: 'SELECT users.* FROM users WHERE NOT (true)',
		params: [],
	},
	'and eq not and': {
		sql: 'SELECT users.* FROM users WHERE users."tenantId" = $1 AND NOT (true)',
		params: [1],
	},
	'constant before param': {
		sql: 'SELECT users.* FROM users WHERE false AND users."tenantId" = $1',
		params: [1],
	},
	'constant between params': {
		sql: 'SELECT users.* FROM users WHERE users."tenantId" = $1 AND false AND users.id = $2',
		params: [1, 2],
	},
	exists: {
		sql: 'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND false)',
		params: [],
	},
	notExists: {
		sql: 'SELECT users.* FROM users WHERE NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND false))',
		params: [],
	},
	'some false': {
		sql: 'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND false)',
		params: [],
	},
	'some true': {
		sql: 'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND true)',
		params: [],
	},
	'every false': {
		sql: 'SELECT users.* FROM users WHERE NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND NOT (false)))',
		params: [],
	},
	'every true': {
		sql: 'SELECT users.* FROM users WHERE true',
		params: [],
	},
	'none false': {
		sql: 'SELECT users.* FROM users WHERE NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND false))',
		params: [],
	},
	'none true': {
		sql: 'SELECT users.* FROM users WHERE NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND true))',
		params: [],
	},
	'include join': {
		sql: 'SELECT users.*, posts.id AS "posts.id", posts."authorId" AS "posts.authorId", posts.id AS __dbsp_presence_posts FROM users JOIN posts AS posts ON users.id = posts."authorId" WHERE false',
		params: [],
	},
	'IN inner where': {
		sql: 'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND false)',
		params: [],
	},
	'scalar inner where': {
		sql: 'SELECT users.* FROM users WHERE users.id = (SELECT posts_subq_0.id FROM posts AS posts_subq_0 WHERE false)',
		params: [],
	},
	'raw exists inner where': {
		sql: 'SELECT users.* FROM users WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE false)',
		params: [],
	},
	'join false': {
		sql: 'SELECT users.* FROM users JOIN teams AS t ON false',
		params: [],
	},
	'filter false': {
		sql: 'SELECT count(*) FILTER (WHERE false) AS n FROM users',
		params: [],
	},
	'join true': {
		sql: 'SELECT users.* FROM users JOIN teams AS t ON true',
		params: [],
	},
	'filter true': {
		sql: 'SELECT count(*) FILTER (WHERE true) AS n FROM users',
		params: [],
	},
	'having false': {
		sql: 'SELECT users."tenantId", count(*) AS n FROM users GROUP BY users."tenantId" HAVING false',
		params: [],
	},
	'having or': {
		sql: 'SELECT users."tenantId", count(*) AS n FROM users GROUP BY users."tenantId" HAVING count(*) > CAST($1 AS bigint) OR count(*) = CAST($2 AS bigint)',
		params: [1, 0],
	},
	'having and': {
		sql: 'SELECT users."tenantId", count(*) AS n FROM users GROUP BY users."tenantId" HAVING count(*) > CAST($1 AS bigint) AND count(*) = CAST($2 AS bigint)',
		params: [1, 0],
	},
	'delete lock': {
		sql: 'DELETE FROM users WHERE users."tenantId" = $1 AND false',
		params: [1],
	},
	'update lock': {
		sql: 'UPDATE users SET "tenantId" = $1 WHERE users.id = $2 AND false',
		params: [2, 1],
	},
	'recursive anchor': {
		sql: 'WITH RECURSIVE tree AS (SELECT __n.id AS id, 1 AS __depth, ARRAY[__n.id] AS __visited FROM users AS __n WHERE false UNION ALL SELECT __n.id AS id, tree.__depth + 1 AS __depth, tree.__visited || __n.id AS __visited FROM tree JOIN edges AS __e ON __e.from_id = tree.id JOIN users AS __n ON __n.id = __e.to_id WHERE tree.__depth < 2 AND __n.id <> ALL (tree.__visited)) SELECT tree.id AS id FROM tree',
		params: [],
	},

	'recursive and false anchor': {
		sql: 'WITH RECURSIVE tree AS (SELECT __n.id AS id, 1 AS __depth, ARRAY[__n.id] AS __visited FROM users AS __n WHERE __n."tenantId" = $1 AND false UNION ALL SELECT __n.id AS id, tree.__depth + 1 AS __depth, tree.__visited || __n.id AS __visited FROM tree JOIN edges AS __e ON __e.from_id = tree.id JOIN users AS __n ON __n.id = __e.to_id WHERE tree.__depth < 2 AND __n.id <> ALL (tree.__visited)) SELECT tree.id AS id FROM tree',
		params: [1],
	},

	'recursive not and anchor': {
		sql: 'WITH RECURSIVE tree AS (SELECT __n.id AS id, 1 AS __depth, ARRAY[__n.id] AS __visited FROM users AS __n WHERE NOT (true) UNION ALL SELECT __n.id AS id, tree.__depth + 1 AS __depth, tree.__visited || __n.id AS __visited FROM tree JOIN edges AS __e ON __e.from_id = tree.id JOIN users AS __n ON __n.id = __e.to_id WHERE tree.__depth < 2 AND __n.id <> ALL (tree.__visited)) SELECT tree.id AS id FROM tree',
		params: [],
	},

	'recursive and anchor': {
		sql: 'WITH RECURSIVE tree AS (SELECT __n.id AS id, 1 AS __depth, ARRAY[__n.id] AS __visited FROM users AS __n WHERE true UNION ALL SELECT __n.id AS id, tree.__depth + 1 AS __depth, tree.__visited || __n.id AS __visited FROM tree JOIN edges AS __e ON __e.from_id = tree.id JOIN users AS __n ON __n.id = __e.to_id WHERE tree.__depth < 2 AND __n.id <> ALL (tree.__visited)) SELECT tree.id AS id FROM tree',
		params: [],
	},
};

describe('#888 empty logical groups', () => {
	for (const [name, run] of cases)
		it(name, () => {
			const result = run();
			expect(result.sql).toBe(expected[name]!.sql);
			expect('params' in result ? result.params : result.parameters).toEqual(
				expected[name]!.params,
			);
		});
	for (const kind of ['and', 'or'] as const) {
		for (const malformed of [
			{ kind: 'range', field: 'id' },
			{ kind: 'subquery', subquery: { type: 'select', from: 'posts' } },
			{ kind: 'unknown' },
		])
			it(`${kind} with ${malformed.kind} null child keeps omission`, () => {
				const condition = {
					kind,
					conditions: [malformed],
				} as unknown as WhereIntent;
				const decision = convertWhereCondition(condition, 'users');
				expect(decision).toBeNull();
				const result = compilePlan({
					rootTable: 'users',
					decisions: [
						{ type: 'select', column: '*' },
						...(decision ? [decision] : []),
					],
				});
				expect(result.sql).toBe('SELECT * FROM users');
				expect(result.parameters).toEqual([]);
			});
		it(`${kind} extractor with null child keeps omission`, () => {
			expect(
				convertWhereToDecisions(
					{ kind, conditions: [{ kind: 'subquery' }] },
					'users',
				),
			).toEqual([]);
		});
	}
});
