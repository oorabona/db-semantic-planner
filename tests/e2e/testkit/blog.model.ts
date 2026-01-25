/**
 * Blog ModelIR
 *
 * Schema definition for semantic query planning.
 * Uses schema() + fk() API with auto-inferred relations.
 */

import { fk, schema } from '@dbsp/core';

/**
 * Blog schema for E2E tests.
 *
 * Includes:
 * - authors
 * - posts
 * - comments
 *
 * Relations (auto-inferred from fk()):
 * - authors.authorId_posts (hasMany)
 * - posts.author (belongsTo)
 * - posts.postId_comments (hasMany)
 * - comments.post (belongsTo)
 */
const blogSchema = schema({
	authors: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		content: 'string',
		authorId: fk('authors'),
		published: 'boolean',
		createdAt: 'timestamp',
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		postId: fk('posts'),
		authorName: 'string',
		content: 'string',
		createdAt: 'timestamp',
	},
});

export const blogModel = blogSchema.model;
