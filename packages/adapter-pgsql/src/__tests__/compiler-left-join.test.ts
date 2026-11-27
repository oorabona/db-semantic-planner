/**
 * @module compiler-left-join.test
 * Tests for F-006: LEFT JOIN compilation for include-strategy.
 *
 * When the planner picks the join strategy for a to-one (belongsTo/hasOne) include,
 * the compiler produces LEFT JOIN + aliased columns instead of a json_agg subquery.
 */

import { createOrm, eq, exists, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

// ============================================================================
// Fixtures
// ============================================================================

/** posts → authors, posts → categories. */
const blogDb = schema({
	authors: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
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
} as const);
const blogOrm = createOrm({
	schema: blogDb,
	adapter: createPgCompileOnlyAdapter({ model: blogDb.model }),
});

/** posts → users twice (author and editor). */
const twoUsersDb = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		author_id: ref('users', { as: 'author', inverse: 'authored' }),
		editor_id: ref('users', { as: 'editor', inverse: 'edited' }),
	},
} as const);
const twoUsersOrm = createOrm({
	schema: twoUsersDb,
	adapter: createPgCompileOnlyAdapter({ model: twoUsersDb.model }),
});

/** calls → symbols → files. */
const callsDb = schema({
	files: {
		id: { type: 'integer', primaryKey: true },
		path: { type: 'text' },
	},
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		file_id: ref('files', { as: 'file', inverse: 'symbols' }),
	},
	calls: {
		id: { type: 'integer', primaryKey: true },
		callee_id: ref('symbols', { as: 'callee', inverse: 'callee_calls' }),
	},
} as const);
const callsOrm = createOrm({
	schema: callsDb,
	adapter: createPgCompileOnlyAdapter({ model: callsDb.model }),
});

/** users → posts → comments, each link unique so the joins are to-one. */
const chainDb = schema({
	users: { id: { type: 'integer', primaryKey: true } },
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', { unique: true, as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		postId: ref('posts', { unique: true, as: 'post', inverse: 'comments' }),
	},
} as const);
const chainOrm = createOrm({
	schema: chainDb,
	adapter: createPgCompileOnlyAdapter({ model: chainDb.model }),
});

// ============================================================================
// Tests
// ============================================================================

describe('LEFT JOIN include compilation (F-006)', () => {
	describe('belongsTo include with choice=join', () => {
		it('should compile LEFT JOIN with PK only when no other columns', () => {
			const { sql, params } = blogOrm
				.select('posts')
				.include('author', {
					join: 'left',
					select: { type: 'fields', fields: ['id'] },
				})
				.dump();

			expect({ sql, params }).toEqual({
				sql: 'SELECT posts.*, author.id AS "author.id", author.id AS __dbsp_presence_author FROM posts LEFT JOIN authors AS author ON posts.author_id = author.id',
				params: [],
			});
		});
	});

	describe('multiple to-one includes to same table', () => {
		it('should produce two LEFT JOINs with different aliases', () => {
			const { sql, params } = twoUsersOrm
				.select('posts')
				.include('author', {
					join: 'left',
					select: { type: 'fields', fields: ['id', 'name'] },
				})
				.include('editor', {
					join: 'left',
					select: { type: 'fields', fields: ['id', 'name'] },
				})
				.dump();

			expect({ sql, params }).toEqual({
				sql: 'SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author.id AS __dbsp_presence_author, editor.id AS "editor.id", editor.name AS "editor.name", editor.id AS __dbsp_presence_editor FROM posts LEFT JOIN users AS author ON posts.author_id = author.id LEFT JOIN users AS editor ON posts.editor_id = editor.id',
				params: [],
			});
		});
	});

	describe('2-hop nested LEFT JOIN include (INCLUDE-2HOP)', () => {
		it('should use intermediate table FK for second-hop join', () => {
			// Scenario: calls → callee (symbols) → file (files)
			// First hop: calls.callee_id → symbols.id  (belongsTo)
			// Second hop: symbols.file_id → files.id   (belongsTo)
			const { sql, params } = callsOrm
				.select('calls')
				.include('callee', { join: 'left' })
				.include('callee.file', { join: 'left' })
				.dump();

			expect({ sql, params }).toEqual({
				sql: 'SELECT calls.*, callee.id AS "callee.id", callee.name AS "callee.name", callee.file_id AS "callee.file_id", callee.id AS __dbsp_presence_callee, file.id AS "callee.file.id", file.path AS "callee.file.path", file.id AS "__dbsp_presence_callee.file" FROM calls LEFT JOIN symbols AS callee ON calls.callee_id = callee.id LEFT JOIN files AS file ON callee.file_id = file.id',
				params: [],
			});
		});

		it('should use intermediate table for hasMany second hop', () => {
			// Scenario: users → posts → comments
			// First hop: users.id = posts.authorId
			// Second hop: posts.id = comments.postId (not users.id)
			const { sql, params } = chainOrm
				.select('users')
				.include('posts', { join: 'left' })
				.include('posts.comments', { join: 'left' })
				.dump();

			expect({ sql, params }).toEqual({
				sql: 'SELECT users.*, posts.id AS "posts.id", posts."authorId" AS "posts.authorId", posts.id AS __dbsp_presence_posts, comments.id AS "posts.comments.id", comments."postId" AS "posts.comments.postId", comments.id AS "__dbsp_presence_posts.comments" FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId" LEFT JOIN comments AS comments ON posts.id = comments."postId"',
				params: [],
			});
		});
	});

	describe('mixed EXISTS filter + LEFT JOIN include', () => {
		it('should compile EXISTS for filter and LEFT JOIN for include', () => {
			const { sql, params } = blogOrm
				.select('posts')
				.include('author', {
					join: 'left',
					select: { type: 'fields', fields: ['id', 'name'] },
				})
				.where(exists('category', { where: eq('slug', 'tech') }))
				.dump();

			expect({ sql, params }).toEqual({
				sql: 'SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author.id AS __dbsp_presence_author FROM posts LEFT JOIN authors AS author ON posts.author_id = author.id WHERE EXISTS (SELECT 1 FROM categories AS categories_exists_1 WHERE posts.category_id = categories_exists_1.id AND categories_exists_1.slug = $1)',
				params: ['tech'],
			});
		});
	});
});
