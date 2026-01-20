/**
 * DX-030: Natural Query Parser Tests
 */

import type { ResolvedSchema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import {
	isMutationKeyword,
	MUTATION_KEYWORDS,
	ParseError,
	parseAssignment,
	parseAssignments,
	parseDelete,
	parsedQueryToSql,
	parseInsert,
	parseMutation,
	parseMutationValue,
	parseNaturalQuery,
	parseUpdate,
	parseUpsert,
	validateColumn,
} from './parser.js';

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
		// For UPSERT composite key tests (SC-12)
		orders: {
			id: { type: 'integer', nullable: false },
			user_id: { type: 'integer', nullable: false },
			product_id: { type: 'integer', nullable: false },
			quantity: { type: 'integer', nullable: false },
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

	describe('range operators (CLI-018)', () => {
		it('parses overlaps with PostgreSQL range syntax', () => {
			const result = parseNaturalQuery(
				'posts where body overlaps [2024-01-15,2024-01-20)',
				mockSchema,
			);
			expect(result.where?.[0]).toEqual({
				column: 'body',
				operator: 'overlaps',
				value: { lower: '2024-01-15', upper: '2024-01-20', bounds: '[)' },
			});
		});

		it('parses overlaps with shorthand range syntax', () => {
			const result = parseNaturalQuery(
				'posts where id overlaps 10..50',
				mockSchema,
			);
			expect(result.where?.[0]).toEqual({
				column: 'id',
				operator: 'overlaps',
				value: { lower: 10, upper: 50, bounds: '[]' },
			});
		});

		it('parses contains with single value', () => {
			const result = parseNaturalQuery(
				'posts where id contains 25',
				mockSchema,
			);
			expect(result.where?.[0]).toEqual({
				column: 'id',
				operator: 'contains',
				value: 25,
			});
		});

		it('parses contains with date string', () => {
			const result = parseNaturalQuery(
				'posts where body contains 2024-01-18',
				mockSchema,
			);
			expect(result.where?.[0]).toEqual({
				column: 'body',
				operator: 'contains',
				value: '2024-01-18',
			});
		});

		it('parses containedBy with range', () => {
			const result = parseNaturalQuery(
				'posts where body containedBy [2024-01-01,2024-02-01)',
				mockSchema,
			);
			expect(result.where?.[0]).toEqual({
				column: 'body',
				operator: 'containedBy',
				value: { lower: '2024-01-01', upper: '2024-02-01', bounds: '[)' },
			});
		});

		it('parses range in include where clause', () => {
			const result = parseNaturalQuery(
				'users include posts where body overlaps 2024-01-01..2024-01-31',
				mockSchema,
			);
			expect(result.include?.[0]).toEqual({
				relation: 'posts',
				where: [
					{
						column: 'body',
						operator: 'overlaps',
						value: { lower: '2024-01-01', upper: '2024-01-31', bounds: '[]' },
					},
				],
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

			it('routes qualified column to its target include (CLI-014)', () => {
				// "users include posts where title = "foo" and posts.published = true"
				// posts.published → explicitly targets posts include
				const result = parseNaturalQuery(
					'users include posts where title = "foo" and posts.published = true',
					mockSchema,
				);
				expect(result.table).toBe('users');
				expect(result.where).toBeUndefined();
				expect(result.include).toEqual([
					{
						relation: 'posts',
						where: [
							{ column: 'title', operator: '=', value: 'foo' },
							{ column: 'published', operator: '=', value: true },
						],
					},
				]);
			});

			it('throws error for qualified column referencing unknown table (CLI-014)', () => {
				expect(() =>
					parseNaturalQuery(
						'users include posts where published = true and orders.status = "pending"',
						mockSchema,
					),
				).toThrow(/orders.*not in the query/);
			});
		});

		describe('nested includes', () => {
			// Schema for nested include testing
			const nestedSchema: ResolvedSchema = {
				tables: {
					authors: {
						id: { type: 'integer', nullable: false },
						name: { type: 'text', nullable: false },
						active: { type: 'boolean', nullable: false },
					},
					posts: {
						id: { type: 'integer', nullable: false },
						author_id: { type: 'integer', nullable: false },
						title: { type: 'text', nullable: false },
						published: { type: 'boolean', nullable: false },
					},
					comments: {
						id: { type: 'integer', nullable: false },
						post_id: { type: 'integer', nullable: false },
						content: { type: 'text', nullable: false },
						approved: { type: 'boolean', nullable: false },
					},
					tags: {
						id: { type: 'integer', nullable: false },
						name: { type: 'text', nullable: false },
					},
				},
				relations: {
					'authors.posts': {
						kind: 'hasMany',
						target: 'posts',
						foreignKey: 'author_id',
					},
					'posts.author': {
						kind: 'belongsTo',
						target: 'authors',
						foreignKey: 'author_id',
					},
					'posts.comments': {
						kind: 'hasMany',
						target: 'comments',
						foreignKey: 'post_id',
					},
					'posts.tags': {
						kind: 'hasMany',
						target: 'tags',
						foreignKey: 'post_id',
					},
					'comments.post': {
						kind: 'belongsTo',
						target: 'posts',
						foreignKey: 'post_id',
					},
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

			it('parses simple nested include: authors include posts include comments', () => {
				const result = parseNaturalQuery(
					'authors include posts include comments',
					nestedSchema,
				);
				expect(result).toEqual({
					table: 'authors',
					include: [
						{
							relation: 'posts',
							include: [{ relation: 'comments' }],
						},
					],
				});
			});

			it('parses nested include with where on each level', () => {
				const result = parseNaturalQuery(
					'authors where active = true include posts where published = true include comments where approved = true',
					nestedSchema,
				);
				expect(result).toEqual({
					table: 'authors',
					where: [{ column: 'active', operator: '=', value: true }],
					include: [
						{
							relation: 'posts',
							where: [{ column: 'published', operator: '=', value: true }],
							include: [
								{
									relation: 'comments',
									where: [{ column: 'approved', operator: '=', value: true }],
								},
							],
						},
					],
				});
			});

			it('parses multiple sibling includes with nested include', () => {
				const result = parseNaturalQuery(
					'posts include author include comments include tags',
					nestedSchema,
				);
				expect(result).toEqual({
					table: 'posts',
					include: [
						{ relation: 'author' },
						{ relation: 'comments' },
						{ relation: 'tags' },
					],
				});
			});

			it('throws error for invalid nested relation', () => {
				// posts.ratings doesn't exist - should throw
				expect(() =>
					parseNaturalQuery(
						'authors include posts include ratings',
						nestedSchema,
					),
				).toThrow(/Unknown relation.*ratings/);
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

		describe('recursive includes (CLI-017)', () => {
			// Schema with self-referential relation
			const hierarchySchema: ResolvedSchema = {
				tables: {
					categories: {
						id: { type: 'integer', nullable: false },
						name: { type: 'text', nullable: false },
						parent_id: { type: 'integer', nullable: true },
					},
				},
				relations: {
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

			it('parses "include all children" as recursive include', () => {
				const result = parseNaturalQuery(
					'categories include all children',
					hierarchySchema,
				);
				expect(result).toEqual({
					table: 'categories',
					include: [
						{
							relation: 'children',
							recursive: true,
						},
					],
				});
			});

			it('parses "include all parent" as recursive include', () => {
				const result = parseNaturalQuery(
					'categories include all parent',
					hierarchySchema,
				);
				expect(result).toEqual({
					table: 'categories',
					include: [
						{
							relation: 'parent',
							recursive: true,
						},
					],
				});
			});

			it('parses recursive include with where clause', () => {
				const result = parseNaturalQuery(
					'categories where id = 1 include all children',
					hierarchySchema,
				);
				expect(result).toEqual({
					table: 'categories',
					where: [{ column: 'id', operator: '=', value: 1 }],
					include: [
						{
							relation: 'children',
							recursive: true,
						},
					],
				});
			});

			it('parses mixed recursive and non-recursive includes', () => {
				const mixedSchema: ResolvedSchema = {
					...hierarchySchema,
					tables: {
						...hierarchySchema.tables,
						posts: {
							id: { type: 'integer', nullable: false },
							category_id: { type: 'integer', nullable: false },
							title: { type: 'text', nullable: false },
						},
					},
					relations: {
						...hierarchySchema.relations,
						'categories.posts': {
							kind: 'hasMany',
							target: 'posts',
							foreignKey: 'category_id',
						},
					},
				};

				const result = parseNaturalQuery(
					'categories include all children include posts',
					mixedSchema,
				);
				expect(result).toEqual({
					table: 'categories',
					include: [
						{
							relation: 'children',
							recursive: true,
						},
						{
							relation: 'posts',
						},
					],
				});
			});

			it('parses regular include (without all) as non-recursive', () => {
				const result = parseNaturalQuery(
					'categories include children',
					hierarchySchema,
				);
				expect(result).toEqual({
					table: 'categories',
					include: [
						{
							relation: 'children',
							// No recursive flag
						},
					],
				});
			});

			// CLI-018: maxDepth and includeDepth options
			it('parses "include all children depth 10" with maxDepth', () => {
				const result = parseNaturalQuery(
					'categories include all children depth 10',
					hierarchySchema,
				);
				expect(result).toEqual({
					table: 'categories',
					include: [
						{
							relation: 'children',
							recursive: true,
							maxDepth: 10,
						},
					],
				});
			});

			it('parses "include all children max 5" with maxDepth', () => {
				const result = parseNaturalQuery(
					'categories include all children max 5',
					hierarchySchema,
				);
				expect(result).toEqual({
					table: 'categories',
					include: [
						{
							relation: 'children',
							recursive: true,
							maxDepth: 5,
						},
					],
				});
			});

			it('parses "include all children with depth" with includeDepth', () => {
				const result = parseNaturalQuery(
					'categories include all children with depth',
					hierarchySchema,
				);
				expect(result).toEqual({
					table: 'categories',
					include: [
						{
							relation: 'children',
							recursive: true,
							includeDepth: true,
						},
					],
				});
			});

			it('parses "include all children depth 10 with depth" with both options', () => {
				const result = parseNaturalQuery(
					'categories include all children depth 10 with depth',
					hierarchySchema,
				);
				expect(result).toEqual({
					table: 'categories',
					include: [
						{
							relation: 'children',
							recursive: true,
							maxDepth: 10,
							includeDepth: true,
						},
					],
				});
			});

			it('parses recursive include with where and depth options', () => {
				const result = parseNaturalQuery(
					'categories where id = 1 include all children depth 3 with depth',
					hierarchySchema,
				);
				expect(result).toEqual({
					table: 'categories',
					where: [{ column: 'id', operator: '=', value: 1 }],
					include: [
						{
							relation: 'children',
							recursive: true,
							maxDepth: 3,
							includeDepth: true,
						},
					],
				});
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

// CLI-016: Aggregate parsing tests
describe('parseNaturalQuery - aggregates (CLI-016)', () => {
	it('parses count(*)', () => {
		const result = parseNaturalQuery('users select count(*)', mockSchema);
		expect(result.aggregates).toEqual([{ function: 'count' }]);
	});

	it('parses count(field)', () => {
		const result = parseNaturalQuery('users select count(id)', mockSchema);
		expect(result.aggregates).toEqual([{ function: 'count', field: 'id' }]);
	});

	it('parses count(field) as alias', () => {
		const result = parseNaturalQuery(
			'users select count(id) as total',
			mockSchema,
		);
		expect(result.aggregates).toEqual([
			{ function: 'count', field: 'id', as: 'total' },
		]);
	});

	it('parses count(distinct field)', () => {
		const result = parseNaturalQuery(
			'users select count(distinct email)',
			mockSchema,
		);
		expect(result.aggregates).toEqual([
			{ function: 'count', field: 'email', distinct: true },
		]);
	});

	it('parses multiple aggregates', () => {
		const result = parseNaturalQuery(
			'posts select count(*), sum(user_id) as total',
			mockSchema,
		);
		expect(result.aggregates).toEqual([
			{ function: 'count' },
			{ function: 'sum', field: 'user_id', as: 'total' },
		]);
	});

	it('parses avg, min, max', () => {
		const result = parseNaturalQuery(
			'users select avg(id), min(id), max(id)',
			mockSchema,
		);
		expect(result.aggregates).toEqual([
			{ function: 'avg', field: 'id' },
			{ function: 'min', field: 'id' },
			{ function: 'max', field: 'id' },
		]);
	});
});

describe('parseNaturalQuery - group by (CLI-016)', () => {
	it('parses simple group by', () => {
		const result = parseNaturalQuery(
			'posts select count(*) group by user_id',
			mockSchema,
		);
		expect(result.groupBy).toEqual(['user_id']);
	});

	it('parses multiple group by fields', () => {
		const result = parseNaturalQuery(
			'posts group by user_id, published',
			mockSchema,
		);
		expect(result.groupBy).toEqual(['user_id', 'published']);
	});

	it('allows group by before select', () => {
		const result = parseNaturalQuery(
			'posts group by user_id select count(*) as total',
			mockSchema,
		);
		expect(result.groupBy).toEqual(['user_id']);
		expect(result.aggregates).toEqual([{ function: 'count', as: 'total' }]);
	});
});

describe('parseNaturalQuery - having (CLI-016)', () => {
	it('parses having clause', () => {
		const result = parseNaturalQuery(
			'posts select count(*) group by user_id having count > 5',
			mockSchema,
		);
		expect(result.having).toEqual([
			{ column: 'count', operator: '>', value: 5 },
		]);
	});

	it('parses having with multiple conditions', () => {
		const result = parseNaturalQuery(
			'posts group by user_id having count > 5 and count < 100',
			mockSchema,
		);
		expect(result.having).toEqual([
			{ column: 'count', operator: '>', value: 5 },
			{ column: 'count', operator: '<', value: 100 },
		]);
	});
});

describe('parseNaturalQuery - distinct (CLI-016)', () => {
	it('parses select distinct', () => {
		const result = parseNaturalQuery('users select distinct', mockSchema);
		expect(result.distinct).toBe(true);
	});

	it('parses distinct keyword alone', () => {
		const result = parseNaturalQuery('users distinct', mockSchema);
		expect(result.distinct).toBe(true);
	});

	it('parses distinct with where', () => {
		const result = parseNaturalQuery(
			'users distinct where active = true',
			mockSchema,
		);
		expect(result.distinct).toBe(true);
		expect(result.where).toEqual([
			{ column: 'active', operator: '=', value: true },
		]);
	});
});

describe('parseNaturalQuery - combined (CLI-016)', () => {
	it('parses complex aggregate query', () => {
		const result = parseNaturalQuery(
			'posts where published = true select count(*) as total, sum(user_id) as user_sum group by user_id having count > 2 order by total desc limit 10',
			mockSchema,
		);
		expect(result.table).toBe('posts');
		expect(result.where).toEqual([
			{ column: 'published', operator: '=', value: true },
		]);
		expect(result.aggregates).toEqual([
			{ function: 'count', as: 'total' },
			{ function: 'sum', field: 'user_id', as: 'user_sum' },
		]);
		expect(result.groupBy).toEqual(['user_id']);
		expect(result.having).toEqual([
			{ column: 'count', operator: '>', value: 2 },
		]);
		expect(result.orderBy).toEqual([{ column: 'total', direction: 'desc' }]);
		expect(result.limit).toBe(10);
	});
});

// =============================================================================
// CLI-MUT: Mutation Helper Tests
// =============================================================================

describe('MUTATION_KEYWORDS', () => {
	it('should contain all mutation keywords', () => {
		expect(MUTATION_KEYWORDS).toEqual(['insert', 'update', 'delete', 'upsert']);
	});
});

describe('isMutationKeyword', () => {
	describe('when given valid mutation keywords', () => {
		it('should return true for insert', () => {
			expect(isMutationKeyword('insert')).toBe(true);
		});

		it('should return true for update', () => {
			expect(isMutationKeyword('update')).toBe(true);
		});

		it('should return true for delete', () => {
			expect(isMutationKeyword('delete')).toBe(true);
		});

		it('should return true for upsert', () => {
			expect(isMutationKeyword('upsert')).toBe(true);
		});

		it('should be case-insensitive', () => {
			expect(isMutationKeyword('INSERT')).toBe(true);
			expect(isMutationKeyword('Update')).toBe(true);
			expect(isMutationKeyword('DELETE')).toBe(true);
		});
	});

	describe('when given non-mutation keywords', () => {
		it('should return false for select', () => {
			expect(isMutationKeyword('select')).toBe(false);
		});

		it('should return false for where', () => {
			expect(isMutationKeyword('where')).toBe(false);
		});

		it('should return false for arbitrary strings', () => {
			expect(isMutationKeyword('foo')).toBe(false);
			expect(isMutationKeyword('')).toBe(false);
		});
	});
});

describe('parseMutationValue', () => {
	describe('when parsing null', () => {
		it('should parse null literal', () => {
			const result = parseMutationValue('null');
			expect(result.type).toBe('null');
			expect(result.value).toBe(null);
		});

		it('should be case-insensitive for null', () => {
			expect(parseMutationValue('NULL').type).toBe('null');
			expect(parseMutationValue('Null').type).toBe('null');
		});
	});

	describe('when parsing booleans', () => {
		it('should parse true', () => {
			const result = parseMutationValue('true');
			expect(result.type).toBe('boolean');
			expect(result.value).toBe(true);
		});

		it('should parse false', () => {
			const result = parseMutationValue('false');
			expect(result.type).toBe('boolean');
			expect(result.value).toBe(false);
		});

		it('should be case-insensitive for booleans', () => {
			expect(parseMutationValue('TRUE').value).toBe(true);
			expect(parseMutationValue('FALSE').value).toBe(false);
		});
	});

	describe('when parsing numbers', () => {
		it('should parse integers', () => {
			const result = parseMutationValue('42');
			expect(result.type).toBe('number');
			expect(result.value).toBe(42);
		});

		it('should parse negative integers', () => {
			const result = parseMutationValue('-123');
			expect(result.type).toBe('number');
			expect(result.value).toBe(-123);
		});

		it('should parse floats', () => {
			const result = parseMutationValue('3.14');
			expect(result.type).toBe('number');
			expect(result.value).toBe(3.14);
		});

		it('should parse negative floats', () => {
			const result = parseMutationValue('-0.5');
			expect(result.type).toBe('number');
			expect(result.value).toBe(-0.5);
		});
	});

	describe('when parsing function calls', () => {
		it('should parse now()', () => {
			const result = parseMutationValue('now()');
			expect(result.type).toBe('function');
			expect(result.value).toBe('now()');
		});

		it('should parse uuid_generate_v4()', () => {
			const result = parseMutationValue('uuid_generate_v4()');
			expect(result.type).toBe('function');
			expect(result.value).toBe('uuid_generate_v4()');
		});

		it('should parse current_timestamp()', () => {
			const result = parseMutationValue('current_timestamp()');
			expect(result.type).toBe('function');
			expect(result.value).toBe('current_timestamp()');
		});
	});

	describe('when parsing JSON', () => {
		it('should parse JSON objects', () => {
			const result = parseMutationValue('{"role": "admin"}');
			expect(result.type).toBe('json');
			expect(result.value).toEqual({ role: 'admin' });
		});

		it('should parse JSON arrays', () => {
			const result = parseMutationValue('[1, 2, 3]');
			expect(result.type).toBe('json');
			expect(result.value).toEqual([1, 2, 3]);
		});

		it('should fallback to string for invalid JSON-like strings', () => {
			const result = parseMutationValue('{invalid json}');
			expect(result.type).toBe('string');
		});
	});

	describe('when parsing strings', () => {
		it('should parse plain strings', () => {
			const result = parseMutationValue('Alice');
			expect(result.type).toBe('string');
			expect(result.value).toBe('Alice');
		});

		it('should preserve raw value', () => {
			const result = parseMutationValue('  hello world  ');
			expect(result.raw).toBe('  hello world  ');
			expect(result.value).toBe('hello world');
		});

		it('should handle email-like strings', () => {
			const result = parseMutationValue('alice@example.com');
			expect(result.type).toBe('string');
			expect(result.value).toBe('alice@example.com');
		});
	});
});

// =============================================================================
// CLI-MUT: Assignment Parsing Tests
// =============================================================================

describe('parseAssignment', () => {
	it('should parse simple assignment', () => {
		const tokens = ['name', '=', 'Alice'];
		const result = parseAssignment(tokens, 0);
		expect(result.assignment.column).toBe('name');
		expect(result.assignment.value.value).toBe('Alice');
		expect(result.nextIndex).toBe(3);
	});

	it('should throw on missing equals sign', () => {
		const tokens = ['name', 'Alice'];
		expect(() => parseAssignment(tokens, 0)).toThrow('Expected "="');
	});

	it('should throw on missing value', () => {
		const tokens = ['name', '='];
		expect(() => parseAssignment(tokens, 0)).toThrow('Expected value');
	});
});

describe('parseAssignments', () => {
	it('should parse multiple comma-separated assignments', () => {
		const tokens = ['name', '=', 'Alice', ',', 'email', '=', 'a@e.com'];
		const result = parseAssignments(tokens, 0);
		expect(result.assignments).toHaveLength(2);
		expect(result.assignments[0].column).toBe('name');
		expect(result.assignments[1].column).toBe('email');
	});

	it('should stop at WHERE keyword', () => {
		const tokens = ['name', '=', 'Alice', 'where', 'id', '=', '1'];
		const result = parseAssignments(tokens, 0);
		expect(result.assignments).toHaveLength(1);
		expect(result.nextIndex).toBe(3);
	});

	it('should stop at ! flag', () => {
		const tokens = ['name', '=', 'Alice', '!'];
		const result = parseAssignments(tokens, 0);
		expect(result.assignments).toHaveLength(1);
		expect(result.nextIndex).toBe(3);
	});
});

describe('validateColumn', () => {
	it('should pass for existing column', () => {
		expect(() => validateColumn('name', 'users', mockSchema)).not.toThrow();
	});

	it('should throw for unknown column', () => {
		expect(() => validateColumn('unknown', 'users', mockSchema)).toThrow(
			'Column "unknown" does not exist',
		);
	});

	it('should suggest similar column names', () => {
		expect(() => validateColumn('nam', 'users', mockSchema)).toThrow(
			'Did you mean "name"',
		);
	});

	it('should throw for unknown table', () => {
		expect(() => validateColumn('name', 'unknown_table', mockSchema)).toThrow(
			'Unknown table',
		);
	});
});

// =============================================================================
// CLI-MUT: INSERT Parser Tests (SC-01, SC-02, SC-03)
// =============================================================================

describe('parseInsert', () => {
	describe('SC-01: Insert single row with key-value syntax', () => {
		it('should parse basic INSERT with string values', () => {
			// Arrange
			const tokens = [
				'users',
				'insert',
				'name',
				'=',
				'Alice',
				',',
				'email',
				'=',
				'a@e.com',
			];

			// Act
			const result = parseInsert(tokens, 'users', 2, mockSchema);

			// Assert
			expect(result.type).toBe('insert');
			expect(result.table).toBe('users');
			expect(result.assignments).toHaveLength(2);
			expect(result.assignments?.[0].column).toBe('name');
			expect(result.assignments?.[0].value.value).toBe('Alice');
			expect(result.assignments?.[1].column).toBe('email');
			expect(result.assignments?.[1].value.value).toBe('a@e.com');
			expect(result.executeImmediate).toBe(false);
		});

		it('should parse INSERT with boolean value', () => {
			const tokens = ['users', 'insert', 'active', '=', 'true'];
			const result = parseInsert(tokens, 'users', 2, mockSchema);

			expect(result.assignments?.[0].column).toBe('active');
			expect(result.assignments?.[0].value.type).toBe('boolean');
			expect(result.assignments?.[0].value.value).toBe(true);
		});

		it('should parse INSERT with numeric value', () => {
			const tokens = ['posts', 'insert', 'user_id', '=', '42'];
			const result = parseInsert(tokens, 'posts', 2, mockSchema);

			expect(result.assignments?.[0].value.type).toBe('number');
			expect(result.assignments?.[0].value.value).toBe(42);
		});
	});

	describe('SC-02: Insert with JSONB value', () => {
		it('should parse INSERT with JSON object as string', () => {
			// Users table doesn't have a jsonb column, but the parser should handle it
			// The value is parsed as JSON type
			const tokens = ['posts', 'insert', 'title', '=', '{"key": "value"}'];
			const result = parseInsert(tokens, 'posts', 2, mockSchema);

			expect(result.assignments?.[0].value.type).toBe('json');
			expect(result.assignments?.[0].value.value).toEqual({ key: 'value' });
		});
	});

	describe('SC-03: Insert with execute suffix', () => {
		it('should detect execute immediate flag', () => {
			const tokens = ['users', 'insert', 'name', '=', 'Alice', '!'];
			const result = parseInsert(tokens, 'users', 2, mockSchema);

			expect(result.executeImmediate).toBe(true);
		});

		it('should work without execute immediate flag', () => {
			const tokens = ['users', 'insert', 'name', '=', 'Alice'];
			const result = parseInsert(tokens, 'users', 2, mockSchema);

			expect(result.executeImmediate).toBe(false);
		});
	});

	describe('Error handling', () => {
		it('should throw for INSERT without assignments', () => {
			const tokens = ['users', 'insert'];
			expect(() => parseInsert(tokens, 'users', 2, mockSchema)).toThrow(
				'INSERT requires at least one column assignment',
			);
		});

		it('should throw for unknown column', () => {
			const tokens = ['users', 'insert', 'unknown_col', '=', 'value'];
			expect(() => parseInsert(tokens, 'users', 2, mockSchema)).toThrow(
				'Column "unknown_col" does not exist',
			);
		});
	});
});

/**
 * SC-04 to SC-06: UPDATE Parser Tests
 */
describe('parseUpdate', () => {
	describe('basic UPDATE parsing', () => {
		it('should parse UPDATE with SET and WHERE clause', () => {
			// Arrange - tokens are already unquoted by tokenizer
			const tokens = [
				'users',
				'update',
				'set',
				'name',
				'=',
				'Bob',
				'where',
				'id',
				'=',
				'1',
			];

			// Act
			const result = parseUpdate(tokens, 'users', 2, mockSchema);

			// Assert
			expect(result.type).toBe('update');
			expect(result.table).toBe('users');
			expect(result.assignments).toHaveLength(1);
			expect(result.assignments?.[0].column).toBe('name');
			expect(result.assignments?.[0].value.value).toBe('Bob');
			expect(result.where).toBeDefined();
			expect(result.where?.[0].column).toBe('id');
			expect(result.executeImmediate).toBe(false);
		});

		it('should parse UPDATE with multiple assignments', () => {
			// Arrange - tokens are already unquoted by tokenizer
			const tokens = [
				'users',
				'update',
				'set',
				'name',
				'=',
				'Bob',
				',',
				'active',
				'=',
				'true',
				'where',
				'id',
				'=',
				'1',
			];

			// Act
			const result = parseUpdate(tokens, 'users', 2, mockSchema);

			// Assert
			expect(result.assignments).toHaveLength(2);
			expect(result.assignments?.[0].column).toBe('name');
			expect(result.assignments?.[1].column).toBe('active');
			expect(result.assignments?.[1].value.value).toBe(true);
		});

		it('should parse UPDATE with execute immediate (!)', () => {
			// Arrange
			const tokens = [
				'users',
				'update',
				'set',
				'active',
				'=',
				'false',
				'where',
				'id',
				'=',
				'1',
				'!',
			];

			// Act
			const result = parseUpdate(tokens, 'users', 2, mockSchema);

			// Assert
			expect(result.executeImmediate).toBe(true);
		});
	});

	describe('UPDATE without WHERE clause', () => {
		it('should throw error for UPDATE without WHERE (dangerous operation)', () => {
			// Arrange
			const tokens = ['users', 'update', 'set', 'active', '=', 'false'];

			// Act & Assert
			expect(() => parseUpdate(tokens, 'users', 2, mockSchema)).toThrow(
				'UPDATE without WHERE clause requires ! suffix',
			);
		});

		it('should allow UPDATE without WHERE if execute immediate is used', () => {
			// Arrange
			const tokens = ['users', 'update', 'set', 'active', '=', 'false', '!'];

			// Act
			const result = parseUpdate(tokens, 'users', 2, mockSchema);

			// Assert
			expect(result.type).toBe('update');
			expect(result.where).toBeUndefined();
			expect(result.executeImmediate).toBe(true);
		});
	});

	describe('UPDATE validation', () => {
		it('should throw error if SET keyword is missing', () => {
			// Arrange
			const tokens = ['users', 'update', 'name', '=', '"Bob"'];

			// Act & Assert
			expect(() => parseUpdate(tokens, 'users', 2, mockSchema)).toThrow(
				'UPDATE requires SET keyword',
			);
		});

		it('should throw error for unknown column', () => {
			// Arrange
			const tokens = [
				'users',
				'update',
				'set',
				'unknown_col',
				'=',
				'value',
				'where',
				'id',
				'=',
				'1',
			];

			// Act & Assert
			expect(() => parseUpdate(tokens, 'users', 2, mockSchema)).toThrow(
				'Column "unknown_col" does not exist',
			);
		});

		it('should throw error if no assignments provided', () => {
			// Arrange
			const tokens = ['users', 'update', 'set', 'where', 'id', '=', '1'];

			// Act & Assert
			expect(() => parseUpdate(tokens, 'users', 2, mockSchema)).toThrow();
		});
	});

	describe('UPDATE with complex WHERE', () => {
		it('should parse UPDATE with multiple WHERE conditions', () => {
			// Arrange
			const tokens = [
				'users',
				'update',
				'set',
				'active',
				'=',
				'true',
				'where',
				'id',
				'>',
				'10',
				'and',
				'active',
				'=',
				'false',
			];

			// Act
			const result = parseUpdate(tokens, 'users', 2, mockSchema);

			// Assert
			expect(result.where).toHaveLength(2);
			expect(result.where?.[0].column).toBe('id');
			expect(result.where?.[0].operator).toBe('>');
			expect(result.where?.[1].column).toBe('active');
		});
	});
});

/**
 * SC-07 to SC-09: DELETE Parser Tests
 */
describe('parseDelete', () => {
	describe('basic DELETE parsing', () => {
		it('should parse DELETE with WHERE clause', () => {
			// Arrange
			const tokens = ['users', 'delete', 'where', 'id', '=', '1'];

			// Act
			const result = parseDelete(tokens, 'users', 2, mockSchema);

			// Assert
			expect(result.type).toBe('delete');
			expect(result.table).toBe('users');
			expect(result.where).toBeDefined();
			expect(result.where?.[0].column).toBe('id');
			expect(result.executeImmediate).toBe(false);
		});

		it('should parse DELETE with execute immediate (!)', () => {
			// Arrange
			const tokens = ['users', 'delete', 'where', 'active', '=', 'false', '!'];

			// Act
			const result = parseDelete(tokens, 'users', 2, mockSchema);

			// Assert
			expect(result.executeImmediate).toBe(true);
		});
	});

	describe('DELETE without WHERE clause (safety)', () => {
		it('should throw error for DELETE without WHERE (dangerous operation)', () => {
			// Arrange
			const tokens = ['users', 'delete'];

			// Act & Assert
			expect(() => parseDelete(tokens, 'users', 2, mockSchema)).toThrow(
				'DELETE without WHERE is not allowed',
			);
		});

		it('should allow DELETE without WHERE if execute immediate is used', () => {
			// Arrange
			const tokens = ['users', 'delete', '!'];

			// Act
			const result = parseDelete(tokens, 'users', 2, mockSchema);

			// Assert
			expect(result.type).toBe('delete');
			expect(result.where).toBeUndefined();
			expect(result.executeImmediate).toBe(true);
		});
	});

	describe('DELETE with complex WHERE', () => {
		it('should parse DELETE with multiple WHERE conditions', () => {
			// Arrange - tokens are already unquoted by tokenizer
			const tokens = [
				'users',
				'delete',
				'where',
				'active',
				'=',
				'false',
				'and',
				'created_at',
				'<',
				'2024-01-01',
			];

			// Act
			const result = parseDelete(tokens, 'users', 2, mockSchema);

			// Assert
			expect(result.where).toHaveLength(2);
			expect(result.where?.[0].column).toBe('active');
			expect(result.where?.[1].column).toBe('created_at');
		});

		// Note: IN operator with parenthesized lists is a parseWhereCondition enhancement
		// outside the scope of Block 3. See SC-XX for future implementation.
	});

	describe('DELETE assignments validation', () => {
		it('should not have assignments field', () => {
			// Arrange
			const tokens = ['users', 'delete', 'where', 'id', '=', '1'];

			// Act
			const result = parseDelete(tokens, 'users', 2, mockSchema);

			// Assert
			expect(result.assignments).toBeUndefined();
		});
	});
});

/**
 * SC-10 to SC-12: UPSERT Parser Tests
 */
describe('parseUpsert', () => {
	describe('SC-10: UPSERT with DO NOTHING', () => {
		it('should parse basic UPSERT with single conflict column', () => {
			// Arrange - tokens are already unquoted by tokenizer
			const tokens = [
				'users',
				'upsert',
				'email',
				'=',
				'a@e.com',
				',',
				'name',
				'=',
				'Alice',
				'on',
				'email',
				'do',
				'nothing',
			];

			// Act
			const result = parseUpsert(tokens, 'users', 2, mockSchema);

			// Assert
			expect(result.type).toBe('upsert');
			expect(result.table).toBe('users');
			expect(result.assignments).toHaveLength(2);
			expect(result.assignments?.[0].column).toBe('email');
			expect(result.assignments?.[0].value.value).toBe('a@e.com');
			expect(result.onConflict?.columns).toEqual(['email']);
			expect(result.onConflict?.action).toBe('nothing');
			expect(result.onConflict?.updateAssignments).toBeUndefined();
			expect(result.executeImmediate).toBe(false);
		});
	});

	describe('SC-11: UPSERT with DO UPDATE', () => {
		it('should parse UPSERT with DO UPDATE SET', () => {
			// Arrange
			const tokens = [
				'users',
				'upsert',
				'email',
				'=',
				'a@e.com',
				',',
				'name',
				'=',
				'Alice',
				'on',
				'email',
				'do',
				'update',
				'set',
				'name',
				'=',
				'excluded.name',
			];

			// Act
			const result = parseUpsert(tokens, 'users', 2, mockSchema);

			// Assert
			expect(result.onConflict?.action).toBe('update');
			expect(result.onConflict?.updateAssignments).toHaveLength(1);
			expect(result.onConflict?.updateAssignments?.[0].column).toBe('name');
			expect(result.onConflict?.updateAssignments?.[0].value.value).toBe(
				'excluded.name',
			);
		});

		it('should parse UPSERT with multiple update assignments', () => {
			// Arrange
			const tokens = [
				'users',
				'upsert',
				'email',
				'=',
				'a@e.com',
				',',
				'name',
				'=',
				'Alice',
				',',
				'active',
				'=',
				'true',
				'on',
				'email',
				'do',
				'update',
				'set',
				'name',
				'=',
				'excluded.name',
				',',
				'active',
				'=',
				'excluded.active',
			];

			// Act
			const result = parseUpsert(tokens, 'users', 2, mockSchema);

			// Assert
			expect(result.onConflict?.updateAssignments).toHaveLength(2);
		});
	});

	describe('SC-12: UPSERT with composite key', () => {
		it('should parse UPSERT with composite conflict columns', () => {
			// Arrange - mockSchema has orders table with user_id, product_id
			const tokens = [
				'orders',
				'upsert',
				'user_id',
				'=',
				'1',
				',',
				'product_id',
				'=',
				'2',
				',',
				'quantity',
				'=',
				'5',
				'on',
				'(',
				'user_id',
				',',
				'product_id',
				')',
				'do',
				'update',
				'set',
				'quantity',
				'=',
				'excluded.quantity',
			];

			// Act
			const result = parseUpsert(tokens, 'orders', 2, mockSchema);

			// Assert
			expect(result.onConflict?.columns).toEqual(['user_id', 'product_id']);
			expect(result.onConflict?.action).toBe('update');
		});
	});

	describe('UPSERT with execute immediate', () => {
		it('should parse UPSERT with ! suffix', () => {
			// Arrange
			const tokens = [
				'users',
				'upsert',
				'email',
				'=',
				'a@e.com',
				'on',
				'email',
				'do',
				'nothing',
				'!',
			];

			// Act
			const result = parseUpsert(tokens, 'users', 2, mockSchema);

			// Assert
			expect(result.executeImmediate).toBe(true);
		});
	});

	describe('UPSERT validation errors', () => {
		it('should throw error for missing ON clause', () => {
			// Arrange
			const tokens = ['users', 'upsert', 'email', '=', 'a@e.com'];

			// Act & Assert
			expect(() => parseUpsert(tokens, 'users', 2, mockSchema)).toThrow(
				'UPSERT requires ON conflict clause',
			);
		});

		it('should throw error for missing DO action', () => {
			// Arrange
			const tokens = [
				'users',
				'upsert',
				'email',
				'=',
				'a@e.com',
				'on',
				'email',
			];

			// Act & Assert
			expect(() => parseUpsert(tokens, 'users', 2, mockSchema)).toThrow(
				'UPSERT requires DO action',
			);
		});

		it('should throw error for invalid DO action', () => {
			// Arrange
			const tokens = [
				'users',
				'upsert',
				'email',
				'=',
				'a@e.com',
				'on',
				'email',
				'do',
				'invalid',
			];

			// Act & Assert
			expect(() => parseUpsert(tokens, 'users', 2, mockSchema)).toThrow(
				'Invalid DO action',
			);
		});

		it('should throw error for DO UPDATE without SET', () => {
			// Arrange
			const tokens = [
				'users',
				'upsert',
				'email',
				'=',
				'a@e.com',
				'on',
				'email',
				'do',
				'update',
			];

			// Act & Assert
			expect(() => parseUpsert(tokens, 'users', 2, mockSchema)).toThrow(
				'DO UPDATE requires SET keyword',
			);
		});

		it('should throw error for unknown conflict column', () => {
			// Arrange
			const tokens = [
				'users',
				'upsert',
				'email',
				'=',
				'a@e.com',
				'on',
				'unknown_col',
				'do',
				'nothing',
			];

			// Act & Assert
			expect(() => parseUpsert(tokens, 'users', 2, mockSchema)).toThrow(
				'Column "unknown_col" does not exist',
			);
		});

		it('should throw error for empty assignments', () => {
			// Arrange
			const tokens = ['users', 'upsert', 'on', 'email', 'do', 'nothing'];

			// Act & Assert
			expect(() => parseUpsert(tokens, 'users', 2, mockSchema)).toThrow(
				'UPSERT requires at least one column assignment',
			);
		});
	});
});

describe('parseMutation', () => {
	describe('INSERT detection', () => {
		it('should detect and parse INSERT mutation', () => {
			const result = parseMutation('users insert name = "Alice"', mockSchema);

			expect(result).not.toBeNull();
			expect(result?.type).toBe('insert');
			expect(result?.table).toBe('users');
		});

		it('should return null for SELECT queries', () => {
			const result = parseMutation('users where active = true', mockSchema);
			expect(result).toBeNull();
		});

		it('should return null for short queries', () => {
			const result = parseMutation('users', mockSchema);
			expect(result).toBeNull();
		});

		it('should be case-insensitive for mutation keywords', () => {
			const result = parseMutation('users INSERT name = "Alice"', mockSchema);
			expect(result?.type).toBe('insert');
		});
	});

	describe('UPDATE detection', () => {
		it('should detect and parse UPDATE mutation', () => {
			const result = parseMutation(
				'users update set name = "Bob" where id = 1',
				mockSchema,
			);

			expect(result).not.toBeNull();
			expect(result?.type).toBe('update');
			expect(result?.table).toBe('users');
			expect(result?.assignments).toHaveLength(1);
		});

		it('should be case-insensitive for UPDATE keyword', () => {
			const result = parseMutation(
				'users UPDATE set name = "Bob" where id = 1',
				mockSchema,
			);
			expect(result?.type).toBe('update');
		});
	});

	describe('DELETE detection', () => {
		it('should detect and parse DELETE mutation', () => {
			const result = parseMutation('users delete where id = 1', mockSchema);

			expect(result).not.toBeNull();
			expect(result?.type).toBe('delete');
			expect(result?.table).toBe('users');
		});

		it('should be case-insensitive for DELETE keyword', () => {
			const result = parseMutation('users DELETE where id = 1', mockSchema);
			expect(result?.type).toBe('delete');
		});
	});

	describe('UPSERT detection', () => {
		it('should detect and parse UPSERT mutation', () => {
			const result = parseMutation(
				'users upsert email = "a@e.com", name = "Alice" on email do nothing',
				mockSchema,
			);

			expect(result).not.toBeNull();
			expect(result?.type).toBe('upsert');
			expect(result?.table).toBe('users');
			expect(result?.onConflict?.action).toBe('nothing');
		});

		it('should be case-insensitive for UPSERT keyword', () => {
			const result = parseMutation(
				'users UPSERT email = "a@e.com" on email do nothing',
				mockSchema,
			);
			expect(result?.type).toBe('upsert');
		});
	});
});
