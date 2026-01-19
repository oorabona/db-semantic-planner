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
 *   categories where parent_id is null include children include posts
 *   tags include posts where published = true and view_count > 100
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
			parent_id: {
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
			author_id: {
				type: 'integer',
				references: { table: 'authors' },
				index: true,
			},
			category_id: {
				type: 'integer',
				nullable: true,
				references: { table: 'categories' },
				index: true,
			},
			published: { type: 'boolean', default: 'false', index: true },
			featured: { type: 'boolean', default: 'false', index: true },
			view_count: { type: 'integer', default: '0' },
			created_at: { type: 'timestamp', default: 'now()' },
		},
		comments: {
			id: { type: 'integer', primaryKey: true, autoIncrement: true },
			post_id: {
				type: 'integer',
				references: { table: 'posts' },
				index: true,
			},
			author_name: { type: 'string', nullable: false },
			content: { type: 'text', nullable: false },
			approved: { type: 'boolean', default: 'false', index: true },
			created_at: { type: 'timestamp', default: 'now()' },
		},
		tags: {
			id: { type: 'integer', primaryKey: true, autoIncrement: true },
			name: { type: 'string', nullable: false },
			slug: { type: 'string', nullable: false, unique: true },
		},
		post_tags: {
			columns: {
				post_id: { type: 'integer', references: { table: 'posts' }, index: true },
				tag_id: { type: 'integer', references: { table: 'tags' }, index: true },
			},
			primaryKey: ['post_id', 'tag_id'],
		} as any, // Composite PK uses TableDefWithConfig format
	},
	{
		relations: {
			// Self-referential category hierarchy
			'categories.parent': {
				kind: 'belongsTo',
				target: 'categories',
				foreignKey: 'parent_id',
			},
			'categories.children': {
				kind: 'hasMany',
				target: 'categories',
				foreignKey: 'parent_id',
			},
			// M:N posts <-> tags
			'posts.tags': {
				kind: 'manyToMany',
				target: 'tags',
				through: 'post_tags',
				sourceFk: 'post_id',
				targetFk: 'tag_id',
			},
			'tags.posts': {
				kind: 'manyToMany',
				target: 'posts',
				through: 'post_tags',
				sourceFk: 'tag_id',
				targetFk: 'post_id',
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
