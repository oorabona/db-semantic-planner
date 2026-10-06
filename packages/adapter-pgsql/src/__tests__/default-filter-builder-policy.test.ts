import {
	createOrm,
	exists,
	isNull,
	plan,
	rawExists,
	ref,
	schema,
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
