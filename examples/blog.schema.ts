/**
 * Example: Blog Schema
 *
 * A simple blog with authors, posts, and comments.
 * Demonstrates: belongsTo, hasMany relations, FK conventions.
 *
 * Usage:
 *   pnpm dbsp repl --schema ./examples/blog.schema.ts
 *   pnpm dbsp generate kysely --schema ./examples/blog.schema.ts
 */

import { defineSchema } from '@db-semantic-planner/schema';

export default defineSchema(
	{
		authors: {
			id: { type: 'integer', primaryKey: true },
			name: { type: 'string', nullable: false },
			email: { type: 'string', nullable: false, unique: true },
			bio: { type: 'text', nullable: true },
			createdAt: { type: 'timestamp', default: 'now()' },
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: { type: 'string', nullable: false },
			slug: { type: 'string', nullable: false, unique: true },
			content: { type: 'text', nullable: true },
			published: { type: 'boolean', default: 'false' },
			authorId: { type: 'integer', references: { table: 'authors' } },
			createdAt: { type: 'timestamp', default: 'now()' },
			updatedAt: { type: 'timestamp', nullable: true },
		},
		comments: {
			id: { type: 'integer', primaryKey: true },
			postId: { type: 'integer', references: { table: 'posts' } },
			authorName: { type: 'string', nullable: false },
			authorEmail: { type: 'string', nullable: true },
			content: { type: 'text', nullable: false },
			approved: { type: 'boolean', default: 'false' },
			createdAt: { type: 'timestamp', default: 'now()' },
		},
		tags: {
			id: { type: 'integer', primaryKey: true },
			name: { type: 'string', nullable: false, unique: true },
			slug: { type: 'string', nullable: false, unique: true },
		},
		postTags: {
			postId: { type: 'integer', references: { table: 'posts' } },
			tagId: { type: 'integer', references: { table: 'tags' } },
		},
	},
	{
		relations: {
			// Explicit M:N relation via junction table
			'posts.tags': {
				kind: 'manyToMany',
				target: 'tags',
				through: 'postTags',
				sourceFk: 'postId',
				targetFk: 'tagId',
			},
			'tags.posts': {
				kind: 'manyToMany',
				target: 'posts',
				through: 'postTags',
				sourceFk: 'tagId',
				targetFk: 'postId',
			},
		},
	},
);
// Other relations (authors.posts, posts.author, posts.comments, comments.post)
// are auto-inferred from `references` definitions
