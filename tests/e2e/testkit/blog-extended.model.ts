/**
 * Extended Blog Model for Complex Include Testing
 *
 * Adds:
 * - tags (M:N with posts via postTags junction)
 * - categories (self-referential hierarchy)
 * - approved field on comments
 */

import { fk, schema } from '@dbsp/core';

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
		parentId: fk('categories', {
			nullable: true,
			roles: { parent: 'parent', children: 'children' },
		}),
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		content: 'string',
		authorId: fk('authors'),
		categoryId: fk('categories', { nullable: true }),
		published: 'boolean',
		featured: 'boolean',
		viewCount: 'integer',
		createdAt: 'timestamp',
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		postId: fk('posts'),
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
		postId: fk('posts'),
		tagId: fk('tags'),
	},
});

export const blogExtendedModel = blogExtendedSchema.model;
