import {
	and,
	createOrm,
	eq,
	every,
	exists,
	none,
	notExists,
	outerRef,
	POSTGRESQL_CAPABILITIES,
	plan,
	rawExists,
	ref,
	schema,
	some,
	subquery,
} from '@dbsp/core';
import type { PlanReport, WhereIntent } from '@dbsp/types';
import { expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		profileId: ref('profiles', { as: 'profile' }),
	},
	profiles: { id: { type: 'integer', primaryKey: true } },
	posts: {
		id: { type: 'integer', primaryKey: true },
		userId: ref('users', { inverse: 'posts' }),
	},
	fooSq: { id: { type: 'integer', primaryKey: true } },
	foo: { id: { type: 'integer', primaryKey: true }, foreignId: 'integer' },
});
const adapter = createPgCompileOnlyAdapter({ model: db.model });
const orm = createOrm({ schema: db, adapter });
const prefix =
	'SELECT users.*, profile.id AS "profile.id", profile.id AS __dbsp_presence_profile FROM users LEFT JOIN profiles AS profile ON users."profileId" = profile.id WHERE ';
const child = eq('id', outerRef('profile.id'));
const cases: [string, WhereIntent, string][] = [
	[
		'exists',
		exists('posts', { where: child }),
		'EXISTS (SELECT 1 FROM posts AS posts_exists_1 WHERE users.id = posts_exists_1."userId" AND posts_exists_1.id = profile.id)',
	],
	[
		'notExists',
		notExists('posts', { where: child }),
		'NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_1 WHERE users.id = posts_exists_1."userId" AND posts_exists_1.id = profile.id))',
	],
	[
		'some',
		some(orm.tables.users.posts, () => child),
		'EXISTS (SELECT 1 FROM posts AS posts_exists_1 WHERE users.id = posts_exists_1."userId" AND posts_exists_1.id = profile.id)',
	],
	[
		'every',
		every(orm.tables.users.posts, () => child),
		'NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_1 WHERE users.id = posts_exists_1."userId" AND NOT (posts_exists_1.id = profile.id)))',
	],
	[
		'none',
		none(orm.tables.users.posts, () => child),
		'NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_1 WHERE users.id = posts_exists_1."userId" AND posts_exists_1.id = profile.id))',
	],
	[
		'dotted',
		eq('posts.id', outerRef('profile.id')),
		'EXISTS (SELECT 1 FROM posts AS posts_exists_1 WHERE users.id = posts_exists_1."userId" AND posts_exists_1.id = profile.id)',
	],
	[
		'nested',
		exists('posts', {
			where: rawExists(
				subquery('foo')
					.select('id')
					.where(eq('id', outerRef('profile.id'))),
			),
		}),
		'EXISTS (SELECT 1 FROM posts AS posts_exists_1 WHERE users.id = posts_exists_1."userId" AND EXISTS (SELECT foo_sq.id FROM foo AS foo_sq WHERE foo_sq.id = profile.id))',
	],
];
for (const [name, predicate, sql] of cases)
	it(`root include scope ${name}`, () => {
		expect(
			orm
				.select('users')
				.include('profile', { join: 'left' })
				.where(predicate)
				.dump().sql,
		).toBe(prefix + sql);
	});
for (const dbCasing of ['snake_case', 'camelCase', 'preserve'] as const)
	it(`physical collision ${dbCasing}`, () => {
		const local = createPgCompileOnlyAdapter({ model: db.model, dbCasing });
		const report = plan(
			{
				type: 'select',
				from: 'fooSq',
				where: rawExists(
					subquery('foo')
						.select('id')
						.where(eq('foreignId', outerRef('fooSq.id'))),
				),
			},
			db.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const snake = dbCasing === 'snake_case';
		expect(local.compile(report).sql).toBe(
			snake
				? 'SELECT foo_sq.* FROM foo_sq WHERE EXISTS (SELECT foo_sq_1.id FROM foo AS foo_sq_1 WHERE foo_sq_1.foreign_id = foo_sq.id)'
				: 'SELECT "fooSq".* FROM "fooSq" WHERE EXISTS (SELECT foo_sq_1.id FROM foo AS foo_sq_1 WHERE foo_sq_1."foreignId" = "fooSq".id)',
		);
	});
function issued(where: WhereIntent): PlanReport {
	return plan({ type: 'select', from: 'users', where }, db.model);
}
for (const kind of ['futurePolicy', 'futurePolicy\nunsafe'])
	for (const nested of [false, true])
		it(`unknown issued kind ${JSON.stringify(kind)} ${nested}`, () => {
			const unknown = { kind } as unknown as WhereIntent;
			expect(() =>
				adapter.compile(issued(nested ? and(eq('id', 1), unknown) : unknown)),
			).toThrow(
				new Error(`processWhere: unhandled WhereIntent kind '${kind}'`),
			);
		});
it('hostile comparison operator refuses on one line', () => {
	const where = {
		kind: 'comparison',
		field: 'id',
		operator: '=\nunsafe',
		value: 1,
	} as unknown as WhereIntent;
	expect(() => adapter.compile(issued(where))).toThrow(
		new Error("Unsupported comparison operator '=\\nunsafe'"),
	);
});

for (const qualifier of ['users.id', 'peer.id', 'profile.id'])
	it(`root emitted range ${qualifier} beneath a relation and two subqueries`, () => {
		const result = orm
			.select('users')
			.join('profiles', { as: 'peer', on: eq('users.id', 1) })
			.include('profile', { join: 'left' })
			.where(
				exists('posts', {
					where: rawExists(
						subquery('foo')
							.select('id')
							.where(
								rawExists(
									subquery('profiles')
										.select('id')
										.where(eq('id', outerRef(qualifier))),
								),
							),
					),
				}),
			)
			.dump();
		expect(result.sql).toBe(
			`SELECT users.*, profile.id AS "profile.id", profile.id AS __dbsp_presence_profile FROM users JOIN profiles AS peer ON users.id = $1 LEFT JOIN profiles AS profile ON users."profileId" = profile.id WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_2 WHERE users.id = posts_exists_2."userId" AND EXISTS (SELECT foo_sq.id FROM foo AS foo_sq WHERE EXISTS (SELECT profiles_sq.id FROM profiles AS profiles_sq WHERE profiles_sq.id = ${qualifier})))`,
		);
		expect(result.params).toEqual([1]);
	});
