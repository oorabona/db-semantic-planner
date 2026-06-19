/**
 * Blog ModelIR
 *
 * Schema definition for semantic query planning.
 * Uses schema() + ref() API with auto-inferred relations.
 */

import { ref, schema } from '@dbsp/core';

/**
 * Blog schema for E2E tests.
 *
 * Includes:
 * - companies
 * - authors
 * - posts
 * - comments
 *
 * Relations (auto-inferred from ref()):
 * - companies.company_authors (hasMany)
 * - authors.company (belongsTo)
 * - authors.author_posts (hasMany)
 * - posts.author (belongsTo)
 * - posts.post_comments (hasMany)
 * - comments.post (belongsTo)
 */
export const blogSchema = schema({
	companies: {
		id: { type: 'integer', primaryKey: true, dbType: 'integer' },
		name: 'string',
	},
	authors: {
		id: { type: 'integer', primaryKey: true, dbType: 'integer' },
		name: 'string',
		email: 'string',
		companyId: ref('companies', { nullable: true }),
	},
	posts: {
		id: { type: 'integer', primaryKey: true, dbType: 'integer' },
		title: 'string',
		content: 'string',
		authorId: ref('authors'),
		published: 'boolean',
		createdAt: 'timestamp',
	},
	comments: {
		id: { type: 'integer', primaryKey: true, dbType: 'integer' },
		postId: ref('posts'),
		authorName: 'string',
		content: 'string',
		createdAt: 'timestamp',
	},
});

export const blogModel = blogSchema.model;
