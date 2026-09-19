import {
	createOrm,
	eq,
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
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const issue763Schema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
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
	const adapter = createPgsqlCompileOnlyAdapter({
		model: issue763Schema.model,
	});
	return createOrm({ model: issue763Schema.model, adapter });
}

const missingAlias =
	'relation column "author"."name" has no emitted alias in this query';

function nestedPathPlan(includeCompetingPath: boolean): SimplifiedPlanReport {
	return {
		rootTable: 'calls',
		decisions: [
			{
				type: 'includeStrategy',
				choice: 'join',
				joinType: 'inner',
				relationName: 'callee',
				relationPath: 'callee',
				targetTable: 'callees',
				sourceTable: 'calls',
				relationType: 'belongsTo',
				foreignKey: 'callee_id',
				parentKey: 'id',
				columns: [],
			},
			{
				type: 'includeStrategy',
				choice: 'join',
				joinType: 'inner',
				relationName: 'file',
				relationPath: 'callee.file',
				targetTable: 'files',
				sourceTable: 'callees',
				relationType: 'belongsTo',
				foreignKey: 'file_id',
				parentKey: 'id',
				columns: [],
			},
			...(includeCompetingPath
				? [
						{
							type: 'includeStrategy' as const,
							choice: 'join' as const,
							joinType: 'inner' as const,
							relationName: 'owner',
							relationPath: 'owner',
							targetTable: 'owners',
							sourceTable: 'calls',
							relationType: 'belongsTo' as const,
							foreignKey: 'owner_id',
							parentKey: 'id',
							columns: [],
						},
						{
							type: 'includeStrategy' as const,
							choice: 'join' as const,
							joinType: 'inner' as const,
							relationName: 'file',
							relationPath: 'owner.file',
							targetTable: 'files',
							sourceTable: 'owners',
							relationType: 'belongsTo' as const,
							foreignKey: 'file_id',
							parentKey: 'id',
							columns: [],
						},
					]
				: []),
			{
				type: 'selectRelationColumn',
				relation: 'callee.file',
				column: 'path',
				alias: 'calleeFilePath',
			},
		],
	};
}

describe('issue 763: relation qualifiers require an emitted SQL alias', () => {
	it('refuses a projected relation column with no joined relation', () => {
		expect(() =>
			orm()
				.select('posts')
				.columns([relationColumn('author', 'name', 'authorName')])
				.dump(),
		).toThrow(missingAlias);
	});

	it('refuses an ORDER BY relation column with no joined relation', () => {
		expect(() =>
			orm()
				.select('posts')
				.orderBy(relationColumn('author', 'name', 'authorName'), 'asc')
				.dump(),
		).toThrow(missingAlias);
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
		).toThrow(missingAlias);
	});

	it('refuses a nested path when only a matching leaf alias was joined', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'calls',
			decisions: [
				{
					type: 'includeStrategy',
					choice: 'join',
					joinType: 'inner',
					relationName: 'file',
					relationPath: 'file',
					targetTable: 'files',
					sourceTable: 'calls',
					relationType: 'belongsTo',
					foreignKey: 'file_id',
					parentKey: 'id',
					columns: [],
				},
				{
					type: 'selectRelationColumn',
					relation: 'callee.file',
					column: 'path',
					alias: 'path',
				},
			],
		};

		expect(() => compilePlan(plan)).toThrow(
			'relation column "callee.file"."path" has no emitted alias in this query',
		);
	});

	it('keeps an emitted nested path bound with and without a competing leaf path', () => {
		expect(compilePlan(nestedPathPlan(false)).sql).toBe(
			'SELECT file.path AS "calleeFilePath" FROM calls JOIN callees AS callee ON calls.callee_id = callee.id JOIN files AS file ON callee.file_id = file.id',
		);
		expect(compilePlan(nestedPathPlan(true)).sql).toBe(
			'SELECT file.path AS "calleeFilePath" FROM calls JOIN callees AS callee ON calls.callee_id = callee.id JOIN files AS file ON callee.file_id = file.id JOIN owners AS owner ON calls.owner_id = owner.id JOIN files AS file_1 ON owner.file_id = file_1.id',
		);
	});

	it('keeps include, relation join, and manual join relation columns bound', () => {
		const included = orm()
			.select('posts')
			.include('author')
			.columns([relationColumn('author', 'name', 'authorName')])
			.dump().sql;
		const relationJoined = orm()
			.select('posts')
			.join('author')
			.columns([relationColumn('author', 'name', 'authorName')])
			.dump().sql;
		const manuallyJoined = orm()
			.select('posts')
			.join('users', {
				as: 'author',
				on: eq('posts.author_id', exprRef('author.id')),
			})
			.columns([relationColumn('author', 'name', 'authorName')])
			.dump().sql;

		expect(included).toContain('AS author_json');
		expect(relationJoined).toContain('author.name AS "authorName"');
		expect(manuallyJoined).toContain('author.name AS "authorName"');
	});

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

	it('requires the emitted via alias instead of the include display name', () => {
		expect(() =>
			orm()
				.select('posts')
				.include('files', { via: 'file', join: 'inner' })
				.groupBy(['files.path'])
				.dump(),
		).toThrow(
			'relation column "files"."path" has no emitted alias in this query',
		);

		const sql = orm()
			.select('posts')
			.include('files', { via: 'file', join: 'inner' })
			.groupBy(['file.path'])
			.dump().sql;

		expect(sql).toContain('JOIN files AS file');
		expect(sql).toContain('GROUP BY file.path');
	});

	it('preallocates a filter join before its relation column is projected', () => {
		const result = compilePlan({
			rootTable: 'posts',
			decisions: [
				{
					type: 'selectRelationColumn',
					relation: 'author',
					column: 'name',
					alias: 'authorName',
				},
				{
					type: 'where',
					operator: 'exists',
					choice: 'join',
					relationName: 'author',
					targetTable: 'users',
					foreignKey: 'author_id',
					parentKey: 'id',
				},
			],
		});

		expect(result.sql).toContain('users.name AS "authorName"');
	});

	it('refuses caller-supplied qualifiers that have no emitted alias', () => {
		const forgedPlan = {
			rootTable: 'posts',
			decisions: [
				{
					type: 'selectRelationColumn' as const,
					relation: 'ghost',
					column: 'name',
				},
			],
		};
		Object.assign(forgedPlan, {
			boundRelationQualifiers: ['ghost'],
		});
		expect(() => compilePlan(forgedPlan)).toThrow(
			'relation column "ghost"."name" has no emitted alias in this query',
		);
	});

	it('refuses the unplanned M:N wildcard from the adapter entry point', () => {
		const parsed = compile('posts | select *, tags.*', e2eBlogSchema.model);
		if (!parsed.success || !parsed.ast?.query) {
			throw new Error(
				`NQL compilation failed: ${parsed.errors.map((error) => error.message).join(', ')}`,
			);
		}

		const planReport = plan(parsed.ast.query, e2eBlogSchema.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});
		expect(() =>
			createPgsqlCompileOnlyAdapter().compile(planReport, {
				model: e2eBlogSchema.model,
			}),
		).toThrow('relation column "tags"."*" has no emitted alias in this query');
	});
});
