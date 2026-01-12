/**
 * DX-030: Natural Query Parser Tests
 */

import type { ResolvedSchema } from '@db-semantic-planner/schema';
import { describe, expect, it } from 'vitest';
import { ParseError, parsedQueryToSql, parseNaturalQuery } from './parser.js';

// Mock schema for testing
const mockSchema: ResolvedSchema = {
	tables: {
		users: {
			id: { type: 'integer', nullable: false },
			name: { type: 'text', nullable: false },
			email: { type: 'text', nullable: false },
			active: { type: 'boolean', nullable: false },
			created_at: { type: 'timestamp', nullable: false },
		},
		posts: {
			id: { type: 'integer', nullable: false },
			user_id: { type: 'integer', nullable: false },
			title: { type: 'text', nullable: false },
			body: { type: 'text', nullable: true },
			published: { type: 'boolean', nullable: false },
		},
		comments: {
			id: { type: 'integer', nullable: false },
			post_id: { type: 'integer', nullable: false },
			user_id: { type: 'integer', nullable: false },
			content: { type: 'text', nullable: false },
		},
	},
	relations: {
		posts: { kind: 'hasMany', target: 'posts', foreignKey: 'user_id' },
		author: { kind: 'belongsTo', target: 'users', foreignKey: 'user_id' },
		comments: { kind: 'hasMany', target: 'comments', foreignKey: 'post_id' },
	},
	hints: {},
	conventions: {
		primaryKey: 'id',
		createdAt: 'created_at',
		updatedAt: 'updated_at',
		deletedAt: 'deleted_at',
		foreignKeySuffix: '_id',
		timestamps: false,
		softDeletes: false,
	},
};

// Mock schema with qualified relation names (as produced by defineSchema)
const qualifiedSchema: ResolvedSchema = {
	tables: {
		posts: {
			id: { type: 'integer', nullable: false },
			authorId: { type: 'integer', nullable: false },
			title: { type: 'text', nullable: false },
			published: { type: 'boolean', nullable: false },
		},
		authors: {
			id: { type: 'integer', nullable: false },
			name: { type: 'text', nullable: false },
		},
	},
	relations: {
		// Qualified format: "sourceTable.relationName"
		'posts.author': {
			kind: 'belongsTo',
			target: 'authors',
			foreignKey: 'authorId',
		},
		'authors.posts': {
			kind: 'hasMany',
			target: 'posts',
			foreignKey: 'authorId',
		},
	},
	hints: {},
	conventions: {
		primaryKey: 'id',
		createdAt: 'created_at',
		updatedAt: 'updated_at',
		deletedAt: 'deleted_at',
		foreignKeySuffix: 'Id',
		timestamps: false,
		softDeletes: false,
	},
};

describe('parseNaturalQuery', () => {
	describe('basic table queries', () => {
		it('parses simple table name', () => {
			const result = parseNaturalQuery('users', mockSchema);
			expect(result).toEqual({ table: 'users' });
		});

		it('throws on unknown table', () => {
			expect(() => parseNaturalQuery('unknown', mockSchema)).toThrow(
				ParseError,
			);
		});

		it('suggests similar table name', () => {
			expect(() => parseNaturalQuery('user', mockSchema)).toThrow(
				/Did you mean "users"/,
			);
		});
	});

	describe('where clauses', () => {
		it('parses where with equals', () => {
			const result = parseNaturalQuery('users where active = true', mockSchema);
			expect(result).toEqual({
				table: 'users',
				where: [{ column: 'active', operator: '=', value: true }],
			});
		});

		it('parses where with string value', () => {
			const result = parseNaturalQuery(
				'users where name = "Alice"',
				mockSchema,
			);
			expect(result).toEqual({
				table: 'users',
				where: [{ column: 'name', operator: '=', value: 'Alice' }],
			});
		});

		it('parses where with number value', () => {
			const result = parseNaturalQuery('users where id = 1', mockSchema);
			expect(result).toEqual({
				table: 'users',
				where: [{ column: 'id', operator: '=', value: 1 }],
			});
		});

		it('parses where with comparison operators', () => {
			const result = parseNaturalQuery('users where id > 10', mockSchema);
			expect(result.where?.[0]).toEqual({
				column: 'id',
				operator: '>',
				value: 10,
			});
		});

		it('parses where with multiple conditions', () => {
			const result = parseNaturalQuery(
				'users where active = true and id > 5',
				mockSchema,
			);
			expect(result.where).toHaveLength(2);
			expect(result.where?.[0]).toEqual({
				column: 'active',
				operator: '=',
				value: true,
			});
			expect(result.where?.[1]).toEqual({
				column: 'id',
				operator: '>',
				value: 5,
			});
		});

		it('parses where with null value', () => {
			const result = parseNaturalQuery('posts where body is null', mockSchema);
			expect(result.where?.[0]).toEqual({
				column: 'body',
				operator: 'is',
				value: null,
			});
		});
	});

	describe('include clauses', () => {
		it('parses single include', () => {
			const result = parseNaturalQuery('users include posts', mockSchema);
			expect(result).toEqual({
				table: 'users',
				// CLI-014: include is now ParsedInclude[]
				include: [{ relation: 'posts' }],
			});
		});

		it('parses multiple includes', () => {
			const result = parseNaturalQuery(
				'posts include author comments',
				mockSchema,
			);
			// CLI-014: include is now ParsedInclude[]
			expect(result.include).toEqual([
				{ relation: 'author' },
				{ relation: 'comments' },
			]);
		});

		it('throws on unknown relation', () => {
			expect(() =>
				parseNaturalQuery('users include unknown', mockSchema),
			).toThrow(/Unknown relation/);
		});

		describe('filtered includes (CLI-014)', () => {
			it('parses include with where filter', () => {
				const result = parseNaturalQuery(
					'users include posts where published = true',
					mockSchema,
				);
				expect(result).toEqual({
					table: 'users',
					include: [
						{
							relation: 'posts',
							where: [{ column: 'published', operator: '=', value: true }],
						},
					],
				});
			});

			it('parses include with multiple where conditions', () => {
				const result = parseNaturalQuery(
					'users include posts where published = true and views > 100',
					mockSchema,
				);
				expect(result.include).toEqual([
					{
						relation: 'posts',
						where: [
							{ column: 'published', operator: '=', value: true },
							{ column: 'views', operator: '>', value: 100 },
						],
					},
				]);
			});

			it('parses main table where separately from include where', () => {
				const result = parseNaturalQuery(
					'users where active = true include posts where published = true',
					mockSchema,
				);
				expect(result.table).toBe('users');
				expect(result.where).toEqual([
					{ column: 'active', operator: '=', value: true },
				]);
				expect(result.include).toEqual([
					{
						relation: 'posts',
						where: [{ column: 'published', operator: '=', value: true }],
					},
				]);
			});

			it('parses qualified main table column after include filter (CLI-014)', () => {
				// "users include posts where published = true and users.active = true"
				// - published = true → include filter (posts)
				// - users.active = true → main table filter (qualified with table name)
				const result = parseNaturalQuery(
					'users include posts where published = true and users.active = true',
					mockSchema,
				);
				expect(result.table).toBe('users');
				expect(result.where).toEqual([
					{ column: 'active', operator: '=', value: true },
				]);
				expect(result.include).toEqual([
					{
						relation: 'posts',
						where: [{ column: 'published', operator: '=', value: true }],
					},
				]);
			});

			it('parses multiple main table conditions after include filter (CLI-014)', () => {
				// "users include posts where published = true and users.active = true and users.name = "test""
				const result = parseNaturalQuery(
					'users include posts where published = true and users.active = true and users.name = "test"',
					mockSchema,
				);
				expect(result.table).toBe('users');
				expect(result.where).toEqual([
					{ column: 'active', operator: '=', value: true },
					{ column: 'name', operator: '=', value: 'test' },
				]);
				expect(result.include).toEqual([
					{
						relation: 'posts',
						where: [{ column: 'published', operator: '=', value: true }],
					},
				]);
			});
		});

		describe('qualified relations', () => {
			it('parses simple relation name when schema has qualified keys', () => {
				// User types "author" but schema has "posts.author"
				const result = parseNaturalQuery(
					'posts include author',
					qualifiedSchema,
				);
				expect(result).toEqual({
					table: 'posts',
					// CLI-014: include is now ParsedInclude[]
					include: [{ relation: 'author' }],
				});
			});

			it('parses qualified relation when it matches current table', () => {
				// User types "posts.author" which matches query table "posts"
				const result = parseNaturalQuery(
					'posts include posts.author',
					qualifiedSchema,
				);
				expect(result).toEqual({
					table: 'posts',
					// CLI-014: include is now ParsedInclude[]
					include: [{ relation: 'author' }],
				});
			});

			it('throws when qualified relation belongs to different table', () => {
				// User types "authors.posts" while querying "posts"
				expect(() =>
					parseNaturalQuery('posts include authors.posts', qualifiedSchema),
				).toThrow(/belongs to table "authors", not "posts"/);
			});

			it('suggests correct usage when wrong table relation used', () => {
				expect(() =>
					parseNaturalQuery('posts include authors.posts', qualifiedSchema),
				).toThrow(/Use just "posts" or query from "authors" table/);
			});
		});
	});

	describe('limit and offset', () => {
		it('parses limit', () => {
			const result = parseNaturalQuery('users limit 10', mockSchema);
			expect(result.limit).toBe(10);
		});

		it('parses offset', () => {
			const result = parseNaturalQuery('users offset 20', mockSchema);
			expect(result.offset).toBe(20);
		});

		it('parses both limit and offset', () => {
			const result = parseNaturalQuery('users limit 10 offset 20', mockSchema);
			expect(result.limit).toBe(10);
			expect(result.offset).toBe(20);
		});

		it('throws on invalid limit', () => {
			expect(() => parseNaturalQuery('users limit abc', mockSchema)).toThrow(
				/Invalid limit/,
			);
		});
	});

	describe('order by', () => {
		it('parses order by single column', () => {
			const result = parseNaturalQuery('users order by name', mockSchema);
			expect(result.orderBy).toEqual([{ column: 'name', direction: 'asc' }]);
		});

		it('parses order by with direction', () => {
			const result = parseNaturalQuery(
				'users order by created_at desc',
				mockSchema,
			);
			expect(result.orderBy).toEqual([
				{ column: 'created_at', direction: 'desc' },
			]);
		});

		it('parses orderby as single word', () => {
			const result = parseNaturalQuery('users orderby name', mockSchema);
			expect(result.orderBy).toEqual([{ column: 'name', direction: 'asc' }]);
		});
	});

	describe('combined queries', () => {
		it('parses complex query', () => {
			const result = parseNaturalQuery(
				'users where active = true include posts limit 10',
				mockSchema,
			);
			expect(result).toEqual({
				table: 'users',
				where: [{ column: 'active', operator: '=', value: true }],
				// CLI-014: include is now ParsedInclude[]
				include: [{ relation: 'posts' }],
				limit: 10,
			});
		});

		it('parses full query with all clauses', () => {
			const result = parseNaturalQuery(
				'users where active = true and id > 5 include posts order by created_at desc limit 10 offset 0',
				mockSchema,
			);
			expect(result.table).toBe('users');
			expect(result.where).toHaveLength(2);
			// CLI-014: include is now ParsedInclude[]
			expect(result.include).toEqual([{ relation: 'posts' }]);
			expect(result.orderBy).toEqual([
				{ column: 'created_at', direction: 'desc' },
			]);
			expect(result.limit).toBe(10);
			expect(result.offset).toBe(0);
		});
	});
});

describe('parsedQueryToSql', () => {
	it('generates simple select', () => {
		const sql = parsedQueryToSql({ table: 'users' });
		expect(sql).toBe('SELECT * FROM users');
	});

	it('generates select with where', () => {
		const sql = parsedQueryToSql({
			table: 'users',
			where: [{ column: 'active', operator: '=', value: true }],
		});
		expect(sql).toBe('SELECT * FROM users WHERE active = true');
	});

	it('generates select with multiple where conditions', () => {
		const sql = parsedQueryToSql({
			table: 'users',
			where: [
				{ column: 'active', operator: '=', value: true },
				{ column: 'id', operator: '>', value: 5 },
			],
		});
		expect(sql).toBe('SELECT * FROM users WHERE active = true AND id > 5');
	});

	it('generates select with limit', () => {
		const sql = parsedQueryToSql({ table: 'users', limit: 10 });
		expect(sql).toBe('SELECT * FROM users LIMIT 10');
	});

	it('generates select with order by', () => {
		const sql = parsedQueryToSql({
			table: 'users',
			orderBy: [{ column: 'name', direction: 'asc' }],
		});
		expect(sql).toBe('SELECT * FROM users ORDER BY name ASC');
	});

	it('includes comment for relations', () => {
		// CLI-014: include is now ParsedInclude[]
		const sql = parsedQueryToSql({
			table: 'users',
			include: [{ relation: 'posts' }, { relation: 'comments' }],
		});
		expect(sql).toContain('-- Includes: posts, comments');
	});

	it('includes comment for filtered relations (CLI-014)', () => {
		const sql = parsedQueryToSql({
			table: 'tags',
			include: [
				{
					relation: 'posts',
					where: [{ column: 'published', operator: '=', value: true }],
				},
			],
		});
		expect(sql).toContain('-- Includes: posts WHERE published = true');
	});
});
