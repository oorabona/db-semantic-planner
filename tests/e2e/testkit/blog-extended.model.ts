/**
 * Extended Blog Model for Complex Include Testing
 *
 * Adds:
 * - tags (M:N with posts via post_tags junction)
 * - categories (self-referential hierarchy)
 * - approved field on comments
 */

import {
	belongsTo,
	belongsToMany,
	defineSchema,
	hasMany,
} from '@db-semantic-planner/core';

export const blogExtendedModel = defineSchema({
	authors: {
		id: 'integer',
		name: 'string',
		email: 'string',
		active: 'boolean',
	},
	categories: {
		id: 'integer',
		name: 'string',
		parent_id: { type: 'integer', nullable: true },
	},
	posts: {
		id: 'integer',
		title: 'string',
		content: 'string',
		author_id: 'integer',
		category_id: { type: 'integer', nullable: true },
		published: 'boolean',
		featured: 'boolean',
		view_count: 'integer',
		created_at: 'timestamp',
	},
	comments: {
		id: 'integer',
		post_id: 'integer',
		author_name: 'string',
		content: 'string',
		approved: 'boolean',
		created_at: 'timestamp',
	},
	tags: {
		id: 'integer',
		name: 'string',
		slug: 'string',
	},
	post_tags: {
		post_id: 'integer',
		tag_id: 'integer',
	},
})
	.relations({
		authors: {
			posts: hasMany('posts', { foreignKey: 'author_id' }),
		},
		categories: {
			parent: belongsTo('categories', { foreignKey: 'parent_id' }),
			children: hasMany('categories', { foreignKey: 'parent_id' }),
			posts: hasMany('posts', { foreignKey: 'category_id' }),
		},
		posts: {
			author: belongsTo('authors', { foreignKey: 'author_id' }),
			category: belongsTo('categories', { foreignKey: 'category_id' }),
			comments: hasMany('comments', { foreignKey: 'post_id' }),
			tags: belongsToMany('tags', {
				through: 'post_tags',
				foreignKey: 'post_id',
				otherKey: 'tag_id',
			}),
		},
		comments: {
			post: belongsTo('posts', { foreignKey: 'post_id' }),
		},
		tags: {
			posts: belongsToMany('posts', {
				through: 'post_tags',
				foreignKey: 'tag_id',
				otherKey: 'post_id',
			}),
		},
	})
	.build();
