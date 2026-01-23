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

import { defineSchema } from '@dbsp/core';

export default defineSchema(
	{
		authors: {
			id: { type: 'integer', primaryKey: true, autoIncrement: true },
			name: { type: 'string', nullable: false },
			email: { type: 'string', nullable: false, unique: true },
			active: { type: 'boolean', default: 'true' },
		},
		categories: {
			id: { type: 'integer', primaryKey: true, autoIncrement: true },
			name: { type: 'string', nullable: false },
			parentId: {
				type: 'integer',
				nullable: true,
				references: { table: 'categories' },
				index: true,
			},
		},
		posts: {
			id: { type: 'integer', primaryKey: true, autoIncrement: true },
			title: { type: 'string', nullable: false },
			content: { type: 'text', nullable: false },
			authorId: {
				type: 'integer',
				references: { table: 'authors' },
				index: true,
			},
			categoryId: {
				type: 'integer',
				nullable: true,
				references: { table: 'categories' },
				index: true,
			},
			published: { type: 'boolean', default: 'false', index: true },
			featured: { type: 'boolean', default: 'false', index: true },
			viewCount: { type: 'integer', default: '0' },
			createdAt: { type: 'timestamp', default: 'now()' },
		},
		comments: {
			id: { type: 'integer', primaryKey: true, autoIncrement: true },
			postId: {
				type: 'integer',
				references: { table: 'posts' },
				index: true,
			},
			authorName: { type: 'string', nullable: false },
			content: { type: 'text', nullable: false },
			approved: { type: 'boolean', default: 'false', index: true },
			createdAt: { type: 'timestamp', default: 'now()' },
		},
		tags: {
			id: { type: 'integer', primaryKey: true, autoIncrement: true },
			name: { type: 'string', nullable: false },
			slug: { type: 'string', nullable: false, unique: true },
		},
		postTags: {
			columns: {
				postId: { type: 'integer', references: { table: 'posts' }, index: true },
				tagId: { type: 'integer', references: { table: 'tags' }, index: true },
			},
			primaryKey: ['postId', 'tagId'],
		} as any, // Composite PK uses TableDefWithConfig format
	},
	{
		relations: {
			// Self-referential category hierarchy
			'categories.parent': {
				kind: 'belongsTo',
				target: 'categories',
				foreignKey: 'parentId',
			},
			'categories.children': {
				kind: 'hasMany',
				target: 'categories',
				foreignKey: 'parentId',
			},
			// M:N posts <-> tags
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
// Other relations auto-inferred:
// - authors.posts (hasMany)
// - posts.author (belongsTo)
// - posts.category (belongsTo)
// - posts.comments (hasMany)
// - comments.post (belongsTo)
// - categories.posts (hasMany)
