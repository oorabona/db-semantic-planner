import {
	caseWhen,
	createOrm,
	exists,
	literal,
	manyToMany,
	notExists,
	ref,
	schema,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

function buildOrm(withPostId: boolean) {
	const { model } = schema(
		{
			authors: { id: { type: 'integer', primaryKey: true } },
			posts: {
				id: { type: 'integer', primaryKey: true },
				authorId: ref('authors', { inverse: 'posts' }),
			},
			tags: {
				id: { type: 'integer', primaryKey: true },
				...(withPostId ? { postId: 'integer' as const } : {}),
			},
			postTags: { postId: ref('posts'), tagId: ref('tags') },
		},
		undefined,
		{
			relations: {
				posts: {
					tags: manyToMany('tags', {
						through: 'postTags',
						inverse: 'posts',
						sourceForeignKey: ['postId'],
						targetForeignKey: ['tagId'],
					}),
				},
			},
		},
	);
	return createOrm({ model, adapter: createPgCompileOnlyAdapter({ model }) });
}

function refusal(position: string) {
	return new Error(
		`${position} include('tags'): many-to-many traversal is not supported yet (#787).`,
	);
}

for (const withPostId of [false, true]) {
	describe(`predicate includes with tags.postId ${withPostId ? 'present' : 'absent'}`, () => {
		for (const predicate of [exists, notExists]) {
			const condition = predicate('posts', {
				include: { tags: { join: 'inner' } },
			});
			it(`${condition.kind} refuses WHERE include instead of lowering a has-many join`, () => {
				const orm = buildOrm(withPostId);
				expect(() =>
					orm.select('authors').where(condition).dump(),
				).toThrowError(refusal('WHERE'));
			});
			it(`${condition.kind} refuses HAVING include`, () => {
				const orm = buildOrm(withPostId);
				expect(() =>
					orm.select('authors').groupBy(['id']).having(condition).dump(),
				).toThrowError(refusal('HAVING'));
			});
			it(`${condition.kind} refuses CASE WHEN include`, () => {
				const orm = buildOrm(withPostId);
				expect(() =>
					orm
						.select('authors')
						.columns([
							caseWhen(condition, literal(1)).else(literal(0)).as('flag'),
						])
						.dump(),
				).toThrowError(refusal('CASE-WHEN'));
			});
		}
		it('refuses a nested include resolved from a previously joined table', () => {
			const orm = buildOrm(withPostId);
			expect(() =>
				orm
					.select('posts')
					.where(
						exists('author', {
							include: {
								posts: { join: 'inner' },
								tags: { join: 'inner' },
							},
						}),
					)
					.dump(),
			).toThrowError(refusal('WHERE'));
		});
		it('refuses includes inside a nested exists predicate', () => {
			const orm = buildOrm(withPostId);
			expect(() =>
				orm
					.select('posts')
					.where(
						exists('author', {
							where: exists('posts', { include: { tags: { join: 'inner' } } }),
						}),
					)
					.dump(),
			).toThrowError(refusal('WHERE'));
		});
	});
}
