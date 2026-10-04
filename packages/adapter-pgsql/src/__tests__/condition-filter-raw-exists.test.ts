import {
	createOrm,
	fn,
	like,
	rangeOverlaps,
	rawExists,
	schema,
	star,
	subquery,
} from '@dbsp/core';
import { expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	users: { id: { type: 'integer', primaryKey: true } },
	posts: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		period: { type: 'daterange' },
	},
} as const);
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});

it('keeps LIKE ESCAPE inside raw EXISTS inside a HAVING aggregate FILTER', () => {
	const result = orm
		.select('users')
		.having(
			fn('count', star())
				.filter(
					rawExists(
						subquery('posts')
							.select('id')
							.where(like('name', 'c!_%', { escape: '!' })),
					),
				)
				.gt(0),
		)
		.dump();
	expect(result.sql).toBe(
		'SELECT users.* FROM users HAVING count(*) FILTER (WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.name LIKE $1 ESCAPE $2)) > $3',
	);
	expect(result.params).toEqual(['c!_%', '!', 0]);
});

it('compiles a range inside raw EXISTS inside a HAVING aggregate FILTER', () => {
	const result = orm
		.select('users')
		.having(
			fn('count', star())
				.filter(
					rawExists(
						subquery('posts')
							.select('id')
							.where(
								rangeOverlaps('period', {
									lower: '2026-01-01',
									upper: '2026-02-01',
								}),
							),
					),
				)
				.gt(0),
		)
		.dump();
	expect(result.sql).toBe(
		'SELECT users.* FROM users HAVING count(*) FILTER (WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.period && CAST($1 AS daterange))) > $2',
	);
	expect(result.params).toEqual(['[2026-01-01,2026-02-01)', 0]);
});
