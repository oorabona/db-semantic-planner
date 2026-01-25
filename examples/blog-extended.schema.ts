/**
 * Example: Blog Extended Schema
 *
 * A complex blog for testing advanced queries:
 * - Hierarchical categories (self-referential)
 * - M:N tags via junction table
 * - Active/inactive authors
 * - Published/draft posts with featured flag
 * - Approved/pending comments
 *
 * Perfect for testing complex includes, where clauses, and multiple joins.
 *
 * Usage:
 *   pnpm dbsp repl --schema ./examples/blog-extended.schema.ts
 *
 * Example complex queries:
 *   authors where active = true include posts where published = true include comments where approved = true
 *   posts where featured = true include author where active = true include tags
 *   categories where parentId is null include children include posts
 *   tags include posts where published = true and viewCount > 100
 */

import { ref, schema } from '@dbsp/core';

export default schema({
	authors: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: 'string',
		email: { type: 'string', unique: true },
		active: { type: 'boolean', default: 'true' },
	},
	categories: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: 'string',
		// Self-referential with parent/children
		parentId: ref('categories', {
			nullable: true,
			roles: { parent: 'parent', children: 'children' },
		}),
	},
	posts: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		title: 'string',
		content: 'text',
		authorId: ref('authors', { inverse: 'posts' }),
		categoryId: ref('categories', { nullable: true }),
		published: { type: 'boolean', default: 'false', index: true },
		featured: { type: 'boolean', default: 'false', index: true },
		viewCount: { type: 'integer', default: '0' },
		createdAt: { type: 'timestamp', default: 'now()' },
	},
	comments: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		postId: ref('posts'),
		authorName: 'string',
		content: 'text',
		approved: { type: 'boolean', default: 'false', index: true },
		createdAt: { type: 'timestamp', default: 'now()' },
	},
	tags: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: 'string',
		slug: { type: 'string', unique: true },
	},
	// Junction table for M:N posts <-> tags
	postTags: {
		postId: ref('posts'),
		tagId: ref('tags'),
	},
});
// Relations auto-inferred from ref():
// - categories.parent, categories.children (self-ref)
// - authors.authorId_posts (hasMany)
// - posts.author (belongsTo)
// - posts.category (belongsTo)
// - posts.postId_comments (hasMany)
// - comments.post (belongsTo)
// - categories.categoryId_posts (hasMany)
// - postTags.post, postTags.tag (junction belongsTo)
// - posts.postId_postTags, tags.tagId_postTags (hasMany to junction)
