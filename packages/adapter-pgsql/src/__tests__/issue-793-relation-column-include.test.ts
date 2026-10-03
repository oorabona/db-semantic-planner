import { createOrm, ref, relationColumn, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	files: { id: { type: 'integer', primaryKey: true }, path: 'string' },
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		// NQL currently validates a multi-hop leaf against the first-hop table.
		path: 'string',
		file_id: ref('files', { as: 'file' }),
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		author_id: ref('users', { as: 'author' }),
	},
});
const orm = createOrm({
	model: db.model,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});
const missingAlias =
	'relation column "author.file"."path" has no emitted alias in this query';

describe('#793 exact include consumption', () => {
	for (const join of [undefined, 'left', 'inner'] as const) {
		it(`refuses an unconsumed descendant next to ${join ?? 'bare'} include`, () => {
			expect(() =>
				orm
					.select('posts')
					.include('author', join ? { join } : {})
					.columns([relationColumn('author.file', 'path', 'fp')])
					.dump(),
			).toThrow(new Error(missingAlias));
		});
	}
	it('preserves bare same-path nested projection and params', () => {
		const result = orm
			.select('posts')
			.include('author')
			.columns([relationColumn('author', 'name', 'authorName')])
			.dump();
		expect(result.sql).toBe(
			"SELECT COALESCE((SELECT json_agg(jsonb_build_object('name', __t__.name) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts.author_id), '[]'::json) AS author_json FROM posts",
		);
		expect('params' in result && result.params).toEqual([]);
	});
	it('preserves join same-path flat projection and params', () => {
		const result = orm
			.select('posts')
			.include('author', { join: 'left' })
			.columns([relationColumn('author', 'name', 'authorName')])
			.dump();
		expect(result.sql).toBe(
			'SELECT author.name AS "authorName" FROM posts LEFT JOIN users AS author ON posts.author_id = author.id',
		);
		expect('params' in result && result.params).toEqual([]);
	});
	for (const flat of [false, true]) {
		it(`NQL emits the nested column with its exact path (${flat ? 'flat' : 'default'})`, () => {
			const result = flat
				? orm.nql`posts | select *, author.file.path as fp | flat`.dump()
				: orm.nql`posts | select *, author.file.path as fp`.dump();
			expect(result.sql).toBe(
				'SELECT posts.*, file.path AS fp FROM posts JOIN users AS author ON posts.author_id = author.id JOIN files AS file ON author.file_id = file.id',
			);
			expect('params' in result && result.params).toEqual([]);
		});
	}
	it('preserves NQL same-path SQL and params', () => {
		const result = orm.nql`posts | select *, author.name`.dump();
		expect(result.sql).toBe(
			'SELECT posts.*, author.name AS "author.name" FROM posts JOIN users AS author ON posts.author_id = author.id',
		);
		expect('params' in result && result.params).toEqual([]);
	});
});
