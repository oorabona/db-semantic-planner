import {
	createOrm,
	exists,
	manyToMany,
	notExists,
	nqlRaw,
	ref,
	schema,
} from '@dbsp/core';
import { expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const model = schema(
	{
		authors: { id: 'integer' },
		posts: { id: 'integer', authorId: ref('authors', { inverse: 'posts' }) },
		tags: { id: 'integer', name: 'text' },
		postTags: { postId: ref('posts'), tagId: ref('tags') },
	},
	undefined,
	{
		relations: {
			posts: {
				tags: manyToMany('tags', {
					through: 'postTags',
					sourceForeignKey: ['postId'],
					targetForeignKey: ['tagId'],
					inverse: 'posts',
				}),
			},
		},
	},
).model;
const orm = createOrm({
	model,
	adapter: createPgCompileOnlyAdapter({ model }),
});
const refusal =
	"Relation 'posts.tags': many-to-many traversal is not supported yet (#787).";
it('refuses declared many-to-many fluent includes, join, and exists.include at planning', () => {
	for (const strategy of [
		'auto',
		'join',
		'json_agg',
		'lateral',
		'cte',
	] as const)
		expect(() =>
			orm
				.select('posts')
				.withPlanOptions({ defaultIncludeStrategy: strategy })
				.include('tags')
				.plan(),
		).toThrow(refusal);
	expect(() => orm.select('posts').join('tags').plan()).toThrow(refusal);
	expect(() =>
		orm
			.select('authors')
			.where(exists('posts', { include: { tags: { join: 'inner' } } }))
			.plan(),
	).toThrow(refusal);
	expect(() =>
		orm
			.select('authors')
			.where(notExists('posts', { include: { tags: { join: 'left' } } }))
			.plan(),
	).toThrow(refusal);
});
it('refuses declared many-to-many NQL relation columns and flat includes at planning', () => {
	for (const query of [
		'posts | select id, tags.name',
		'posts | select *, tags.*',
		'posts | select *, tags.* | flat',
		'posts | select *, tags.* | limit tags 2',
	])
		expect(() => orm.nql`${nqlRaw(query)}`.plan()).toThrow(refusal);
});
it('preserves the relation predicate refusal with a complete junction declaration', () => {
	expect(() => orm.select('posts').where(exists('tags')).dump()).toThrow(
		'many-to-many traversal is not supported yet (#787)',
	);
});
