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

import { defineSchema } from '@db-semantic-planner/schema';

export default defineSchema(
	{
		authors: {
			id: { type: 'integer', primaryKey: true },
			name: { type: 'string', nullable: false },
			email: { type: 'string', nullable: false, unique: true },
			active: { type: 'boolean', default: 'true' },
		},
		categories: {
			id: { type: 'integer', primaryKey: true },
			name: { type: 'string', nullable: false },
			parent_id: {
				type: 'integer',
				nullable: true,
				references: { table: 'categories' },
			},
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: { type: 'string', nullable: false },
			content: { type: 'text', nullable: false },
			author_id: { type: 'integer', references: { table: 'authors' } },
			category_id: {
				type: 'integer',
				nullable: true,
				references: { table: 'categories' },
			},
			published: { type: 'boolean', default: 'false' },
			featured: { type: 'boolean', default: 'false' },
			view_count: { type: 'integer', default: '0' },
			created_at: { type: 'timestamp', default: 'now()' },
		},
		comments: {
			id: { type: 'integer', primaryKey: true },
			post_id: { type: 'integer', references: { table: 'posts' } },
			author_name: { type: 'string', nullable: false },
			content: { type: 'text', nullable: false },
			approved: { type: 'boolean', default: 'false' },
			created_at: { type: 'timestamp', default: 'now()' },
		},
		tags: {
			id: { type: 'integer', primaryKey: true },
			name: { type: 'string', nullable: false },
			slug: { type: 'string', nullable: false, unique: true },
		},
		post_tags: {
			post_id: { type: 'integer', references: { table: 'posts' } },
			tag_id: { type: 'integer', references: { table: 'tags' } },
		},
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
