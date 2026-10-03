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
		file_id: ref('files', { as: 'file', inverse: 'users' }),
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

const nestedSql = {
	json_agg:
		"SELECT COALESCE((SELECT json_agg(to_jsonb(__t__) || jsonb_build_object('file', COALESCE((SELECT json_agg(jsonb_build_object('fp', __t1__.path) ORDER BY __t1__.id ASC NULLS LAST) FROM files AS __t1__ WHERE __t1__.id = __t__.file_id), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts.author_id), '[]'::json) AS author_json FROM posts",
	lateral:
		'SELECT users_lat_0.*, files_lat_1.path AS fp FROM posts LEFT JOIN LATERAL (SELECT users_inner_0.* FROM users AS users_inner_0 WHERE users_inner_0.id = posts.author_id) AS users_lat_0 ON true LEFT JOIN LATERAL (SELECT files_inner_1.path FROM files AS files_inner_1 WHERE files_inner_1.id = users_lat_0.file_id) AS files_lat_1 ON true',
	join: 'SELECT file.path AS fp FROM posts JOIN users AS author ON posts.author_id = author.id JOIN files AS file ON author.file_id = file.id',
};
for (const strategy of ['json_agg', 'lateral', 'join'] as const) {
	const nested = (column: string) =>
		orm
			.select('posts')
			.withPlanOptions({ defaultIncludeStrategy: strategy })
			.include('author.file')
			.columns([relationColumn('author.file', column, 'fp')]);
	it(`nested ${strategy} projection`, () => {
		const result = nested('path').dump();
		expect(result.sql).toBe(nestedSql[strategy]);
		expect('params' in result && result.params).toEqual([]);
	});
	it(`nested ${strategy} invalid column`, () => {
		expect(() => nested('DOES_NOT_EXIST').dump()).toThrow(
			"Unknown column(s) 'DOES_NOT_EXIST' in relation 'file' (table 'files'). Available: id, path",
		);
	});
}

const thirdDepthSql = {
	json_agg:
		"SELECT COALESCE((SELECT json_agg(to_jsonb(__t__) || jsonb_build_object('file', COALESCE((SELECT json_agg(to_jsonb(__t1__) || jsonb_build_object('users', COALESCE((SELECT json_agg(jsonb_build_object('nestedName', __t2__.name) ORDER BY __t2__.id ASC NULLS LAST) FROM users AS __t2__ WHERE __t2__.file_id = __t1__.id), '[]'::json)) ORDER BY __t1__.id ASC NULLS LAST) FROM files AS __t1__ WHERE __t1__.id = __t__.file_id), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts.author_id), '[]'::json) AS author_json FROM posts",
	lateral:
		'SELECT users_lat_0.*, files_lat_1.*, users_lat_2.name AS "nestedName" FROM posts LEFT JOIN LATERAL (SELECT users_inner_0.* FROM users AS users_inner_0 WHERE users_inner_0.id = posts.author_id) AS users_lat_0 ON true LEFT JOIN LATERAL (SELECT files_inner_1.* FROM files AS files_inner_1 WHERE files_inner_1.id = users_lat_0.file_id) AS files_lat_1 ON true LEFT JOIN LATERAL (SELECT users_inner_2.name FROM users AS users_inner_2 WHERE users_inner_2.file_id = files_lat_1.id) AS users_lat_2 ON true',
	join: 'SELECT users.name AS "nestedName" FROM posts JOIN users AS author ON posts.author_id = author.id JOIN files AS file ON author.file_id = file.id LEFT JOIN users AS users ON file.id = users.file_id',
};
for (const strategy of ['json_agg', 'lateral', 'join'] as const) {
	it(`third-depth ${strategy} projection`, () => {
		const result = orm
			.select('posts')
			.withPlanOptions({ defaultIncludeStrategy: strategy })
			.include('author.file.users')
			.columns([relationColumn('author.file.users', 'name', 'nestedName')])
			.dump();
		expect(result.sql).toBe(thirdDepthSql[strategy]);
		expect('params' in result && result.params).toEqual([]);
	});
}

it('refuses an intermediate lateral projection that omits a child correlation key', () => {
	expect(() =>
		orm
			.select('posts')
			.withPlanOptions({ defaultIncludeStrategy: 'lateral' })
			.include('author.file.users')
			.columns([
				relationColumn('author.file', 'path', 'fp'),
				relationColumn('author.file.users', 'name', 'nestedName'),
			])
			.dump(),
	).toThrow(
		"Nested relation column projection 'author.file' cannot be compiled with lateral: child 'author.file.users' requires column(s) 'id'.",
	);
});

it('refuses a lateral ancestor projection that omits a nested consumer correlation key', () => {
	expect(() =>
		orm
			.select('posts')
			.withPlanOptions({ defaultIncludeStrategy: 'lateral' })
			.include('author.file')
			.columns([
				relationColumn('author', 'name', 'authorName'),
				relationColumn('author.file', 'path', 'fp'),
			])
			.dump(),
	).toThrow(
		"Nested relation column projection 'author' cannot be compiled with lateral: child 'author.file' requires column(s) 'file_id'.",
	);
});

it('refuses a JSON_AGG alias that collides with a child relation key', async () => {
	await expect(
		orm
			.select('posts')
			.withPlanOptions({ defaultIncludeStrategy: 'json_agg' })
			.include('author.file.users')
			.columns([relationColumn('author.file', 'path', 'users')])
			.all(),
	).rejects.toThrow(
		"JSON_AGG relation projection 'author.file' has conflicting output key 'users'.",
	);
});

it('refuses a root lateral projection that omits a child correlation key', () => {
	expect(() =>
		orm
			.select('posts')
			.withPlanOptions({ defaultIncludeStrategy: 'lateral' })
			.include('author.file')
			.columns([relationColumn('author', 'name', 'authorName')])
			.dump(),
	).toThrow(
		"Nested relation column projection 'author' cannot be compiled with lateral: child 'author.file' requires column(s) 'file_id'.",
	);
});

it('preserves a one-hop lateral alias', () => {
	const result = orm
		.select('posts')
		.withPlanOptions({ defaultIncludeStrategy: 'lateral' })
		.include('author')
		.columns([relationColumn('author', 'name', 'authorName')])
		.dump();
	expect(result.sql).toBe(
		'SELECT users_lat_0.name AS "authorName" FROM posts LEFT JOIN LATERAL (SELECT users_inner_0.name FROM users AS users_inner_0 WHERE users_inner_0.id = posts.author_id) AS users_lat_0 ON true',
	);
	expect('params' in result && result.params).toEqual([]);
});

it('refuses one relation source column requested under different aliases', () => {
	expect(() =>
		orm
			.select('posts')
			.include('author')
			.columns([
				relationColumn('author', 'name', 'a'),
				relationColumn('author', 'name', 'b'),
			])
			.dump(),
	).toThrow(
		"Relation column projection 'author' requests column 'name' with conflicting aliases 'a' and 'b'.",
	);
});

it('deduplicates the same relation source column and alias', () => {
	const result = orm
		.select('posts')
		.withPlanOptions({ defaultIncludeStrategy: 'lateral' })
		.include('author')
		.columns([
			relationColumn('author', 'name', 'a'),
			relationColumn('author', 'name', 'a'),
		])
		.dump();
	expect(result.sql).toBe(
		'SELECT users_lat_0.name AS a FROM posts LEFT JOIN LATERAL (SELECT users_inner_0.name FROM users AS users_inner_0 WHERE users_inner_0.id = posts.author_id) AS users_lat_0 ON true',
	);
	expect('params' in result && result.params).toEqual([]);
});
