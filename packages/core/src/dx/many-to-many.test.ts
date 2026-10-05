import { expect, it } from 'vitest';
import { plan } from '../planner.js';
import {
	manyToMany,
	ref,
	type SchemaDefinition,
	type SchemaOptions,
	SchemaValidationError,
	schema,
} from './schema.js';

const definition: SchemaDefinition = {
	posts: { id: 'integer' },
	tags: { id: 'integer', name: 'text' },
	postTags: { postId: ref('posts'), tagId: ref('tags') },
};
const options = (
	source = 'posts',
	name = 'tags',
	target = 'tags',
	through = 'postTags',
	inverse = 'posts',
	sourceForeignKey = ['postId'],
	targetForeignKey = ['tagId'],
): SchemaOptions => ({
	relations: {
		[source]: {
			[name]: manyToMany(target, {
				through,
				inverse,
				sourceForeignKey,
				targetForeignKey,
			}),
		},
	},
});
it('emits exact forward and inverse declarations', () => {
	const model = schema(definition, undefined, options()).model;
	const common = {
		type: 'belongsToMany',
		through: 'postTags',
		cardinality: 'many',
		optionality: 'optional',
		includeStrategy: 'auto',
		filterStrategy: 'auto',
		joinDefault: 'auto',
	};
	expect(model.getRelation('posts.tags')).toEqual({
		...common,
		name: 'tags',
		source: 'posts',
		target: 'tags',
		foreignKey: ['postId'],
		otherKey: ['tagId'],
		throughSourceKey: ['postId'],
		throughTargetKey: ['tagId'],
		sourceKey: ['id'],
		targetKey: ['id'],
	});
	expect(model.getRelation('tags.posts')).toEqual({
		...common,
		name: 'posts',
		source: 'tags',
		target: 'posts',
		foreignKey: ['tagId'],
		otherKey: ['postId'],
		throughSourceKey: ['tagId'],
		throughTargetKey: ['postId'],
		sourceKey: ['id'],
		targetKey: ['id'],
	});
});
for (const [name, opts, message] of [
	['unknown source', options('missing'), "unknown source table 'missing'"],
	[
		'unknown target',
		options('posts', 'tags', 'missing'),
		"unknown target table 'missing'",
	],
	[
		'unknown junction',
		options('posts', 'tags', 'tags', 'missing'),
		"unknown junction table 'missing'",
	],
	[
		'wrong foreign key',
		options('posts', 'tags', 'tags', 'postTags', 'posts', ['tagId']),
		'not a declared foreign key',
	],
	[
		'arity mismatch',
		options('posts', 'tags', 'tags', 'postTags', 'posts', []),
		'arity mismatch',
	],
	[
		'column collision',
		options('posts', 'id'),
		"relation name 'posts.id' collides",
	],
	[
		'inverse collision',
		options('posts', 'tags', 'tags', 'postTags', 'name'),
		"relation name 'tags.name' collides",
	],
	['relation collision', options('posts', 'post_postTags'), 'collides'],
] as const)
	it(`rejects ${name} by name`, () => {
		const build = () => schema(definition, undefined, opts);
		expect(build).toThrow(SchemaValidationError);
		expect(build).toThrow(message);
	});
it('rejects a junction without pair uniqueness', () => {
	expect(() =>
		schema(
			{
				...definition,
				postTags: { id: 'integer', postId: ref('posts'), tagId: ref('tags') },
			},
			undefined,
			options(),
		),
	).toThrow(
		"junction 'postTags' foreign keys are not covered by a primary key or unique constraint",
	);
});
it('accepts a junction with an explicit unique index', () => {
	expect(
		schema(
			{
				...definition,
				postTags: { id: 'integer', postId: ref('posts'), tagId: ref('tags') },
			},
			{
				postTags: { indexes: [{ columns: ['postId', 'tagId'], unique: true }] },
			},
			options(),
		).model.getRelation('posts.tags')?.type,
	).toBe('belongsToMany');
});
it('refuses every include strategy at planning', () => {
	const model = schema(definition, undefined, options()).model;
	for (const strategy of [
		'auto',
		'join',
		'json_agg',
		'lateral',
		'cte',
		'flat',
	] as const)
		expect(() =>
			plan(
				{
					type: 'select',
					from: 'posts',
					include: [
						{
							relation: 'tags',
							...(strategy === 'flat' ? { strategy: 'flat' as const } : {}),
						},
					],
				},
				model,
				{ defaultIncludeStrategy: strategy === 'flat' ? 'auto' : strategy },
			),
		).toThrow(
			"Relation 'posts.tags': many-to-many traversal is not supported yet (#787).",
		);
});
it('refuses a relation join at planning', () => {
	const model = schema(definition, undefined, options()).model;
	expect(() =>
		plan(
			{
				type: 'select',
				from: 'posts',
				joins: [{ relation: 'tags', type: 'inner' }],
			},
			model,
		),
	).toThrow(
		"Relation 'posts.tags': many-to-many traversal is not supported yet (#787).",
	);
});
it('retains ordered composite referenced keys on both directions', () => {
	const model = schema(
		{
			posts: {
				tenant: { type: 'integer', primaryKey: true },
				code: { type: 'text', primaryKey: true },
			},
			tags: {
				tenant: { type: 'integer', primaryKey: true },
				code: { type: 'text', primaryKey: true },
			},
			postTags: { tenant: 'integer', post: 'text', tag: 'text' },
		},
		{
			postTags: {
				foreignKeys: [
					ref('posts', {
						columns: ['tenant', 'post'],
						references: ['tenant', 'code'],
						as: 'post',
					}),
					ref('tags', {
						columns: ['tenant', 'tag'],
						references: ['tenant', 'code'],
						as: 'tag',
					}),
				],
				indexes: [{ columns: ['tenant', 'post', 'tag'], unique: true }],
			},
		},
		options(
			'posts',
			'tags',
			'tags',
			'postTags',
			'posts',
			['tenant', 'post'],
			['tenant', 'tag'],
		),
	).model;
	expect(model.getRelation('posts.tags')).toMatchObject({
		foreignKey: ['tenant', 'post'],
		otherKey: ['tenant', 'tag'],
		sourceKey: ['tenant', 'code'],
		targetKey: ['tenant', 'code'],
	});
	expect(model.getRelation('tags.posts')).toMatchObject({
		foreignKey: ['tenant', 'tag'],
		otherKey: ['tenant', 'post'],
		sourceKey: ['tenant', 'code'],
		targetKey: ['tenant', 'code'],
	});
});
it('rejects a junction foreign key to an external table of the same name', () => {
	expect(() =>
		schema(
			{
				...definition,
				postTags: {
					postId: 'integer',
					tagId: ref('tags'),
				},
			},
			{
				postTags: {
					foreignKeys: [
						ref('posts', {
							schema: 'external',
							columns: ['postId'],
							references: ['id'],
						}),
					],
				},
			},
			options(),
		),
	).toThrow("not a declared foreign key referencing 'posts' key vector");
});
it('rejects a composite junction foreign key referencing a non-key vector', () => {
	expect(() =>
		schema(
			{
				posts: { id: 'integer', a: 'integer', b: 'integer' },
				tags: { id: 'integer' },
				postTags: { a: 'integer', b: 'integer', tagId: ref('tags') },
			},
			{
				postTags: {
					foreignKeys: [
						ref('posts', {
							columns: ['a', 'b'],
							references: ['a', 'b'],
							as: 'post',
						}),
					],
					indexes: [{ columns: ['a', 'b', 'tagId'], unique: true }],
				},
			},
			options('posts', 'tags', 'tags', 'postTags', 'posts', ['a', 'b']),
		),
	).toThrow("does not reference a key vector of 'posts'");
});

it('rejects hash unique indexes as junction uniqueness proof', () => {
	expect(() =>
		schema(
			{
				...definition,
				postTags: { id: 'integer', postId: ref('posts'), tagId: ref('tags') },
			},
			{
				postTags: {
					indexes: [
						{ columns: ['postId', 'tagId'], unique: true, method: 'hash' },
					],
				},
			},
			options(),
		),
	).toThrow("junction 'postTags' foreign keys are not covered");
});
it('names nested include refusals from the query root once', () => {
	const model = schema(
		{
			...definition,
			authors: { id: 'integer' },
			posts: { id: 'integer', authorId: ref('authors', { inverse: 'posts' }) },
		},
		undefined,
		options(),
	).model;
	expect(() =>
		plan(
			{
				type: 'select',
				from: 'authors',
				include: [{ relation: 'posts', include: [{ relation: 'tags' }] }],
			},
			model,
			{ defaultIncludeStrategy: 'json_agg' },
		),
	).toThrow(
		"Relation 'authors.posts.tags': many-to-many traversal is not supported yet (#787).",
	);
});
