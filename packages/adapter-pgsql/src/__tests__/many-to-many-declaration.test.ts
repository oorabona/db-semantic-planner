import {
	createOrm,
	exists,
	manyToMany,
	NotYetSupportedError,
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
const refusal = (position: 'include' | 'join') =>
	new NotYetSupportedError(
		"many-to-many traversal 'posts.tags'",
		position,
		787,
	);
it('refuses declared many-to-many fluent includes and join at planning', () => {
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
		).toThrow(refusal('include'));
	expect(() => orm.select('posts').join('tags').plan()).toThrow(
		refusal('join'),
	);
});
it('refuses declared many-to-many NQL relation columns and flat includes at planning', () => {
	for (const query of [
		'posts | select id, tags.name',
		'posts | select *, tags.*',
		'posts | select *, tags.* | flat',
		'posts | select *, tags.* | limit tags 2',
	])
		expect(() => orm.nql`${nqlRaw(query)}`.plan()).toThrow(refusal('include'));
});
it('preserves the relation predicate refusal with a complete junction declaration', () => {
	expect(() => orm.select('posts').where(exists('tags')).dump()).toThrow(
		new NotYetSupportedError(
			"many-to-many traversal exists('tags')",
			'WHERE condition',
			787,
		),
	);
});
