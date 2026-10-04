import {
	createOrm,
	nqlRaw,
	POSTGRESQL_CAPABILITIES,
	plan,
	ResultHydrator,
	ref,
	relationColumn,
	schema,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	files: { id: { type: 'integer', primaryKey: true }, path: 'string' },
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		firstName: 'string',
		lastName: 'string',
		// NQL currently validates a multi-hop leaf against the first-hop table.
		path: 'string',
		file_id: ref('files', { as: 'file', inverse: 'users', unique: true }),
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
			"SELECT COALESCE((SELECT json_agg(jsonb_build_object('authorName', __t__.name) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts.author_id), '[]'::json) AS author_json FROM posts",
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
			'SELECT author.name AS "author.authorName", author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts.author_id = author.id',
		);
		expect('params' in result && result.params).toEqual([]);
	});
	for (const flat of [false, true]) {
		it(`NQL emits the nested column with its exact path (${flat ? 'flat' : 'default'})`, () => {
			const result = flat
				? orm.nql`posts | select *, author.file.path as fp | flat`.dump()
				: orm.nql`posts | select *, author.file.path as fp`.dump();
			expect(result.sql).toBe(
				flat
					? 'SELECT posts.*, file.path AS fp FROM posts JOIN users AS author ON posts.author_id = author.id JOIN files AS file ON author.file_id = file.id'
					: 'SELECT posts.*, author.id AS __dbsp_presence_author, file.path AS fp, file.id AS "__dbsp_presence_author.file" FROM posts JOIN users AS author ON posts.author_id = author.id JOIN files AS file ON author.file_id = file.id',
			);
			expect('params' in result && result.params).toEqual([]);
		});
	}
	it('preserves NQL same-path SQL and params', () => {
		const result = orm.nql`posts | select *, author.name`.dump();
		expect(result.sql).toBe(
			'SELECT posts.*, author.name AS "author.name", author.id AS __dbsp_presence_author FROM posts JOIN users AS author ON posts.author_id = author.id',
		);
		expect('params' in result && result.params).toEqual([]);
	});
});

const nestedSql = {
	json_agg:
		"SELECT COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'name', __t__.name, 'firstName', __t__.\"firstName\", 'lastName', __t__.\"lastName\", 'path', __t__.path, 'file_id', __t__.file_id) || jsonb_build_object('file', COALESCE((SELECT json_agg(jsonb_build_object('fp', __t1__.path) ORDER BY __t1__.id ASC NULLS LAST) FROM files AS __t1__ WHERE __t1__.id = __t__.file_id), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts.author_id), '[]'::json) AS author_json FROM posts",
	lateral:
		'SELECT users_lat_0.id AS "author.id", users_lat_0.name AS "author.name", users_lat_0."firstName" AS "author.firstName", users_lat_0."lastName" AS "author.lastName", users_lat_0.path AS "author.path", users_lat_0.file_id AS "author.file_id", users_lat_0.__dbsp_presence_author AS __dbsp_presence_author, files_lat_1.path AS "author.file.fp", files_lat_1."__dbsp_presence_author.file" AS "__dbsp_presence_author.file" FROM posts LEFT JOIN LATERAL (SELECT users_inner_0.id, users_inner_0.name, users_inner_0."firstName", users_inner_0."lastName", users_inner_0.path, users_inner_0.file_id, users_inner_0.id AS __dbsp_presence_author FROM users AS users_inner_0 WHERE users_inner_0.id = posts.author_id) AS users_lat_0 ON true LEFT JOIN LATERAL (SELECT files_inner_1.path, files_inner_1.id AS "__dbsp_presence_author.file" FROM files AS files_inner_1 WHERE files_inner_1.id = users_lat_0.file_id) AS files_lat_1 ON true',
	join: 'SELECT author.id AS __dbsp_presence_author, file.path AS "author.file.fp", file.id AS "__dbsp_presence_author.file" FROM posts JOIN users AS author ON posts.author_id = author.id JOIN files AS file ON author.file_id = file.id',
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
		"SELECT COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'name', __t__.name, 'firstName', __t__.\"firstName\", 'lastName', __t__.\"lastName\", 'path', __t__.path, 'file_id', __t__.file_id) || jsonb_build_object('file', COALESCE((SELECT json_agg(jsonb_build_object('id', __t1__.id, 'path', __t1__.path) || jsonb_build_object('users', COALESCE((SELECT json_agg(jsonb_build_object('nestedName', __t2__.name) ORDER BY __t2__.id ASC NULLS LAST) FROM users AS __t2__ WHERE __t2__.file_id = __t1__.id), '[]'::json)) ORDER BY __t1__.id ASC NULLS LAST) FROM files AS __t1__ WHERE __t1__.id = __t__.file_id), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts.author_id), '[]'::json) AS author_json FROM posts",
	lateral:
		'SELECT users_lat_0.id AS "author.id", users_lat_0.name AS "author.name", users_lat_0."firstName" AS "author.firstName", users_lat_0."lastName" AS "author.lastName", users_lat_0.path AS "author.path", users_lat_0.file_id AS "author.file_id", users_lat_0.__dbsp_presence_author AS __dbsp_presence_author, files_lat_1.id AS "author.file.id", files_lat_1.path AS "author.file.path", files_lat_1."__dbsp_presence_author.file" AS "__dbsp_presence_author.file", users_lat_2.name AS "author.file.users.nestedName", users_lat_2."__dbsp_presence_author.file.users" AS "__dbsp_presence_author.file.users" FROM posts LEFT JOIN LATERAL (SELECT users_inner_0.id, users_inner_0.name, users_inner_0."firstName", users_inner_0."lastName", users_inner_0.path, users_inner_0.file_id, users_inner_0.id AS __dbsp_presence_author FROM users AS users_inner_0 WHERE users_inner_0.id = posts.author_id) AS users_lat_0 ON true LEFT JOIN LATERAL (SELECT files_inner_1.id, files_inner_1.path, files_inner_1.id AS "__dbsp_presence_author.file" FROM files AS files_inner_1 WHERE files_inner_1.id = users_lat_0.file_id) AS files_lat_1 ON true LEFT JOIN LATERAL (SELECT users_inner_2.name, users_inner_2.id AS "__dbsp_presence_author.file.users" FROM users AS users_inner_2 WHERE users_inner_2.file_id = files_lat_1.id) AS users_lat_2 ON true',
	join: 'SELECT author.id AS __dbsp_presence_author, file.id AS "__dbsp_presence_author.file", users.name AS "author.file.users.nestedName", users.id AS "__dbsp_presence_author.file.users" FROM posts JOIN users AS author ON posts.author_id = author.id JOIN files AS file ON author.file_id = file.id LEFT JOIN users AS users ON file.id = users.file_id',
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

it('retains correlation keys for an intermediate lateral projection that omits a child correlation key', () => {
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
	).not.toThrow();
});

it('retains correlation keys for a lateral ancestor projection that omits a nested consumer correlation key', () => {
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
	).not.toThrow();
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
		"Include payload 'author.file' has conflicting public key 'users'",
	);
});

it('retains correlation keys for a root lateral projection that omits a child correlation key', () => {
	expect(() =>
		orm
			.select('posts')
			.withPlanOptions({ defaultIncludeStrategy: 'lateral' })
			.include('author.file')
			.columns([relationColumn('author', 'name', 'authorName')])
			.dump(),
	).not.toThrow();
});

it('preserves a one-hop lateral alias', () => {
	const result = orm
		.select('posts')
		.withPlanOptions({ defaultIncludeStrategy: 'lateral' })
		.include('author')
		.columns([relationColumn('author', 'name', 'authorName')])
		.dump();
	expect(result.sql).toBe(
		'SELECT users_lat_0.name AS "author.authorName", users_lat_0.__dbsp_presence_author AS __dbsp_presence_author FROM posts LEFT JOIN LATERAL (SELECT users_inner_0.name, users_inner_0.id AS __dbsp_presence_author FROM users AS users_inner_0 WHERE users_inner_0.id = posts.author_id) AS users_lat_0 ON true',
	);
	expect('params' in result && result.params).toEqual([]);
});

it('permits one relation source column requested under different public keys', () => {
	expect(() =>
		orm
			.select('posts')
			.include('author')
			.columns([
				relationColumn('author', 'name', 'a'),
				relationColumn('author', 'name', 'b'),
			])
			.dump(),
	).not.toThrow();
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
		'SELECT users_lat_0.name AS "author.a", users_lat_0.__dbsp_presence_author AS __dbsp_presence_author FROM posts LEFT JOIN LATERAL (SELECT users_inner_0.name, users_inner_0.id AS __dbsp_presence_author FROM users AS users_inner_0 WHERE users_inner_0.id = posts.author_id) AS users_lat_0 ON true',
	);
	expect('params' in result && result.params).toEqual([]);
});

for (const strategy of ['json_agg', 'lateral', 'join'] as const) {
	it(`refuses shared relation output aliases with ${strategy}`, () => {
		expect(() =>
			orm
				.select('posts')
				.withPlanOptions({ defaultIncludeStrategy: strategy })
				.include('author.file')
				.columns([
					relationColumn('author.file', 'path', 'x'),
					relationColumn('author.file', 'id', 'x'),
				])
				.dump(),
		).toThrow("Include payload 'author.file' has conflicting public key 'x'");
	});
	it(`refuses an alias sharing a column-name output with ${strategy}`, () => {
		expect(() =>
			orm
				.select('posts')
				.withPlanOptions({ defaultIncludeStrategy: strategy })
				.include('author.file')
				.columns([
					relationColumn('author.file', 'path', 'id'),
					relationColumn('author.file', 'id', 'id'),
				])
				.dump(),
		).toThrow("Include payload 'author.file' has conflicting public key 'id'");
	});
}

it('uses JSON_AGG aliases at both top-level and nested includes', () => {
	const result = orm
		.select('posts')
		.withPlanOptions({ defaultIncludeStrategy: 'json_agg' })
		.include('author.file')
		.columns([
			relationColumn('author', 'name', 'authorName'),
			relationColumn('author.file', 'path', 'fp'),
		])
		.dump();
	expect(result.sql).toBe(
		"SELECT COALESCE((SELECT json_agg(jsonb_build_object('authorName', __t__.name) || jsonb_build_object('file', COALESCE((SELECT json_agg(jsonb_build_object('fp', __t1__.path) ORDER BY __t1__.id ASC NULLS LAST) FROM files AS __t1__ WHERE __t1__.id = __t__.file_id), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts.author_id), '[]'::json) AS author_json FROM posts",
	);
	expect('params' in result && result.params).toEqual([]);
});

it('refuses a top-level JSON_AGG alias that collides with a child key', () => {
	expect(() =>
		orm
			.select('posts')
			.withPlanOptions({ defaultIncludeStrategy: 'json_agg' })
			.include('author.file')
			.columns([relationColumn('author', 'name', 'file')])
			.dump(),
	).toThrow("Include payload 'author' has conflicting public key 'file'");
});

const departmentDb = schema({
	departments: { id: { type: 'integer', primaryKey: true } },
	employees: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		department_id: ref('departments', { inverse: 'employees' }),
	},
});
function compileNqlIncludes(
	query: string,
	model: typeof db.model,
	strategy: 'json_agg' | 'join' | 'lateral' = 'json_agg',
	dbCasing: 'preserve' | 'snake_case' = 'preserve',
) {
	const nqlOrm = createOrm({
		model,
		adapter: createPgCompileOnlyAdapter({ model }),
	});
	const intent = nqlOrm.nql`${nqlRaw(query)}`.toIntentIR();
	if (intent.type !== 'select') throw new Error('Expected a select query');
	const report = plan(intent, model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
		defaultIncludeStrategy: strategy,
	});
	return createPgCompileOnlyAdapter({ model, dbCasing }).compile(report, {
		model,
	});
}

it('preserves distinct declared and explicit public keys under snake_case', () => {
	const query = compileNqlIncludes(
		'posts | select author.firstName, author.lastName as first_name',
		db.model,
		'json_agg',
		'snake_case',
	);
	expect(query.sql).toBe(
		"SELECT COALESCE((SELECT json_agg(jsonb_build_object('firstName', __t__.first_name, 'first_name', __t__.last_name) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts.author_id), '[]'::json) AS author_json FROM posts",
	);
	const rows = [
		{ author_json: [{ firstName: 'Ada', first_name: 'Lovelace' }] },
	];
	const report =
		orm.nql`posts | select author.firstName, author.lastName as first_name`.plan();
	new ResultHydrator(db.model, 'posts').hydrateJsonAggIncludes(
		rows,
		report,
		query,
	);
	expect(rows).toEqual([
		{ author: { firstName: 'Ada', first_name: 'Lovelace' } },
	]);
});

it('retains correlation keys needed by nested lateral consumers', () => {
	const result = orm
		.select('posts')
		.withPlanOptions({ defaultIncludeStrategy: 'lateral' })
		.include('author.file')
		.columns([
			relationColumn('author', 'name', 'authorName'),
			relationColumn('author.file', 'path', 'fp'),
		])
		.dump();
	expect(result.sql).toBe(
		'SELECT users_lat_0.name AS "author.authorName", users_lat_0.__dbsp_presence_author AS __dbsp_presence_author, files_lat_1.path AS "author.file.fp", files_lat_1."__dbsp_presence_author.file" AS "__dbsp_presence_author.file" FROM posts LEFT JOIN LATERAL (SELECT users_inner_0.name, users_inner_0.file_id, users_inner_0.id AS __dbsp_presence_author FROM users AS users_inner_0 WHERE users_inner_0.id = posts.author_id) AS users_lat_0 ON true LEFT JOIN LATERAL (SELECT files_inner_1.path, files_inner_1.id AS "__dbsp_presence_author.file" FROM files AS files_inner_1 WHERE files_inner_1.id = users_lat_0.file_id) AS files_lat_1 ON true',
	);
});

it('uses the column name for a to-many NQL default JSON key', () => {
	const result = compileNqlIncludes(
		'departments | select id, employees.name',
		departmentDb.model,
	);
	expect(result.sql).toBe(
		"SELECT departments.id, COALESCE((SELECT json_agg(jsonb_build_object('name', __t__.name) ORDER BY __t__.id ASC NULLS LAST) FROM employees AS __t__ WHERE __t__.department_id = departments.id), '[]'::json) AS employees_json FROM departments",
	);
	expect(result.parameters).toEqual([]);
});

it('uses the column name for a two-hop NQL default JSON key', () => {
	const result = compileNqlIncludes(
		'posts | select author.file.path',
		db.model,
	);
	expect(result.sql).toBe(
		"SELECT COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'name', __t__.name, 'firstName', __t__.\"firstName\", 'lastName', __t__.\"lastName\", 'path', __t__.path, 'file_id', __t__.file_id) || jsonb_build_object('file', COALESCE((SELECT json_agg(jsonb_build_object('path', __t1__.path) ORDER BY __t1__.id ASC NULLS LAST) FROM files AS __t1__ WHERE __t1__.id = __t__.file_id), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts.author_id), '[]'::json) AS author_json FROM posts",
	);
	expect(result.parameters).toEqual([]);
});

for (const strategy of ['join', 'lateral'] as const) {
	it(`preserves distinct NQL default and chosen labels with ${strategy}`, () => {
		const result = compileNqlIncludes(
			'posts | select author.name, author.id as name | flat',
			db.model,
			strategy,
		);
		expect(result.sql).toBe(
			strategy === 'join'
				? 'SELECT author.name AS "author.name", author.id AS name FROM posts JOIN users AS author ON posts.author_id = author.id'
				: 'SELECT users_lat_0.name AS "author.name", users_lat_0.id AS name FROM posts LEFT JOIN LATERAL (SELECT users_inner_0.name, users_inner_0.id FROM users AS users_inner_0 WHERE users_inner_0.id = posts.author_id) AS users_lat_0 ON true',
		);
		expect(result.parameters).toEqual([]);
	});
}

it('keeps declared names distinct from aliases equal to physical names', () => {
	expect(() =>
		compileNqlIncludes(
			'posts | select author.firstName, author.lastName as first_name',
			db.model,
			'json_agg',
			'snake_case',
		),
	).not.toThrow();
});

it('returns both public aliases of one source without ambiguous lateral columns', () => {
	const result = orm
		.select('posts')
		.withPlanOptions({ defaultIncludeStrategy: 'lateral' })
		.include('author')
		.columns([
			relationColumn('author', 'name', 'a'),
			relationColumn('author', 'name', 'b'),
		])
		.dump();
	expect(result.sql).toBe(
		'SELECT users_lat_0.name AS "author.a", users_lat_0.name AS "author.b", users_lat_0.__dbsp_presence_author AS __dbsp_presence_author FROM posts LEFT JOIN LATERAL (SELECT users_inner_0.name, users_inner_0.id AS __dbsp_presence_author FROM users AS users_inner_0 WHERE users_inner_0.id = posts.author_id) AS users_lat_0 ON true',
	);
});

it('retains correlation keys at intermediate lateral depths', () => {
	const result = orm
		.select('posts')
		.withPlanOptions({ defaultIncludeStrategy: 'lateral' })
		.include('author.file.users')
		.columns([
			relationColumn('author.file', 'path', 'fp'),
			relationColumn('author.file.users', 'name', 'nestedName'),
		])
		.dump();
	expect(result.sql).toBe(
		thirdDepthSql.lateral
			.replace(
				'files_lat_1.id AS "author.file.id", files_lat_1.path AS "author.file.path"',
				'files_lat_1.path AS "author.file.fp"',
			)
			.replace(
				'SELECT files_inner_1.id, files_inner_1.path',
				'SELECT files_inner_1.path, files_inner_1.id',
			),
	);
});
it('retains correlation keys when a root lateral payload is projected', () => {
	const result = orm
		.select('posts')
		.withPlanOptions({ defaultIncludeStrategy: 'lateral' })
		.include('author.file')
		.columns([relationColumn('author', 'name', 'authorName')])
		.dump();
	expect(result.sql).toBe(
		'SELECT users_lat_0.name AS "author.authorName", users_lat_0.__dbsp_presence_author AS __dbsp_presence_author, files_lat_1.id AS "author.file.id", files_lat_1.path AS "author.file.path", files_lat_1."__dbsp_presence_author.file" AS "__dbsp_presence_author.file" FROM posts LEFT JOIN LATERAL (SELECT users_inner_0.name, users_inner_0.file_id, users_inner_0.id AS __dbsp_presence_author FROM users AS users_inner_0 WHERE users_inner_0.id = posts.author_id) AS users_lat_0 ON true LEFT JOIN LATERAL (SELECT files_inner_1.id, files_inner_1.path, files_inner_1.id AS "__dbsp_presence_author.file" FROM files AS files_inner_1 WHERE files_inner_1.id = users_lat_0.file_id) AS files_lat_1 ON true',
	);
});
