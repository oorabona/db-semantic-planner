/**
 * Extended Blog Model for Complex Include Testing
 *
 * Adds:
 * - tags (M:N with posts via post_tags junction)
 * - categories (self-referential hierarchy)
 * - approved field on comments
 */

import { buildModelFromResolvedSchema, defineSchema } from '@dbsp/core';

const blogExtendedSchema = defineSchema(
	{
		authors: {
			id: { type: 'integer', primaryKey: true },
			name: { type: 'string' },
			email: { type: 'string' },
			active: { type: 'boolean' },
		},
		categories: {
			id: { type: 'integer', primaryKey: true },
			name: { type: 'string' },
			parent_id: { type: 'integer', nullable: true },
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: { type: 'string' },
			content: { type: 'string' },
			author_id: { type: 'integer' },
			category_id: { type: 'integer', nullable: true },
			published: { type: 'boolean' },
			featured: { type: 'boolean' },
			view_count: { type: 'integer' },
			created_at: { type: 'timestamp' },
		},
		comments: {
			id: { type: 'integer', primaryKey: true },
			post_id: { type: 'integer' },
			author_name: { type: 'string' },
			content: { type: 'string' },
			approved: { type: 'boolean' },
			created_at: { type: 'timestamp' },
		},
		tags: {
			id: { type: 'integer', primaryKey: true },
			name: { type: 'string' },
			slug: { type: 'string' },
		},
		post_tags: {
			post_id: { type: 'integer' },
			tag_id: { type: 'integer' },
		},
	},
	{
		relations: {
			// Self-referential categories
			'categories.parent': {
				kind: 'belongsTo',
				target: 'categories',
				foreignKey: 'parent_id',
			},
			'categories.children': {
				kind: 'hasMany',
				target: 'categories',
				foreignKey: 'parent_id',
			},
			// M:N posts-tags via junction
			'posts.author': {
				kind: 'belongsTo',
				target: 'authors',
				foreignKey: 'author_id',
			},
			'posts.category': {
				kind: 'belongsTo',
				target: 'categories',
				foreignKey: 'category_id',
			},
			'posts.comments': {
				kind: 'hasMany',
				target: 'comments',
				foreignKey: 'post_id',
			},
			'posts.tags': {
				kind: 'manyToMany',
				target: 'tags',
				through: 'post_tags',
				sourceFk: 'post_id',
				targetFk: 'tag_id',
			},
			'tags.posts': {
				kind: 'manyToMany',
				target: 'posts',
				through: 'post_tags',
				sourceFk: 'tag_id',
				targetFk: 'post_id',
			},
			'authors.posts': {
				kind: 'hasMany',
				target: 'posts',
				foreignKey: 'author_id',
			},
			'comments.post': {
				kind: 'belongsTo',
				target: 'posts',
				foreignKey: 'post_id',
			},
			'post_tags.post': {
				kind: 'belongsTo',
				target: 'posts',
				foreignKey: 'post_id',
			},
			'post_tags.tag': {
				kind: 'belongsTo',
				target: 'tags',
				foreignKey: 'tag_id',
			},
		},
	},
);

export const blogExtendedModel = buildModelFromResolvedSchema(blogExtendedSchema);
