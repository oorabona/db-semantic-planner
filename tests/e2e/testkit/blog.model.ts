/**
 * Blog ModelIR
 *
 * Schema definition for semantic query planning.
 */

import { belongsTo, defineSchema, hasMany } from '@dbsp/core';

/**
 * Blog schema model for E2E tests.
 *
 * Includes:
 * - authors
 * - posts
 * - comments
 */
export const blogModel = defineSchema({
	authors: {
		id: 'integer',
		name: { type: 'string' },
		email: { type: 'string' },
	},
	posts: {
		id: 'integer',
		title: { type: 'string' },
		content: { type: 'string' },
		author_id: 'integer',
		published: { type: 'boolean' },
		created_at: 'timestamp',
	},
	comments: {
		id: 'integer',
		post_id: 'integer',
		author_name: { type: 'string' },
		content: { type: 'string' },
		created_at: 'timestamp',
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
