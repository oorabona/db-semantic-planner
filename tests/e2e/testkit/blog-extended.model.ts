/**
 * Extended Blog Model for Complex Include Testing
 *
 * Adds:
 * - tags (M:N with posts via post_tags junction)
 * - categories (self-referential hierarchy)
 * - approved field on comments
 */

import { defineSchemaBuilder, hasMany, belongsTo, belongsToMany } from '@dbsp/core';

export const blogExtendedModel = defineSchemaBuilder({
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
})
	.relations({
		// Self-referential categories
		categories: {
			parent: belongsTo('categories', { foreignKey: 'parent_id' }),
			children: hasMany('categories', { foreignKey: 'parent_id' }),
		},
		// M:N posts-tags via junction
		posts: {
			author: belongsTo('authors', { foreignKey: 'author_id' }),
			category: belongsTo('categories', { foreignKey: 'category_id' }),
			comments: hasMany('comments', { foreignKey: 'post_id' }),
			tags: belongsToMany('tags', { through: 'post_tags', foreignKey: 'post_id', otherKey: 'tag_id' }),
		},
		tags: {
			posts: belongsToMany('posts', { through: 'post_tags', foreignKey: 'tag_id', otherKey: 'post_id' }),
		},
		authors: {
			posts: hasMany('posts', { foreignKey: 'author_id' }),
		},
		comments: {
			post: belongsTo('posts', { foreignKey: 'post_id' }),
		},
		post_tags: {
			post: belongsTo('posts', { foreignKey: 'post_id' }),
			tag: belongsTo('tags', { foreignKey: 'tag_id' }),
		},
	})
	.build();
