import { and, createOrm, eq, exists, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const model = schema({
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', { as: 'author' }),
	},
	users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
	roots: {
		id: { type: 'integer', primaryKey: true },
		targetId: ref('targets', { as: 'roots' }),
	},
	targets: { id: { type: 'integer', primaryKey: true } },
}).model;
const orm = createOrm({
	model,
	adapter: createPgCompileOnlyAdapter({ model }),
});
const existsSql =
	'SELECT posts.* FROM posts WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts."authorId" = users_exists_0.id)';

describe('#891 relation predicates always use EXISTS', () => {
	it('bare exists has exact SQL and an EXISTS decision without alternatives', () => {
		const dump = orm.select('posts').where(exists('author')).dump();
		expect(dump.sql).toBe(existsSql);
		expect(dump.params).toEqual([]);
		expect(
			dump.plan?.decisions.filter((d) => d.type === 'filter-strategy'),
		).toMatchObject([{ choice: 'exists', alternatives: [] }]);
	});
	it('filtered exists has exact SQL and an EXISTS decision without alternatives', () => {
		const dump = orm
			.select('posts')
			.where(exists('author', { where: eq('name', 'a') }))
			.dump();
		expect(dump.sql).toBe(
			'SELECT posts.* FROM posts WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts."authorId" = users_exists_0.id AND users_exists_0.name = $1)',
		);
		expect(dump.params).toEqual(['a']);
		expect(
			dump.plan?.decisions.filter((d) => d.type === 'filter-strategy'),
		).toMatchObject([{ choice: 'exists', alternatives: [] }]);
	});
	it('root and relation names collide without duplicate SQL ranges', () => {
		const dump = orm
			.select('roots')
			.where(exists('roots', { where: eq('id', 1) }))
			.dump();
		expect(dump.sql).toBe(
			'SELECT roots.* FROM roots WHERE EXISTS (SELECT 1 FROM targets AS targets_exists_0 WHERE roots."targetId" = targets_exists_0.id AND targets_exists_0.id = $1)',
		);
		expect(dump.params).toEqual([1]);
	});
	it('AND plan and SQL agree', () => {
		const dump = orm
			.select('posts')
			.where(and(exists('author'), eq('id', 1)))
			.dump();
		expect(dump.sql).toBe(`${existsSql} AND posts.id = $1`);
		expect(
			dump.plan?.decisions.filter((d) => d.type === 'filter-strategy'),
		).toMatchObject([{ choice: 'exists', alternatives: [] }]);
	});
	it('predicate does not expose a DISTINCT ON alias; explicit join does', () => {
		expect(() =>
			orm
				.select('posts')
				.where(exists('author'))
				.distinctOn('author.name')
				.dump(),
		).toThrow(
			'relation column "author"."name" has no emitted alias in this query',
		);
		expect(
			orm.select('posts').join('author').distinctOn('author.name').dump().sql,
		).toBe(
			'SELECT DISTINCT ON (author.name) posts.* FROM posts JOIN users AS author ON posts."authorId" = author.id',
		);
	});

	it('predicate does not expose an ORDER BY alias; explicit join does', () => {
		expect(() =>
			orm.select('posts').where(exists('author')).orderBy('author.name').dump(),
		).toThrow(
			'relation column "author"."name" has no emitted alias in this query',
		);
		expect(
			orm.select('posts').join('author').orderBy('author.name').dump().sql,
		).toBe(
			'SELECT posts.* FROM posts JOIN users AS author ON posts."authorId" = author.id ORDER BY author.name ASC',
		);
	});
});
