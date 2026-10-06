import {
	caseWhen,
	createOrm,
	exists,
	fn,
	isNull,
	literal,
	plan,
	rawExists,
	ref,
	schema,
	star,
} from '@dbsp/core';
import { rawNotExists } from '@dbsp/core/internal';
import type { QueryIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema(
	{
		users: {
			id: { type: 'integer', primaryKey: true },
			deletedAt: { type: 'timestamp', nullable: true },
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			deletedAt: { type: 'timestamp', nullable: true },
		},
		comments: {
			id: { type: 'integer', primaryKey: true },
			deletedAt: { type: 'timestamp', nullable: true },
			postId: ref('posts', { inverse: 'comments' }),
		},
		toString: { id: { type: 'integer', primaryKey: true } },
	},
	undefined,
	{
		defaultFilters: {
			users: isNull('deletedAt'),
			posts: isNull('deletedAt'),
			comments: isNull('deletedAt'),
		},
	},
);
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter() });

describe('nested builder filter ownership', () => {
	for (const [name, predicate, sql] of [
		[
			'rawExists',
			rawExists,
			'EXISTS (SELECT posts_sq.id FROM posts AS posts_sq)',
		],
		[
			'rawNotExists',
			rawNotExists,
			'NOT (EXISTS (SELECT posts_sq.id FROM posts AS posts_sq))',
		],
	] as const) {
		it(`${name} preserves the nested opt-out`, () => {
			expect(
				orm
					.select('users')
					.where(
						predicate(
							orm
								.select('posts')
								.columns(['id'])
								.withoutDefaultFilters() as unknown as {
								buildIntent(): QueryIntent;
							},
						),
					)
					.dump().sql,
			).toBe(
				`SELECT users.* FROM users WHERE users."deletedAt" IS NULL AND ${sql}`,
			);
		});
	}
	for (const [name, predicate] of Object.entries({ rawExists, rawNotExists })) {
		for (const position of [
			'CASE',
			'ORDER BY',
			'HAVING',
			'aggregate FILTER',
		] as const) {
			it(`${name} owns its policy in ${position} in both directions`, () => {
				for (const innerFiltered of [false, true]) {
					const inner = orm.select('posts').columns(['id']);
					const condition = predicate(
						(innerFiltered
							? inner
							: inner.withoutDefaultFilters()) as unknown as {
							buildIntent(): QueryIntent;
						},
					);
					const outer = innerFiltered
						? orm.withoutDefaultFilters().select('users')
						: orm.select('users');
					const expression = caseWhen(condition, literal(1)).else(literal(0));
					const query =
						position === 'CASE'
							? outer.columns([expression.as('hasPosts')])
							: position === 'ORDER BY'
								? outer.orderBy(expression)
								: position === 'HAVING'
									? outer.count().having(condition)
									: outer.columns([
											fn('count', star()).filter(condition).as('visibleCount'),
										]);
					const existsSql = `EXISTS (SELECT posts_sq.id FROM posts AS posts_sq${innerFiltered ? ' WHERE posts_sq."deletedAt" IS NULL' : ''})`;
					const predicateSql =
						name === 'rawExists' ? existsSql : `NOT (${existsSql})`;
					const caseSql = `CASE WHEN ${predicateSql} THEN 1 ELSE 0 END`;
					const rootWhere = innerFiltered
						? ''
						: ' WHERE users."deletedAt" IS NULL';
					const expected =
						position === 'CASE'
							? `SELECT ${caseSql} AS "hasPosts" FROM users${rootWhere}`
							: position === 'ORDER BY'
								? `SELECT users.* FROM users${rootWhere} ORDER BY ${caseSql} ASC`
								: position === 'HAVING'
									? `SELECT count(*) FROM users${rootWhere} HAVING ${predicateSql}`
									: `SELECT count(*) FILTER (WHERE ${predicateSql}) AS "visibleCount" FROM users${rootWhere}`;
					expect(query.dump().sql).toBe(expected);
				}
			});
		}
	}

	it('keeps filters on nested relation scans inside an opted-out outer builder', () => {
		expect(
			orm
				.select('users')
				.withoutDefaultFilters()
				.where(
					rawExists(
						orm
							.select('posts')
							.columns(['id'])
							.where(exists('comments')) as unknown as {
							buildIntent(): QueryIntent;
						},
					),
				)
				.dump().sql,
		).toBe(
			'SELECT users.* FROM users WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE EXISTS (SELECT 1 FROM comments AS comments_exists_0 WHERE posts_sq.id = comments_exists_0."postId" AND comments_exists_0."deletedAt" IS NULL) AND posts_sq."deletedAt" IS NULL)',
		);
	});
});

describe('own-property filter maps', () => {
	it('does not use a prototype property as a direct scan filter', () => {
		// Compile options can enter without schema's normalized map.
		expect(
			createPgCompileOnlyAdapter().compile(
				plan({ type: 'select', from: 'toString' }, db.model, {
					defaultFilters: { posts: isNull('deletedAt') },
				}),
			).sql,
		).toBe('SELECT "toString".* FROM "toString"');
		expect(orm.select('toString').dump().sql).toBe(
			'SELECT "toString".* FROM "toString"',
		);
	});
	it('does not use a prototype property after rebuilding an NQL binding map', () => {
		expect(orm.nql`posts | select id | bind p\ntoString`.dump().sql).toBe(
			'WITH "p" as (SELECT posts.id FROM posts WHERE posts."deletedAt" IS NULL) SELECT "toString".* FROM "toString"',
		);
	});
});
