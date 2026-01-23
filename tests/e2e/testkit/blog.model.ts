/**
 * Blog ModelIR
 *
 * Schema definition for semantic query planning.
 * Uses the defineSchemaBuilder API with explicit relations.
 */

import { defineSchemaBuilder, hasMany, belongsTo } from '@dbsp/core';

/**
 * Blog schema model for E2E tests.
 *
 * Includes:
 * - authors
 * - posts
 * - comments
 *
 * Relations:
 * - authors.posts (hasMany)
 * - posts.author (belongsTo)
 * - posts.comments (hasMany)
 * - comments.post (belongsTo)
 */
export const blogModel = defineSchemaBuilder({
	authors: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'string' },
		email: { type: 'string' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: { type: 'string' },
		content: { type: 'string' },
		author_id: { type: 'integer' },
		published: { type: 'boolean' },
		created_at: { type: 'timestamp' },
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		post_id: { type: 'integer' },
		author_name: { type: 'string' },
		content: { type: 'string' },
		created_at: { type: 'timestamp' },
	},
})
	.relations({
		authors: {
			posts: hasMany('posts', { foreignKey: 'author_id' }),
		},
		posts: {
			author: belongsTo('authors', { foreignKey: 'author_id' }),
			comments: hasMany('comments', { foreignKey: 'post_id' }),
		},
		comments: {
			post: belongsTo('posts', { foreignKey: 'post_id' }),
		},
	})
	.build();
