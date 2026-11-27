/**
 * @module compiler-join-filter.test
 * Unit tests for F-005: relation filters compile as EXISTS.
 */

import { and, createOrm, eq, exists, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	authors: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		active: { type: 'boolean' },
	},
	categories: {
		id: { type: 'integer', primaryKey: true },
		slug: { type: 'text' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		author_id: ref('authors', { as: 'author', inverse: 'posts' }),
		category_id: ref('categories', { as: 'category', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		approved: { type: 'boolean' },
		post_id: ref('posts', { as: 'post', inverse: 'comments' }),
	},
} as const);
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});

// ============================================================================
// Tests
// ============================================================================

describe('EXISTS filter compilation (F-005)', () => {
	describe('multiple EXISTS predicates', () => {
		it('should compile multiple EXISTS predicates from different filters', () => {
			const { sql, params } = orm
				.select('posts')
				.where(
					and(
						exists('author', { where: eq('name', 'Alice') }),
						exists('category', { where: eq('slug', 'tech') }),
					),
				)
				.dump();

			expect({ sql, params }).toEqual({
				sql: 'SELECT posts.* FROM posts WHERE EXISTS (SELECT 1 FROM authors AS authors_exists_0 WHERE posts.author_id = authors_exists_0.id AND authors_exists_0.name = $1) AND EXISTS (SELECT 1 FROM categories AS categories_exists_1 WHERE posts.category_id = categories_exists_1.id AND categories_exists_1.slug = $2)',
				params: ['Alice', 'tech'],
			});
		});
	});

	describe('to-one and to-many EXISTS', () => {
		it('should compile EXISTS for both to-one and to-many filters', () => {
			const { sql, params } = orm
				.select('posts')
				.where(
					and(
						exists('author', { where: eq('active', true) }),
						exists('comments', { where: eq('approved', true) }),
					),
				)
				.dump();

			expect({ sql, params }).toEqual({
				sql: 'SELECT posts.* FROM posts WHERE EXISTS (SELECT 1 FROM authors AS authors_exists_0 WHERE posts.author_id = authors_exists_0.id AND authors_exists_0.active = $1) AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts.id = comments_exists_1.post_id AND comments_exists_1.approved = $2)',
				params: [true, true],
			});
		});
	});
});
