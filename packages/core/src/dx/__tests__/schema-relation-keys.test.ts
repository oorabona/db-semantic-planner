import { resolveDeclaredRelationPath } from '@dbsp/types/internal';
import { expect, it } from 'vitest';
import { ref, schema } from '../schema.js';

it('resolves slug references in both directions without an id column', () => {
	const { model } = schema({
		users: { slug: { type: 'text', unique: true } },
		posts: {
			authorSlug: ref('users', {
				references: ['slug'],
				as: 'author',
				inverse: 'posts',
			}),
		},
	});
	for (const [source, relation, fromColumn, toColumn] of [
		['posts', 'author', 'authorSlug', 'slug'],
		['users', 'posts', 'slug', 'authorSlug'],
	] as const) {
		const result = resolveDeclaredRelationPath(model, source, [relation]);
		expect(result.ok && result.hops.map((hop) => hop.pairs)).toEqual([
			[{ fromColumn, toColumn }],
		]);
	}
	expect(model.getRelation('posts.author')?.targetKey).toEqual(['slug']);
	expect(model.getRelation('users.posts')?.sourceKey).toEqual(['slug']);
});

it('resolves a self-reference to a unique non-primary key', () => {
	const { model } = schema({
		nodes: {
			id: 'uuid',
			slug: { type: 'text', unique: true },
			parentSlug: ref('nodes', {
				references: ['slug'],
				nullable: true,
				roles: { parent: 'parent', children: 'children' },
			}),
		},
	});
	for (const [name, fromColumn, toColumn] of [
		['parent', 'parentSlug', 'slug'],
		['children', 'slug', 'parentSlug'],
	] as const) {
		const result = resolveDeclaredRelationPath(model, 'nodes', [name]);
		expect(result.ok && result.hops.map((hop) => hop.pairs)).toEqual([
			[{ fromColumn, toColumn }],
		]);
	}
	for (const name of ['parent', 'children', 'ancestors', 'descendants']) {
		expect(model.getRelation(`nodes.${name}`)).toMatchObject({
			sourceKey: ['slug'],
			targetKey: ['slug'],
		});
	}
});

it('resolves an ordinary ref using the documented id default', () => {
	const { model } = schema({
		users: {
			pk: { type: 'uuid', primaryKey: true },
			id: { type: 'uuid', unique: true },
		},
		posts: { authorId: ref('users') },
	});
	const result = resolveDeclaredRelationPath(model, 'posts', ['author']);
	expect(result.ok && result.hops.map((hop) => hop.pairs)).toEqual([
		[{ fromColumn: 'authorId', toColumn: 'id' }],
	]);
});

it('preserves composite reference order in both directions', () => {
	const { model } = schema(
		{
			users: { tenant: 'text', slug: 'text' },
			posts: { authorTenant: 'text', authorSlug: 'text' },
		},
		{
			users: { indexes: [{ columns: ['slug', 'tenant'], unique: true }] },
			posts: {
				foreignKeys: [
					ref('users', {
						columns: ['authorSlug', 'authorTenant'],
						references: ['slug', 'tenant'],
						as: 'author',
						inverse: 'posts',
					}),
				],
			},
		},
	);
	for (const [source, name, pairs] of [
		[
			'posts',
			'author',
			[
				{ fromColumn: 'authorSlug', toColumn: 'slug' },
				{ fromColumn: 'authorTenant', toColumn: 'tenant' },
			],
		],
		[
			'users',
			'posts',
			[
				{ fromColumn: 'slug', toColumn: 'authorSlug' },
				{ fromColumn: 'tenant', toColumn: 'authorTenant' },
			],
		],
	] as const) {
		const result = resolveDeclaredRelationPath(model, source, [name]);
		expect(result.ok && result.hops.map((hop) => hop.pairs)).toEqual([pairs]);
	}
});
