/**
 * Example: Blog Schema
 *
 * A simple blog with authors, posts, and comments.
 * Demonstrates: belongsTo, hasMany relations, FK conventions.
 *
 * Usage:
 *   pnpm dbsp repl --schema ./examples/blog.schema.ts
 *   pnpm dbsp generate ddl --schema ./examples/blog.schema.ts
 */

// ARCH-005: Use ref() alias to avoid conflict with subquery ref()
import { ref, schema } from '@dbsp/core';

export default schema({
	authors: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: 'string',
		email: { type: 'string', unique: true },
		bio: { type: 'text', nullable: true },
		createdAt: { type: 'timestamp', default: 'now()' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		title: 'string',
		slug: { type: 'string', unique: true },
		content: { type: 'text', nullable: true },
		published: { type: 'boolean', default: 'false', index: true },
		authorId: ref('authors', { onDelete: 'CASCADE', inverse: 'posts' }),
		createdAt: { type: 'timestamp', default: 'now()' },
		updatedAt: { type: 'timestamp', nullable: true },
	},
	comments: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		postId: ref('posts', { onDelete: 'CASCADE', inverse: 'comments' }),
		authorName: 'string',
		authorEmail: { type: 'string', nullable: true },
		content: 'text',
		approved: { type: 'boolean', default: 'false', index: true },
		createdAt: { type: 'timestamp', default: 'now()' },
	},
	tags: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: { type: 'string', unique: true },
		slug: { type: 'string', unique: true },
	},
	// ARCH-005: Junction table for M:N - just a table with two FKs
	postTags: {
		postId: ref('posts', { onDelete: 'CASCADE' }),
		tagId: ref('tags', { onDelete: 'CASCADE' }),
		// Note: Composite PK not directly supported by schema() yet
		// Use DDL or adapter-level constraints
	},
});
// Relations auto-inferred from ref():
// - authors.authorId_posts (hasMany)
// - posts.author (belongsTo), posts.postId_comments (hasMany)
// - comments.post (belongsTo)
// - postTags.post (belongsTo), postTags.tag (belongsTo)
// - posts.postId_postTags (hasMany), tags.tagId_postTags (hasMany)
