/**
 * Blog ModelIR
 *
 * Schema definition for semantic query planning.
 * Uses defineSchema API with explicit relations.
 */

import { buildModelFromResolvedSchema, defineSchema } from '@dbsp/core';

/**
 * Blog schema for E2E tests.
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
const blogSchema = defineSchema(
	{
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
	},
	{
		relations: {
			'authors.posts': {
				kind: 'hasMany',
				target: 'posts',
				foreignKey: 'author_id',
			},
			'posts.author': {
				kind: 'belongsTo',
				target: 'authors',
				foreignKey: 'author_id',
			},
			'posts.comments': {
				kind: 'hasMany',
				target: 'comments',
				foreignKey: 'post_id',
			},
			'comments.post': {
				kind: 'belongsTo',
				target: 'posts',
				foreignKey: 'post_id',
			},
		},
	},
);

export const blogModel = buildModelFromResolvedSchema(blogSchema);
