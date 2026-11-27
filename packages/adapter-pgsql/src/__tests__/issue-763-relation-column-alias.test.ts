import {
	createOrm,
	exists,
	exprRef,
	fn,
	POSTGRESQL_CAPABILITIES,
	plan,
	ref,
	relationColumn,
	schema,
} from '@dbsp/core';
import { compile } from '@dbsp/nql';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const issue763Schema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
	},
	files: {
		id: { type: 'integer', primaryKey: true },
		path: 'string',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		author_id: ref('users', { as: 'author', inverse: 'posts' }),
		file_id: ref('files', { as: 'file', inverse: 'posts' }),
	},
	articles: {
		id: { type: 'integer', primaryKey: true },
		editor_id: ref('users', { as: 'editor', inverse: 'edited_articles' }),
		author_id: ref('users', { as: 'author', inverse: 'authored_articles' }),
	},
	categories: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	products: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		category_id: ref('categories', { as: 'category', inverse: 'products' }),
	},
});

// Mirrors the blog model loaded by the reference-plan e2e without importing a
// file outside this package's TypeScript rootDir.
const e2eBlogSchema = schema({
	authors: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: 'string',
		email: { type: 'string', unique: true },
		bio: { type: 'text', nullable: true },
		createdAt: { type: 'timestamp', default: 'now()' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		title: 'string',
		slug: { type: 'string', unique: true },
		content: { type: 'text', nullable: true },
		published: { type: 'boolean', default: 'false', index: true },
		authorId: ref('authors', { onDelete: 'CASCADE', inverse: 'posts' }),
		createdAt: { type: 'timestamp', default: 'now()' },
		updatedAt: { type: 'timestamp', nullable: true },
	},
	comments: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		postId: ref('posts', { onDelete: 'CASCADE', inverse: 'comments' }),
		authorName: 'string',
		authorEmail: { type: 'string', nullable: true },
		content: 'text',
		approved: { type: 'boolean', default: 'false', index: true },
		createdAt: { type: 'timestamp', default: 'now()' },
	},
	tags: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: { type: 'string', unique: true },
		slug: { type: 'string', unique: true },
	},
	postTags: {
		postId: ref('posts', { onDelete: 'CASCADE' }),
		tagId: ref('tags', { onDelete: 'CASCADE' }),
	},
});

function orm() {
	const adapter = createPgCompileOnlyAdapter({
		model: issue763Schema.model,
	});
	return createOrm({ model: issue763Schema.model, adapter });
}

function e2eOrm() {
	const adapter = createPgCompileOnlyAdapter({
		model: e2eBlogSchema.model,
	});
	return createOrm({ model: e2eBlogSchema.model, adapter });
}

const missingAlias =
	'relation column "author"."name" has no emitted alias in this query';

function articleEditorAliasQuery(reverseJoins = false) {
	const query = (orm() as any).select('articles');
	const joined = reverseJoins
		? query.join('author', { as: 'editor' }).join('editor', { as: 'reviewer' })
		: query.join('editor', { as: 'reviewer' }).join('author', { as: 'editor' });
	return joined
		.columns([relationColumn('editor', 'email', 'editorEmail')])
		.dump().sql;
}

const nestedPathSchema = schema({
	files: {
		id: { type: 'integer', primaryKey: true },
		path: 'string',
	},
	callees: {
		id: { type: 'integer', primaryKey: true },
		file_id: ref('files', { as: 'file', inverse: 'callees' }),
	},
	owners: {
		id: { type: 'integer', primaryKey: true },
		file_id: ref('files', { as: 'file', inverse: 'owners' }),
	},
	calls: {
		id: { type: 'integer', primaryKey: true },
		callee_id: ref('callees', { as: 'callee', inverse: 'calls' }),
		owner_id: ref('owners', { as: 'owner', inverse: 'calls' }),
		file_id: ref('files', { as: 'file', inverse: 'calls' }),
	},
});

function nestedPathOrm() {
	const adapter = createPgCompileOnlyAdapter({
		model: nestedPathSchema.model,
	});
	return createOrm({ model: nestedPathSchema.model, adapter });
}

const noPayloadColumns = { type: 'fields', fields: [] } as const;

describe('issue 763: relation qualifiers require an emitted SQL alias', () => {
	it('keeps relation join inputs in scope and qualifies both ON keys', () => {
		expect(e2eOrm().select('authors').join('posts').dump().sql).toBe(
			'SELECT authors.* FROM authors JOIN posts AS posts ON authors.id = posts."authorId"',
		);
	});

	it('binds a relation path before a colliding emitted SQL alias', () => {
		expect(articleEditorAliasQuery()).toBe(
			'SELECT reviewer.email AS "editorEmail" FROM articles JOIN users AS reviewer ON articles.editor_id = reviewer.id JOIN users AS editor ON articles.author_id = editor.id',
		);
	});

	it('keeps a colliding relation path bound when the joins are reversed', () => {
		expect(articleEditorAliasQuery(true)).toBe(
			'SELECT reviewer.email AS "editorEmail" FROM articles JOIN users AS editor ON articles.author_id = editor.id JOIN users AS reviewer ON articles.editor_id = reviewer.id',
		);
	});

	it('refuses an ambiguous relation path only when a relation column asks for it', () => {
		expect(() =>
			(orm() as any)
				.select('articles')
				.join('author', { as: 'author_one' })
				.join('author', { as: 'author_two' })
				.columns([relationColumn('author', 'email', 'authorEmail')])
				.dump(),
		).toThrow(
			'relation column "author"."email" is ambiguous between emitted aliases "author_one" and "author_two"',
		);
	});

	it('allocates an ambiguous relation path without refusing raw emitted aliases', () => {
		expect(
			(orm() as any)
				.select('articles')
				.join('author', { as: 'author_one' })
				.join('author', { as: 'author_two' })
				.columns([exprRef('author_one.email')])
				.dump().sql,
		).toBe(
			'SELECT author_one.email FROM articles JOIN users AS author_one ON articles.author_id = author_one.id JOIN users AS author_two ON articles.author_id = author_two.id',
		);
	});

	it('resolves relationColumn through an include that emits a left join', () => {
		expect(
			orm()
				.select('products')
				.include('category', { join: 'left' })
				.columns([relationColumn('category', 'name', 'categoryName')])
				.dump().sql,
		).toBe(
			'SELECT category.name AS "category.categoryName", category.id AS __dbsp_presence_category FROM products LEFT JOIN categories AS category ON products.category_id = category.id',
		);
	});

	it('refuses a projected relation column with no joined relation', () => {
		expect(() =>
			orm()
				.select('posts')
				.columns([relationColumn('author', 'name', 'authorName')])
				.dump(),
		).toThrow(new Error(missingAlias));
	});

	it('refuses an ORDER BY relation column with no joined relation', () => {
		expect(() =>
			orm()
				.select('posts')
				.orderBy(relationColumn('author', 'name', 'authorName'), 'asc')
				.dump(),
		).toThrow(new Error(missingAlias));
	});

	it('keeps a root-qualified ORDER BY column on the root source', () => {
		expect(orm().select('posts').orderBy('posts.id').dump().sql).toBe(
			'SELECT posts.* FROM posts ORDER BY posts.id ASC',
		);
	});

	it('keeps a root-qualified GROUP BY column on the root source', () => {
		expect(orm().select('posts').groupBy(['posts.id']).dump().sql).toBe(
			'SELECT posts.* FROM posts GROUP BY posts.id',
		);
	});

	it('keeps a root-qualified DISTINCT ON column on the root source', () => {
		expect(orm().select('posts').distinctOn('posts.id').dump().sql).toBe(
			'SELECT DISTINCT ON (posts.id) posts.* FROM posts',
		);
	});

	it('refuses a function relation column with no joined relation', () => {
		expect(() =>
			orm()
				.select('posts')
				.columns([
					fn('upper', relationColumn('author', 'name', 'authorName')).as(
						'upperAuthorName',
					),
				])
				.dump(),
		).toThrow(new Error(missingAlias));
	});

	it('refuses a nested path when only a matching leaf alias was joined', () => {
		expect(() =>
			nestedPathOrm()
				.select('calls')
				.join('file')
				.columns([relationColumn('callee.file', 'path', 'path')])
				.dump(),
		).toThrow(
			new Error(
				'relation column "callee.file"."path" has no emitted alias in this query',
			),
		);
	});

	it('keeps an emitted nested path bound with and without a competing leaf path', () => {
		const calleeFilePath = () => [
			relationColumn('callee.file', 'path', 'calleeFilePath'),
		];
		const withoutCompeting = nestedPathOrm()
			.select('calls')
			.include('callee.file', { join: 'inner', select: noPayloadColumns })
			.columns(calleeFilePath())
			.dump();
		const withCompeting = nestedPathOrm()
			.select('calls')
			.include('callee.file', { join: 'inner', select: noPayloadColumns })
			.include('owner.file', { join: 'inner', select: noPayloadColumns })
			.columns(calleeFilePath())
			.dump();
		const competingFirst = nestedPathOrm()
			.select('calls')
			.include('owner.file', { join: 'inner', select: noPayloadColumns })
			.include('callee.file', { join: 'inner', select: noPayloadColumns })
			.columns(calleeFilePath())
			.dump();

		expect({
			withoutCompeting: withoutCompeting.sql,
			withCompeting: withCompeting.sql,
			competingFirst: competingFirst.sql,
		}).toEqual({
			withoutCompeting:
				'SELECT callee.id AS "callee.id", callee.file_id AS "callee.file_id", callee.id AS __dbsp_presence_callee, file.path AS "callee.file.calleeFilePath", file.id AS "__dbsp_presence_callee.file" FROM calls JOIN callees AS callee ON calls.callee_id = callee.id JOIN files AS file ON callee.file_id = file.id',
			withCompeting:
				'SELECT callee.id AS "callee.id", callee.file_id AS "callee.file_id", callee.id AS __dbsp_presence_callee, file.path AS "callee.file.calleeFilePath", file.id AS "__dbsp_presence_callee.file", owner.id AS "owner.id", owner.file_id AS "owner.file_id", owner.id AS __dbsp_presence_owner, file_1.id AS "__dbsp_presence_owner.file" FROM calls JOIN callees AS callee ON calls.callee_id = callee.id JOIN files AS file ON callee.file_id = file.id JOIN owners AS owner ON calls.owner_id = owner.id JOIN files AS file_1 ON owner.file_id = file_1.id',
			competingFirst:
				'SELECT owner.id AS "owner.id", owner.file_id AS "owner.file_id", owner.id AS __dbsp_presence_owner, file.id AS "__dbsp_presence_owner.file", callee.id AS "callee.id", callee.file_id AS "callee.file_id", callee.id AS __dbsp_presence_callee, file_1.path AS "callee.file.calleeFilePath", file_1.id AS "__dbsp_presence_callee.file" FROM calls JOIN owners AS owner ON calls.owner_id = owner.id JOIN files AS file ON owner.file_id = file.id JOIN callees AS callee ON calls.callee_id = callee.id JOIN files AS file_1 ON callee.file_id = file_1.id',
		});
		expect([
			withoutCompeting.params,
			withCompeting.params,
			competingFirst.params,
		]).toEqual([[], [], []]);
	});

	it('compiles a whole-relation projection consumed by a bare include', () => {
		expect(
			orm()
				.select('posts')
				.include('author')
				.columns([relationColumn('author', '*', 'authorData')])
				.dump().sql,
		).toBe(
			"SELECT COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'name', __t__.name, 'email', __t__.email) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts.author_id), '[]'::json) AS author_json FROM posts",
		);
	});

	// A bare include still consumes a flat relation column and emits
	// `${relation}_json` instead of the requested top-level alias, so the
	// missing-alias contract does not reach that path. Tracked in #793: the
	// predicate that would separate them refused documented NQL projections
	// such as `employees | select name, manager.name`, which an include does
	// emit, nested inside its aggregate.

	it('refuses dotted GROUP BY and DISTINCT ON relation qualifiers with no join', () => {
		expect(() => orm().select('posts').groupBy(['author.name']).dump()).toThrow(
			missingAlias,
		);
		expect(() =>
			orm().select('posts').distinctOn('author.name').dump(),
		).toThrow(missingAlias);
	});

	it('refuses qualified GROUP BY and DISTINCT ON when an include emits no outer alias', () => {
		expect(() =>
			orm().select('posts').include('author').groupBy(['author.name']).dump(),
		).toThrow(missingAlias);
		expect(() =>
			orm().select('posts').include('author').distinctOn('author.name').dump(),
		).toThrow(missingAlias);
	});

	it('refuses grouped join includes even with a via alias', () => {
		for (const field of ['files.path', 'file.path']) {
			expect(() =>
				orm()
					.select('posts')
					.include('files', { via: 'file', join: 'inner' })
					.groupBy([field])
					.dump(),
			).toThrow(
				"Invalid include: Include include[0](file) cannot use 'join' with aggregation, groupBy or DISTINCT because its data would be dropped. Use .join() for relational columns, grouping or ordering.",
			);
		}
	});
	it('refuses to project a relation column from a predicate without a join', () => {
		expect(() =>
			orm()
				.select('posts')
				.where(exists('author'))
				.columns([relationColumn('author', 'name', 'authorName')])
				.dump(),
		).toThrow(new Error(missingAlias));
	});

	it('refuses the unplanned M:N wildcard from the adapter entry point', () => {
		const parsed = compile('posts | select *, tags.*', e2eBlogSchema.model);
		if (!parsed.success || !parsed.ast?.query) {
			throw new Error(
				`NQL compilation failed: ${parsed.errors.map((error) => error.message).join(', ')}`,
			);
		}

		const planReport = plan(
			{ type: 'select', from: 'posts' },
			e2eBlogSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		expect(() =>
			createPgCompileOnlyAdapter().compile(
				{ ...planReport, intent: parsed.ast!.query! },
				{ model: e2eBlogSchema.model },
			),
		).toThrow(
			new Error(
				'Adapter compilation requires a report planned by this loaded copy of dbsp (plan(), the ORM or NQL); plan the query with this loaded copy',
			),
		);
	});
});
