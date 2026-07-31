/**
 * Extended Blog Model for Complex Include Testing
 *
 * Adds:
 * - tags (M:N with posts via postTags junction)
 * - categories (self-referential hierarchy)
 * - approved field on comments
 */

import { ref, schema } from '@dbsp/core';
import type { ModelIR, RelationIR } from '@dbsp/types';

const blogExtendedSchema = schema({
	authors: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
		active: 'boolean',
	},
	categories: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		// Self-referential with parent/children
		parentId: ref('categories', {
			nullable: true,
			roles: { parent: 'parent', children: 'children' },
		}),
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		content: 'string',
		authorId: ref('authors'),
		categoryId: ref('categories', { nullable: true }),
		published: 'boolean',
		featured: 'boolean',
		viewCount: 'integer',
		createdAt: 'timestamp',
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		postId: ref('posts'),
		authorName: 'string',
		content: 'string',
		approved: 'boolean',
		createdAt: 'timestamp',
	},
	tags: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		slug: 'string',
	},
	// Junction table for M:N posts <-> tags
	postTags: {
		postId: ref('posts'),
		tagId: ref('tags'),
	},
});

const postsTagsRelation: RelationIR = {
	name: 'tags',
	type: 'belongsToMany',
	source: 'posts',
	target: 'tags',
	through: 'postTags',
	foreignKey: 'postId',
	otherKey: 'tagId',
	cardinality: 'many',
	optionality: 'optional',
	includeStrategy: 'auto',
	filterStrategy: 'auto',
	joinDefault: 'auto',
};

const tagsPostsRelation: RelationIR = {
	name: 'posts',
	type: 'belongsToMany',
	source: 'tags',
	target: 'posts',
	through: 'postTags',
	foreignKey: 'tagId',
	otherKey: 'postId',
	cardinality: 'many',
	optionality: 'optional',
	includeStrategy: 'auto',
	filterStrategy: 'auto',
	joinDefault: 'auto',
};

function withBlogExtendedManyToManyRelations(model: ModelIR): ModelIR {
	const relations = new Map(model.relations);
	relations.set('posts.tags', postsTagsRelation);
	relations.set('tags.posts', tagsPostsRelation);
	const getRelationsFrom = (sourceTable: string): readonly RelationIR[] => {
		const sourceRelations = model.getRelationsFrom(sourceTable);
		if (sourceTable === 'posts') {
			return [...sourceRelations, postsTagsRelation];
		}
		if (sourceTable === 'tags') {
			return [...sourceRelations, tagsPostsRelation];
		}
		return sourceRelations;
	};
	const getRelationsTo = (targetTable: string): readonly RelationIR[] => {
		const targetRelations = model.getRelationsTo(targetTable);
		if (targetTable === 'posts') {
			return [...targetRelations, tagsPostsRelation];
		}
		if (targetTable === 'tags') {
			return [...targetRelations, postsTagsRelation];
		}
		return targetRelations;
	};
	return {
		tables: model.tables,
		relations,
		...(model.enums !== undefined && { enums: model.enums }),
		...(model.extensions !== undefined && { extensions: model.extensions }),
		...(model.sequences !== undefined && { sequences: model.sequences }),
		getTable: model.getTable.bind(model),
		getRelationsFrom,
		getRelation(qualifiedName: string) {
			if (qualifiedName === 'posts.tags') return postsTagsRelation;
			if (qualifiedName === 'tags.posts') return tagsPostsRelation;
			return model.getRelation(qualifiedName);
		},
		getRelationsTo,
		isAmbiguous(sourceTable: string, targetTable: string) {
			const matches = getRelationsFrom(sourceTable).filter(
				(relation) => relation.target === targetTable,
			);
			return {
				ambiguous: matches.length > 1,
				options: matches.map((relation) => relation.name),
			};
		},
	};
}

export const blogExtendedModel = withBlogExtendedManyToManyRelations(
	blogExtendedSchema.model,
);
