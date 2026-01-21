/**
 * DX-030: Natural Query Parser Tests
 */

import type { ResolvedSchema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import {
	getRecursiveRelationInfo,
	isMutationKeyword,
	isWindowExpression,
	isWindowFunction,
	isWindowOnlyFunction,
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
	parseWindowExpression,
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

// Mock schema with recursive relations for Block 7 tests
const recursiveSchema: ResolvedSchema = {
	tables: {
		categories: {
			id: { type: 'integer', nullable: false },
			name: { type: 'text', nullable: false },
			parentId: { type: 'integer', nullable: true },
		},
		employees: {
			id: { type: 'integer', nullable: false },
			name: { type: 'text', nullable: false },
			managerId: { type: 'integer', nullable: true },
		},
	},
	// Relations with extended recursive metadata
	relations: {
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
		// Recursive relation: ancestors (up traversal)
		'categories.ancestors': {
			kind: 'hasMany',
			target: 'categories',
			foreignKey: 'parentId',
			recursive: { direction: 'up', through: 'parent', maxDepth: 10 },
		} as ReturnType<typeof Object.assign>,
		// Recursive relation: descendants (down traversal)
		'categories.descendants': {
			kind: 'hasMany',
			target: 'categories',
			foreignKey: 'parentId',
			recursive: { direction: 'down', through: 'children', maxDepth: 5 },
		} as ReturnType<typeof Object.assign>,
		// Employee hierarchy
		'employees.manager': {
			kind: 'belongsTo',
			target: 'employees',
			foreignKey: 'managerId',
		},
		'employees.reports': {
			kind: 'hasMany',
			target: 'employees',
			foreignKey: 'managerId',
			recursive: { direction: 'down', through: 'reports', maxDepth: 10 },
		} as ReturnType<typeof Object.assign>,
	} as ResolvedSchema['relations'],
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
				"users where name = 'Alice'",
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

		it('parses where with is not null', () => {
			const result = parseNaturalQuery(
				'posts where body is not null',
				mockSchema,
			);
			expect(result.where?.[0]).toEqual({
				column: 'body',
				operator: 'is not',
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
				// users include posts where published = true and users.active = true and users.name = 'test'
				const result = parseNaturalQuery(
					"users include posts where published = true and users.active = true and users.name = 'test'",
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
				// users include posts where title = 'foo' and posts.published = true
				// posts.published → explicitly targets posts include
				const result = parseNaturalQuery(
					"users include posts where title = 'foo' and posts.published = true",
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

// CLI-NQL: Column selection tests
describe('parseNaturalQuery - column selection (CLI-NQL)', () => {
	it('parses single column', () => {
		const result = parseNaturalQuery('users select name', mockSchema);
		expect(result.columns).toEqual([{ column: 'name' }]);
		expect(result.aggregates).toBeUndefined();
	});

	it('parses multiple columns (comma-separated)', () => {
		const result = parseNaturalQuery(
			'users select id, name, email',
			mockSchema,
		);
		expect(result.columns).toEqual([
			{ column: 'id' },
			{ column: 'name' },
			{ column: 'email' },
		]);
	});

	it('parses wildcard (*)', () => {
		const result = parseNaturalQuery('users select *', mockSchema);
		// Wildcard means "all columns" - columns array should be undefined or empty
		expect(result.columns).toBeUndefined();
	});

	it('parses columns with where clause', () => {
		const result = parseNaturalQuery(
			'users select id, name where active = true',
			mockSchema,
		);
		expect(result.columns).toEqual([{ column: 'id' }, { column: 'name' }]);
		expect(result.where).toHaveLength(1);
		expect(result.where?.[0]?.column).toBe('active');
	});

	it('parses columns with order by', () => {
		const result = parseNaturalQuery(
			'users select name, email order by name',
			mockSchema,
		);
		expect(result.columns).toEqual([{ column: 'name' }, { column: 'email' }]);
		expect(result.orderBy).toHaveLength(1);
	});

	it('parses select distinct with columns', () => {
		const result = parseNaturalQuery('users select distinct name', mockSchema);
		expect(result.distinct).toBe(true);
		expect(result.columns).toEqual([{ column: 'name' }]);
	});

	it('parses column with alias', () => {
		const result = parseNaturalQuery('users select name as n', mockSchema);
		expect(result.columns).toEqual([{ column: 'name', alias: 'n' }]);
	});

	it('parses multiple columns with mixed aliases', () => {
		const result = parseNaturalQuery(
			'users select id, name as userName, email',
			mockSchema,
		);
		expect(result.columns).toEqual([
			{ column: 'id' },
			{ column: 'name', alias: 'userName' },
			{ column: 'email' },
		]);
	});

	it('parses mixed columns and aggregates', () => {
		const result = parseNaturalQuery('users select id, count(*)', mockSchema);
		expect(result.columns).toEqual([{ column: 'id' }]);
		expect(result.aggregates).toEqual([{ function: 'count' }]);
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

	// CLI-NQL Block 6: INSERT FROM tests
	describe('SC-12 to SC-14: INSERT with FROM clause', () => {
		// Add products table to mock schema for these tests
		const mockSchemaWithProducts: ResolvedSchema = {
			tables: {
				users: {
					id: { type: 'integer', nullable: false },
					name: { type: 'text', nullable: false },
					email: { type: 'text', nullable: false },
					active: { type: 'boolean', nullable: false },
				},
				posts: {
					id: { type: 'integer', nullable: false },
					title: { type: 'text', nullable: false },
					user_id: { type: 'integer', nullable: false },
				},
				products: {
					id: { type: 'integer', nullable: false },
					title: { type: 'text', nullable: false },
					categoryId: { type: 'integer', nullable: false },
				},
				categories: {
					id: { type: 'integer', nullable: false },
					name: { type: 'text', nullable: false },
				},
			},
		};

		it('SC-12: should parse INSERT with FK lookup (from table where)', () => {
			// Arrange - products insert title = 'Phone', categoryId = id from categories where name = 'Electronics'
			const tokens = [
				'products',
				'insert',
				'title',
				'=',
				'Phone',
				',',
				'categoryId',
				'=',
				'id',
				'from',
				'categories',
				'where',
				'name',
				'=',
				'Electronics',
			];

			// Act
			const result = parseInsert(tokens, 'products', 2, mockSchemaWithProducts);

			// Assert
			expect(result.type).toBe('insert');
			expect(result.table).toBe('products');
			expect(result.assignments).toHaveLength(2);
			expect(result.fromClause).toBeDefined();
			expect(result.fromClause?.table).toBe('categories');
			expect(result.fromClause?.bulk).toBe(false);
			expect(result.fromClause?.where).toEqual([
				{ column: 'name', operator: '=', value: 'Electronics' },
			]);
		});

		it('SC-13: should parse INSERT FROM with FOR UPDATE', () => {
			// Arrange - products insert categoryId = id from categories where name = 'Electronics' for update
			const tokens = [
				'products',
				'insert',
				'title',
				'=',
				'Phone',
				',',
				'categoryId',
				'=',
				'id',
				'from',
				'categories',
				'where',
				'name',
				'=',
				'Electronics',
				'for',
				'update',
			];

			// Act
			const result = parseInsert(tokens, 'products', 2, mockSchemaWithProducts);

			// Assert
			expect(result.fromClause).toBeDefined();
			expect(result.fromClause?.forUpdate).toBe(true);
			expect(result.fromClause?.skipLocked).toBeUndefined();
		});

		it('SC-13 extended: should parse FOR UPDATE SKIP LOCKED', () => {
			const tokens = [
				'products',
				'insert',
				'title',
				'=',
				'Phone',
				'from',
				'categories',
				'for',
				'update',
				'skip',
				'locked',
			];

			const result = parseInsert(tokens, 'products', 2, mockSchemaWithProducts);

			expect(result.fromClause?.forUpdate).toBe(true);
			expect(result.fromClause?.skipLocked).toBe(true);
		});

		it('SC-14: should parse INSERT FROM EACH (bulk insert)', () => {
			// Arrange - products insert title = name, categoryId = cat_id from each source_data where active = true
			const tokens = [
				'products',
				'insert',
				'title',
				'=',
				'name',
				',',
				'categoryId',
				'=',
				'cat_id',
				'from',
				'each',
				'source_data',
				'where',
				'active',
				'=',
				'true',
			];

			// Act
			const result = parseInsert(tokens, 'products', 2, mockSchemaWithProducts);

			// Assert
			expect(result.fromClause).toBeDefined();
			expect(result.fromClause?.bulk).toBe(true);
			expect(result.fromClause?.table).toBe('source_data');
			expect(result.fromClause?.where).toEqual([
				{ column: 'active', operator: '=', value: true },
			]);
		});

		it('should parse FROM with alias', () => {
			const tokens = [
				'products',
				'insert',
				'title',
				'=',
				'name',
				'from',
				'categories',
				'as',
				'c',
				'where',
				'name',
				'=',
				'Tech',
			];

			const result = parseInsert(tokens, 'products', 2, mockSchemaWithProducts);

			expect(result.fromClause?.table).toBe('categories');
			expect(result.fromClause?.alias).toBe('c');
		});

		it('should parse simple FROM without WHERE', () => {
			const tokens = [
				'products',
				'insert',
				'title',
				'=',
				'name',
				'from',
				'categories',
			];

			const result = parseInsert(tokens, 'products', 2, mockSchemaWithProducts);

			expect(result.fromClause?.table).toBe('categories');
			expect(result.fromClause?.where).toBeUndefined();
		});

		it('should parse FROM with multiple WHERE conditions', () => {
			const tokens = [
				'products',
				'insert',
				'title',
				'=',
				'name',
				'from',
				'categories',
				'where',
				'active',
				'=',
				'true',
				'and',
				'id',
				'>',
				'5',
			];

			const result = parseInsert(tokens, 'products', 2, mockSchemaWithProducts);

			expect(result.fromClause?.where).toEqual([
				{ column: 'active', operator: '=', value: true },
				{ column: 'id', operator: '>', value: 5 },
			]);
		});

		it('should parse INSERT FROM with execute immediate flag', () => {
			const tokens = [
				'products',
				'insert',
				'title',
				'=',
				'name',
				'from',
				'categories',
				'!',
			];

			const result = parseInsert(tokens, 'products', 2, mockSchemaWithProducts);

			expect(result.fromClause?.table).toBe('categories');
			expect(result.executeImmediate).toBe(true);
		});
	});
});

/**
 * CLI-NQL Block 7: Recursive Relations Parser Tests
 * SC-15, SC-16, SC-17: Ancestors/Descendants traversal
 */
describe('getRecursiveRelationInfo', () => {
	describe('recursive relation detection', () => {
		it('should detect ancestors recursive relation with up direction', () => {
			// Arrange
			const relationKey = 'categories.ancestors';

			// Act
			const result = getRecursiveRelationInfo(relationKey, recursiveSchema);

			// Assert
			expect(result).toBeDefined();
			expect(result?.direction).toBe('up');
			expect(result?.through).toBe('parent');
			expect(result?.maxDepth).toBe(10);
		});

		it('should detect descendants recursive relation with down direction', () => {
			// Arrange
			const relationKey = 'categories.descendants';

			// Act
			const result = getRecursiveRelationInfo(relationKey, recursiveSchema);

			// Assert
			expect(result).toBeDefined();
			expect(result?.direction).toBe('down');
			expect(result?.through).toBe('children');
			expect(result?.maxDepth).toBe(5);
		});

		it('should return undefined for non-recursive relations', () => {
			// Arrange
			const relationKey = 'categories.parent';

			// Act
			const result = getRecursiveRelationInfo(relationKey, recursiveSchema);

			// Assert
			expect(result).toBeUndefined();
		});

		it('should return undefined for unknown relations', () => {
			// Arrange
			const relationKey = 'categories.unknown';

			// Act
			const result = getRecursiveRelationInfo(relationKey, recursiveSchema);

			// Assert
			expect(result).toBeUndefined();
		});

		it('should detect employee reports with custom maxDepth', () => {
			// Arrange
			const relationKey = 'employees.reports';

			// Act
			const result = getRecursiveRelationInfo(relationKey, recursiveSchema);

			// Assert
			expect(result).toBeDefined();
			expect(result?.direction).toBe('down');
			expect(result?.through).toBe('reports');
			expect(result?.maxDepth).toBe(10);
		});
	});
});

describe('parseExistenceCheck with recursive relations', () => {
	it('should attach recursive info when checking ancestors', () => {
		// Arrange
		const tokens = ['has', 'ancestors'];

		// Act
		const result = parseExistenceCheck(
			tokens,
			0,
			recursiveSchema,
			'categories',
		);

		// Assert
		expect(result.check.type).toBe('exists');
		expect(result.check.relation).toBe('ancestors');
		expect(result.check.recursive).toBeDefined();
		expect(result.check.recursive?.direction).toBe('up');
		expect(result.check.recursive?.through).toBe('parent');
	});

	it('should attach recursive info when checking descendants', () => {
		// Arrange
		const tokens = ['has', 'descendants'];

		// Act
		const result = parseExistenceCheck(
			tokens,
			0,
			recursiveSchema,
			'categories',
		);

		// Assert
		expect(result.check.type).toBe('exists');
		expect(result.check.relation).toBe('descendants');
		expect(result.check.recursive).toBeDefined();
		expect(result.check.recursive?.direction).toBe('down');
		expect(result.check.recursive?.maxDepth).toBe(5);
	});

	it('should not attach recursive info for non-recursive relations', () => {
		// Arrange
		const tokens = ['has', 'parent'];

		// Act
		const result = parseExistenceCheck(
			tokens,
			0,
			recursiveSchema,
			'categories',
		);

		// Assert
		expect(result.check.type).toBe('exists');
		expect(result.check.relation).toBe('parent');
		expect(result.check.recursive).toBeUndefined();
	});

	it('should work with not has for recursive relations', () => {
		// Arrange
		const tokens = ['not', 'has', 'ancestors'];

		// Act
		const result = parseExistenceCheck(
			tokens,
			0,
			recursiveSchema,
			'categories',
		);

		// Assert
		expect(result.check.type).toBe('not_exists');
		expect(result.check.relation).toBe('ancestors');
		expect(result.check.recursive).toBeDefined();
		expect(result.check.recursive?.direction).toBe('up');
	});

	it('should parse recursive check with nested where conditions', () => {
		// Arrange - "has ancestors where name = 'Electronics'"
		const tokens = ['has', 'ancestors', 'where', 'name', '=', 'Electronics'];

		// Act
		const result = parseExistenceCheck(
			tokens,
			0,
			recursiveSchema,
			'categories',
		);

		// Assert
		expect(result.check.type).toBe('exists');
		expect(result.check.relation).toBe('ancestors');
		expect(result.check.recursive).toBeDefined();
		expect(result.check.where).toBeDefined();
		expect(result.check.where?.[0]).toEqual({
			column: 'name',
			operator: '=',
			value: 'Electronics',
		});
	});

	it('should work without schema (backwards compatibility)', () => {
		// Arrange
		const tokens = ['has', 'ancestors'];

		// Act
		const result = parseExistenceCheck(tokens, 0);

		// Assert
		expect(result.check.type).toBe('exists');
		expect(result.check.relation).toBe('ancestors');
		expect(result.check.recursive).toBeUndefined();
	});
});

/**
 * CLI-NQL Block 8: Window Expression Parser Tests
 * SC-18, SC-19, SC-20: Window functions
 */
describe('isWindowFunction', () => {
	it('should recognize window-only functions', () => {
		expect(isWindowFunction('rank')).toBe(true);
		expect(isWindowFunction('dense_rank')).toBe(true);
		expect(isWindowFunction('row_number')).toBe(true);
		expect(isWindowFunction('lag')).toBe(true);
		expect(isWindowFunction('lead')).toBe(true);
	});

	it('should recognize aggregate functions', () => {
		expect(isWindowFunction('count')).toBe(true);
		expect(isWindowFunction('sum')).toBe(true);
		expect(isWindowFunction('avg')).toBe(true);
		expect(isWindowFunction('min')).toBe(true);
		expect(isWindowFunction('max')).toBe(true);
	});

	it('should be case-insensitive', () => {
		expect(isWindowFunction('RANK')).toBe(true);
		expect(isWindowFunction('Sum')).toBe(true);
	});

	it('should reject non-window functions', () => {
		expect(isWindowFunction('unknown')).toBe(false);
		expect(isWindowFunction('select')).toBe(false);
	});
});

describe('isWindowOnlyFunction', () => {
	it('should recognize window-only functions', () => {
		expect(isWindowOnlyFunction('rank')).toBe(true);
		expect(isWindowOnlyFunction('dense_rank')).toBe(true);
		expect(isWindowOnlyFunction('row_number')).toBe(true);
	});

	it('should reject aggregate functions', () => {
		expect(isWindowOnlyFunction('sum')).toBe(false);
		expect(isWindowOnlyFunction('count')).toBe(false);
	});
});

describe('isWindowExpression', () => {
	it('should detect rank() over pattern', () => {
		const tokens = ['rank', '(', ')', 'over', '(', 'order', 'by', 'id', ')'];
		expect(isWindowExpression(tokens, 0)).toBe(true);
	});

	it('should detect sum(col) over pattern', () => {
		const tokens = ['sum', '(', 'total', ')', 'over', '(', ')'];
		expect(isWindowExpression(tokens, 0)).toBe(true);
	});

	it('should reject function without over', () => {
		const tokens = ['count', '(', '*', ')'];
		expect(isWindowExpression(tokens, 0)).toBe(false);
	});

	it('should reject non-window functions', () => {
		const tokens = ['lower', '(', 'name', ')', 'over', '(', ')'];
		expect(isWindowExpression(tokens, 0)).toBe(false);
	});
});

describe('parseWindowExpression', () => {
	describe('SC-18: Rank with partition', () => {
		it('should parse rank() over (partition by categoryId order by price desc)', () => {
			// Arrange
			const tokens = [
				'rank',
				'(',
				')',
				'over',
				'(',
				'partition',
				'by',
				'categoryId',
				'order',
				'by',
				'price',
				'desc',
				')',
				'as',
				'priceRank',
			];

			// Act
			const result = parseWindowExpression(tokens, 0);

			// Assert
			expect(result.expr.function).toBe('rank');
			expect(result.expr.args).toEqual([]);
			expect(result.expr.spec.partitionBy).toEqual(['categoryId']);
			expect(result.expr.spec.orderBy).toEqual([
				{ column: 'price', direction: 'desc' },
			]);
			expect(result.expr.alias).toBe('priceRank');
		});
	});

	describe('SC-19: Running total', () => {
		it('should parse sum(total) over (order by createdAt) as runningTotal', () => {
			// Arrange
			const tokens = [
				'sum',
				'(',
				'total',
				')',
				'over',
				'(',
				'order',
				'by',
				'createdAt',
				')',
				'as',
				'runningTotal',
			];

			// Act
			const result = parseWindowExpression(tokens, 0);

			// Assert
			expect(result.expr.function).toBe('sum');
			expect(result.expr.args).toEqual(['total']);
			expect(result.expr.spec.partitionBy).toBeUndefined();
			expect(result.expr.spec.orderBy).toEqual([
				{ column: 'createdAt', direction: 'asc' },
			]);
			expect(result.expr.alias).toBe('runningTotal');
		});
	});

	describe('SC-20: Row number without partition', () => {
		it('should parse row_number() over (order by createdAt) as rowNum', () => {
			// Arrange
			const tokens = [
				'row_number',
				'(',
				')',
				'over',
				'(',
				'order',
				'by',
				'createdAt',
				')',
				'as',
				'rowNum',
			];

			// Act
			const result = parseWindowExpression(tokens, 0);

			// Assert
			expect(result.expr.function).toBe('row_number');
			expect(result.expr.args).toEqual([]);
			expect(result.expr.spec.partitionBy).toBeUndefined();
			expect(result.expr.spec.orderBy).toEqual([
				{ column: 'createdAt', direction: 'asc' },
			]);
			expect(result.expr.alias).toBe('rowNum');
		});
	});

	describe('lag and lead functions', () => {
		it('should parse lag(price, 1, 0) over (order by id)', () => {
			// Arrange
			const tokens = [
				'lag',
				'(',
				'price',
				',',
				'1',
				',',
				'0',
				')',
				'over',
				'(',
				'order',
				'by',
				'id',
				')',
			];

			// Act
			const result = parseWindowExpression(tokens, 0);

			// Assert
			expect(result.expr.function).toBe('lag');
			expect(result.expr.args).toEqual(['price', '1', '0']);
			expect(result.expr.spec.orderBy).toEqual([
				{ column: 'id', direction: 'asc' },
			]);
		});
	});

	describe('dense_rank function', () => {
		it('should parse dense_rank() over (order by score desc)', () => {
			// Arrange
			const tokens = [
				'dense_rank',
				'(',
				')',
				'over',
				'(',
				'order',
				'by',
				'score',
				'desc',
				')',
			];

			// Act
			const result = parseWindowExpression(tokens, 0);

			// Assert
			expect(result.expr.function).toBe('dense_rank');
			expect(result.expr.spec.orderBy).toEqual([
				{ column: 'score', direction: 'desc' },
			]);
			expect(result.expr.alias).toBeUndefined();
		});
	});

	describe('multiple partition columns', () => {
		it('should parse partition by with multiple columns', () => {
			// Arrange
			const tokens = [
				'count',
				'(',
				'*',
				')',
				'over',
				'(',
				'partition',
				'by',
				'region',
				',',
				'year',
				')',
			];

			// Act
			const result = parseWindowExpression(tokens, 0);

			// Assert
			expect(result.expr.function).toBe('count');
			expect(result.expr.args).toEqual(['*']);
			expect(result.expr.spec.partitionBy).toEqual(['region', 'year']);
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

// =============================================================================
// CLI-NQL: Path Expression Parser Tests
// =============================================================================

import {
	columnToPath,
	getPathLeaf,
	getPathRoot,
	isQualifiedPath,
	isQuotedIdentifier,
	isSimpleColumn,
	parseIdentifier,
	parsePathExpression,
	pathToString,
	RESERVED_KEYWORDS,
} from './parser.js';

describe('CLI-NQL: Path Expression Parser', () => {
	describe('isQuotedIdentifier', () => {
		it('should return true for double-quoted strings', () => {
			// Arrange & Act & Assert
			expect(isQuotedIdentifier('"name"')).toBe(true);
			expect(isQuotedIdentifier('"children"')).toBe(true);
			expect(isQuotedIdentifier('"where"')).toBe(true);
		});

		it('should return false for unquoted strings', () => {
			// Arrange & Act & Assert
			expect(isQuotedIdentifier('name')).toBe(false);
			expect(isQuotedIdentifier('children')).toBe(false);
		});

		it('should return false for single-quoted strings', () => {
			// Arrange & Act & Assert
			expect(isQuotedIdentifier("'name'")).toBe(false);
			expect(isQuotedIdentifier("'hello world'")).toBe(false);
		});

		it('should return false for empty or minimal strings', () => {
			// Arrange & Act & Assert
			expect(isQuotedIdentifier('')).toBe(false);
			expect(isQuotedIdentifier('"')).toBe(false);
		});
	});

	describe('parseIdentifier', () => {
		it('should parse unquoted identifier', () => {
			// Arrange & Act
			const result = parseIdentifier('name');

			// Assert
			expect(result).toEqual({ name: 'name', quoted: false });
		});

		it('should parse quoted identifier', () => {
			// Arrange & Act
			const result = parseIdentifier('"children"');

			// Assert
			expect(result).toEqual({ name: 'children', quoted: true });
		});

		it('should handle reserved keyword as quoted identifier', () => {
			// Arrange & Act
			const result = parseIdentifier('"where"');

			// Assert
			expect(result).toEqual({ name: 'where', quoted: true });
		});
	});

	describe('parsePathExpression', () => {
		describe('when parsing simple paths', () => {
			it('should parse single segment path', () => {
				// Arrange & Act
				const result = parsePathExpression('name');

				// Assert
				expect(result.segments).toHaveLength(1);
				expect(result.segments[0]).toEqual({ name: 'name', quoted: false });
				expect(result.raw).toBe('name');
			});

			it('should parse two-segment path', () => {
				// Arrange & Act
				const result = parsePathExpression('category.name');

				// Assert
				expect(result.segments).toHaveLength(2);
				expect(result.segments[0]).toEqual({ name: 'category', quoted: false });
				expect(result.segments[1]).toEqual({ name: 'name', quoted: false });
				expect(result.raw).toBe('category.name');
			});

			it('should parse N-level path', () => {
				// Arrange & Act
				const result = parsePathExpression('product.category.parent.name');

				// Assert
				expect(result.segments).toHaveLength(4);
				expect(result.segments[0]).toEqual({ name: 'product', quoted: false });
				expect(result.segments[1]).toEqual({ name: 'category', quoted: false });
				expect(result.segments[2]).toEqual({ name: 'parent', quoted: false });
				expect(result.segments[3]).toEqual({ name: 'name', quoted: false });
			});
		});

		describe('when parsing quoted identifiers', () => {
			it('should parse single quoted identifier', () => {
				// Arrange & Act
				const result = parsePathExpression('"children"');

				// Assert
				expect(result.segments).toHaveLength(1);
				expect(result.segments[0]).toEqual({ name: 'children', quoted: true });
			});

			it('should handle quoted identifier in path', () => {
				// Arrange
				// Note: Double-quoted identifiers indicate quoted column names (SQL standard)
				// "name" means: force column interpretation, bypass relation lookup
				const result = parsePathExpression('category."name"');

				// Assert
				expect(result.segments).toHaveLength(2);
				expect(result.segments[0]).toEqual({ name: 'category', quoted: false });
				expect(result.segments[1]).toEqual({ name: 'name', quoted: true }); // Quotes stripped, marked as quoted
			});
		});

		describe('when handling edge cases', () => {
			it('should skip empty segments from leading dots', () => {
				// This edge case shouldn't happen in practice but tests robustness
				const result = parsePathExpression('.name');
				expect(result.segments).toHaveLength(1);
				expect(result.segments[0].name).toBe('name');
			});

			it('should skip empty segments from trailing dots', () => {
				const result = parsePathExpression('name.');
				expect(result.segments).toHaveLength(1);
				expect(result.segments[0].name).toBe('name');
			});
		});
	});

	describe('pathToString', () => {
		it('should convert simple path to string', () => {
			// Arrange
			const path = parsePathExpression('category.name');

			// Act
			const result = pathToString(path);

			// Assert
			expect(result).toBe('category.name');
		});

		it('should preserve quotes in output', () => {
			// Arrange
			const path = {
				segments: [
					{ name: 'category', quoted: false },
					{ name: 'children', quoted: true },
				],
				raw: 'category."children"',
			};

			// Act
			const result = pathToString(path);

			// Assert
			expect(result).toBe('category."children"');
		});
	});

	describe('isSimpleColumn', () => {
		it('should return true for single unquoted segment', () => {
			// Arrange
			const path = parsePathExpression('name');

			// Act & Assert
			expect(isSimpleColumn(path)).toBe(true);
		});

		it('should return false for quoted segment', () => {
			// Arrange
			const path = {
				segments: [{ name: 'name', quoted: true }],
				raw: '"name"',
			};

			// Act & Assert
			expect(isSimpleColumn(path)).toBe(false);
		});

		it('should return false for multi-segment path', () => {
			// Arrange
			const path = parsePathExpression('category.name');

			// Act & Assert
			expect(isSimpleColumn(path)).toBe(false);
		});
	});

	describe('isQualifiedPath', () => {
		it('should return true for multi-segment path', () => {
			// Arrange
			const path = parsePathExpression('category.name');

			// Act & Assert
			expect(isQualifiedPath(path)).toBe(true);
		});

		it('should return false for single-segment path', () => {
			// Arrange
			const path = parsePathExpression('name');

			// Act & Assert
			expect(isQualifiedPath(path)).toBe(false);
		});
	});

	describe('getPathRoot', () => {
		it('should return first segment', () => {
			// Arrange
			const path = parsePathExpression('category.parent.name');

			// Act
			const root = getPathRoot(path);

			// Assert
			expect(root).toEqual({ name: 'category', quoted: false });
		});
	});

	describe('getPathLeaf', () => {
		it('should return last segment', () => {
			// Arrange
			const path = parsePathExpression('category.parent.name');

			// Act
			const leaf = getPathLeaf(path);

			// Assert
			expect(leaf).toEqual({ name: 'name', quoted: false });
		});
	});

	describe('columnToPath', () => {
		it('should convert legacy column string to PathExpression', () => {
			// Arrange & Act
			const path = columnToPath('category.name');

			// Assert
			expect(path.segments).toHaveLength(2);
			expect(path.raw).toBe('category.name');
		});
	});

	describe('RESERVED_KEYWORDS', () => {
		it('should contain SQL keywords', () => {
			// Assert
			expect(RESERVED_KEYWORDS.has('select')).toBe(true);
			expect(RESERVED_KEYWORDS.has('where')).toBe(true);
			expect(RESERVED_KEYWORDS.has('from')).toBe(true);
			expect(RESERVED_KEYWORDS.has('and')).toBe(true);
			expect(RESERVED_KEYWORDS.has('or')).toBe(true);
		});

		it('should contain NQL-specific keywords', () => {
			// Assert
			expect(RESERVED_KEYWORDS.has('include')).toBe(true);
			expect(RESERVED_KEYWORDS.has('has')).toBe(true);
			expect(RESERVED_KEYWORDS.has('ancestors')).toBe(true);
			expect(RESERVED_KEYWORDS.has('descendants')).toBe(true);
		});
	});
});

// =============================================================================
// CLI-NQL: Subquery Parser Tests (Block 3)
// =============================================================================

import {
	createSubqueryValue,
	isSubqueryStart,
	parseSubquery,
} from './parser.js';

describe('CLI-NQL: Subquery Parser', () => {
	describe('isSubqueryStart', () => {
		it('should return true for subquery start token', () => {
			// Arrange & Act & Assert
			expect(isSubqueryStart('(categories')).toBe(true);
			expect(isSubqueryStart('(users')).toBe(true);
			expect(isSubqueryStart('(products')).toBe(true);
		});

		it('should return false for undefined or empty', () => {
			// Arrange & Act & Assert
			expect(isSubqueryStart(undefined)).toBe(false);
			expect(isSubqueryStart('')).toBe(false);
		});

		it('should return false for non-parenthesis tokens', () => {
			// Arrange & Act & Assert
			expect(isSubqueryStart('categories')).toBe(false);
			expect(isSubqueryStart('users')).toBe(false);
		});

		it('should return false for just opening paren', () => {
			// Just '(' alone is not a valid subquery start
			expect(isSubqueryStart('(')).toBe(false);
		});
	});

	describe('parseSubquery', () => {
		describe('when parsing simple subqueries', () => {
			it('should parse subquery without WHERE clause', () => {
				// Arrange
				const tokens = ['(categories', ')'];

				// Act
				const result = parseSubquery(tokens, 0);

				// Assert
				expect(result.subquery).toEqual({ table: 'categories' });
				expect(result.nextIndex).toBe(2);
			});

			it('should parse subquery with simple WHERE clause', () => {
				// Arrange - simulating: (categories where name = 'Electronics')
				const tokens = ['(categories', 'where', 'name', '=', 'Electronics)'];

				// Act
				const result = parseSubquery(tokens, 0);

				// Assert
				expect(result.subquery.table).toBe('categories');
				expect(result.subquery.where).toEqual([
					{ column: 'name', operator: '=', value: 'Electronics' },
				]);
				expect(result.nextIndex).toBe(5);
			});

			it('should parse subquery with boolean condition (SC-06)', () => {
				// Arrange - simulating: (categories where active = true)
				const tokens = ['(categories', 'where', 'active', '=', 'true)'];

				// Act
				const result = parseSubquery(tokens, 0);

				// Assert
				expect(result.subquery.table).toBe('categories');
				expect(result.subquery.where).toEqual([
					{ column: 'active', operator: '=', value: true },
				]);
			});

			it('should parse subquery with number condition', () => {
				// Arrange - simulating: (categories where id = 1)
				const tokens = ['(categories', 'where', 'id', '=', '1)'];

				// Act
				const result = parseSubquery(tokens, 0);

				// Assert
				expect(result.subquery.where).toEqual([
					{ column: 'id', operator: '=', value: 1 },
				]);
			});

			it('should parse subquery with separate closing paren', () => {
				// Arrange - simulating: (categories where id = 1 )
				const tokens = ['(categories', 'where', 'id', '=', '1', ')'];

				// Act
				const result = parseSubquery(tokens, 0);

				// Assert
				expect(result.subquery.table).toBe('categories');
				expect(result.subquery.where).toEqual([
					{ column: 'id', operator: '=', value: 1 },
				]);
				expect(result.nextIndex).toBe(6);
			});
		});

		describe('when parsing subqueries with multiple conditions', () => {
			it('should parse subquery with AND conditions', () => {
				// Arrange - simulating: (categories where active = true and name = 'X')
				const tokens = [
					'(categories',
					'where',
					'active',
					'=',
					'true',
					'and',
					'name',
					'=',
					'X)',
				];

				// Act
				const result = parseSubquery(tokens, 0);

				// Assert
				expect(result.subquery.where).toHaveLength(2);
				expect(result.subquery.where?.[0]).toEqual({
					column: 'active',
					operator: '=',
					value: true,
				});
				expect(result.subquery.where?.[1]).toEqual({
					column: 'name',
					operator: '=',
					value: 'X',
				});
			});
		});

		describe('when parsing subqueries with SELECT clause', () => {
			it('should parse explicit column selection', () => {
				// Arrange - simulating: (categories where name = 'X' select id)
				const tokens = [
					'(categories',
					'where',
					'name',
					'=',
					'X',
					'select',
					'id)',
				];

				// Act
				const result = parseSubquery(tokens, 0);

				// Assert
				expect(result.subquery.table).toBe('categories');
				expect(result.subquery.selectColumn).toBe('id');
			});

			it('should parse select with separate closing paren', () => {
				// Arrange - simulating: (categories select name )
				const tokens = ['(categories', 'select', 'name', ')'];

				// Act
				const result = parseSubquery(tokens, 0);

				// Assert
				expect(result.subquery.table).toBe('categories');
				expect(result.subquery.selectColumn).toBe('name');
				expect(result.subquery.where).toBeUndefined();
			});
		});

		describe('when handling errors', () => {
			it('should throw for missing table name', () => {
				// Arrange
				const tokens = ['(', ')'];

				// Act & Assert
				expect(() => parseSubquery(tokens, 0)).toThrow();
			});

			it('should throw for incomplete WHERE condition', () => {
				// Arrange - missing value
				const tokens = ['(categories', 'where', 'name', '='];

				// Act & Assert
				expect(() => parseSubquery(tokens, 0)).toThrow(
					'Incomplete WHERE condition',
				);
			});
		});
	});

	describe('createSubqueryValue', () => {
		it('should create SubqueryValue wrapper', () => {
			// Arrange
			const subquery = { table: 'categories' };

			// Act
			const result = createSubqueryValue(subquery);

			// Assert
			expect(result).toEqual({
				type: 'subquery',
				subquery: { table: 'categories' },
			});
		});
	});

	describe('integration with parseNaturalQuery', () => {
		// Mock schema for subquery tests
		const schemaWithCategories: ResolvedSchema = {
			tables: {
				products: {
					id: { type: 'integer', nullable: false },
					categoryId: { type: 'integer', nullable: false },
					name: { type: 'text', nullable: false },
				},
				categories: {
					id: { type: 'integer', nullable: false },
					name: { type: 'text', nullable: false },
					active: { type: 'boolean', nullable: false },
					deprecated: { type: 'boolean', nullable: false },
				},
			},
			relations: {},
		};

		it('should parse scalar subquery in comparison (SC-05)', () => {
			// Arrange - SC-05: products where categoryId = (categories where name = 'Electronics')
			const query =
				"products where categoryId = (categories where name = 'Electronics')";

			// Act
			const result = parseNaturalQuery(query, schemaWithCategories);

			// Assert
			expect(result.table).toBe('products');
			expect(result.where).toHaveLength(1);
			const condition = result.where?.[0];
			expect(condition?.column).toBe('categoryId');
			expect(condition?.operator).toBe('=');
			// Value should be a SubqueryValue
			const value = condition?.value as { type: string; subquery: unknown };
			expect(value.type).toBe('subquery');
			expect(value.subquery).toEqual({
				table: 'categories',
				where: [{ column: 'name', operator: '=', value: 'Electronics' }],
			});
		});

		it('should parse IN subquery (SC-06)', () => {
			// Arrange - SC-06: products where categoryId in (categories where active = true)
			const query =
				'products where categoryId in (categories where active = true)';

			// Act
			const result = parseNaturalQuery(query, schemaWithCategories);

			// Assert
			expect(result.table).toBe('products');
			expect(result.where).toHaveLength(1);
			const condition = result.where?.[0];
			expect(condition?.operator).toBe('in');
			const value = condition?.value as { type: string; subquery: unknown };
			expect(value.type).toBe('subquery');
			expect(value.subquery).toEqual({
				table: 'categories',
				where: [{ column: 'active', operator: '=', value: true }],
			});
		});

		it('should parse NOT IN subquery (SC-07 extended)', () => {
			// Arrange - products where categoryId not in (categories where discontinued = true)
			const query =
				'products where categoryId not in (categories where discontinued = true)';

			// Act
			const result = parseNaturalQuery(query, schemaWithCategories);

			// Assert
			expect(result.table).toBe('products');
			expect(result.where).toHaveLength(1);
			const condition = result.where?.[0];
			expect(condition?.column).toBe('categoryId');
			expect(condition?.operator).toBe('not in');
			const value = condition?.value as { type: string; subquery: unknown };
			expect(value.type).toBe('subquery');
			expect(value.subquery).toEqual({
				table: 'categories',
				where: [{ column: 'discontinued', operator: '=', value: true }],
			});
		});

		it('should parse NOT IN with simple subquery (no WHERE)', () => {
			// Arrange - products where categoryId not in (categories)
			const query = 'products where categoryId not in (categories)';

			// Act
			const result = parseNaturalQuery(query, schemaWithCategories);

			// Assert
			expect(result.table).toBe('products');
			expect(result.where).toHaveLength(1);
			const condition = result.where?.[0];
			expect(condition?.column).toBe('categoryId');
			expect(condition?.operator).toBe('not in');
			const value = condition?.value as { type: string; subquery: unknown };
			expect(value.type).toBe('subquery');
			expect(value.subquery).toEqual({ table: 'categories' });
		});
	});
});

// =============================================================================
// CLI-NQL: Existence Check Parser Tests (Block 4)
// =============================================================================

import { isExistenceCheck, parseExistenceCheck } from './parser.js';

describe('CLI-NQL: Existence Check Parser', () => {
	describe('isExistenceCheck', () => {
		it('should return true for "has" keyword', () => {
			// Arrange & Act & Assert
			expect(isExistenceCheck(['has', 'products'], 0)).toBe(true);
			expect(isExistenceCheck(['has', 'posts'], 0)).toBe(true);
		});

		it('should return true for "not has" keywords', () => {
			// Arrange & Act & Assert
			expect(isExistenceCheck(['not', 'has', 'products'], 0)).toBe(true);
			expect(isExistenceCheck(['not', 'has', 'posts'], 0)).toBe(true);
		});

		it('should return false for regular tokens', () => {
			// Arrange & Act & Assert
			expect(isExistenceCheck(['name', '=', 'value'], 0)).toBe(false);
			expect(isExistenceCheck(['active', '=', 'true'], 0)).toBe(false);
		});

		it('should return false for "not" without "has"', () => {
			// Arrange & Act & Assert
			expect(isExistenceCheck(['not', 'null'], 0)).toBe(false);
			expect(isExistenceCheck(['not', 'active'], 0)).toBe(false);
		});

		it('should handle empty/undefined tokens', () => {
			// Arrange & Act & Assert
			expect(isExistenceCheck([], 0)).toBe(false);
			expect(isExistenceCheck(['has'], 5)).toBe(false); // out of bounds
		});

		it('should work at different positions', () => {
			// Arrange & Act & Assert
			expect(isExistenceCheck(['where', 'has', 'products'], 1)).toBe(true);
			expect(isExistenceCheck(['and', 'not', 'has', 'posts'], 1)).toBe(true);
		});
	});

	describe('parseExistenceCheck', () => {
		describe('when parsing simple existence check', () => {
			it('should parse "has relation"', () => {
				// Arrange
				const tokens = ['has', 'products'];

				// Act
				const result = parseExistenceCheck(tokens, 0);

				// Assert
				expect(result.check).toEqual({
					type: 'exists',
					relation: 'products',
				});
				expect(result.nextIndex).toBe(2);
			});

			it('should parse "not has relation"', () => {
				// Arrange
				const tokens = ['not', 'has', 'products'];

				// Act
				const result = parseExistenceCheck(tokens, 0);

				// Assert
				expect(result.check).toEqual({
					type: 'not_exists',
					relation: 'products',
				});
				expect(result.nextIndex).toBe(3);
			});
		});

		describe('when parsing existence check with WHERE clause', () => {
			it('should parse "has relation where condition"', () => {
				// Arrange
				const tokens = ['has', 'products', 'where', 'rating', '>', '4'];

				// Act
				const result = parseExistenceCheck(tokens, 0);

				// Assert
				expect(result.check).toEqual({
					type: 'exists',
					relation: 'products',
					where: [{ column: 'rating', operator: '>', value: 4 }],
				});
				expect(result.nextIndex).toBe(6);
			});

			it('should parse "not has relation where condition"', () => {
				// Arrange
				const tokens = [
					'not',
					'has',
					'posts',
					'where',
					'published',
					'=',
					'false',
				];

				// Act
				const result = parseExistenceCheck(tokens, 0);

				// Assert
				expect(result.check).toEqual({
					type: 'not_exists',
					relation: 'posts',
					where: [{ column: 'published', operator: '=', value: false }],
				});
				expect(result.nextIndex).toBe(7);
			});

			it('should parse multiple conditions with AND', () => {
				// Arrange
				const tokens = [
					'has',
					'products',
					'where',
					'rating',
					'>',
					'4',
					'and',
					'active',
					'=',
					'true',
				];

				// Act
				const result = parseExistenceCheck(tokens, 0);

				// Assert
				expect(result.check.type).toBe('exists');
				expect(result.check.relation).toBe('products');
				expect(result.check.where).toHaveLength(2);
				expect(result.check.where?.[0]).toEqual({
					column: 'rating',
					operator: '>',
					value: 4,
				});
				expect(result.check.where?.[1]).toEqual({
					column: 'active',
					operator: '=',
					value: true,
				});
			});

			it('should handle string values in WHERE', () => {
				// Arrange
				const tokens = ['has', 'products', 'where', 'name', '=', "'Phone'"];

				// Act
				const result = parseExistenceCheck(tokens, 0);

				// Assert
				expect(result.check.where?.[0]).toEqual({
					column: 'name',
					operator: '=',
					value: 'Phone',
				});
			});

			it('should handle null values in WHERE', () => {
				// Arrange
				const tokens = ['has', 'products', 'where', 'deletedAt', '=', 'null'];

				// Act
				const result = parseExistenceCheck(tokens, 0);

				// Assert
				expect(result.check.where?.[0]).toEqual({
					column: 'deletedAt',
					operator: '=',
					value: null,
				});
			});
		});

		describe('when stopping at keywords', () => {
			it('should stop at LIMIT keyword', () => {
				// Arrange
				const tokens = ['has', 'products', 'limit', '10'];

				// Act
				const result = parseExistenceCheck(tokens, 0);

				// Assert
				expect(result.check).toEqual({
					type: 'exists',
					relation: 'products',
				});
				expect(result.nextIndex).toBe(2);
			});

			it('should stop at INCLUDE keyword', () => {
				// Arrange
				const tokens = ['has', 'products', 'include', 'reviews'];

				// Act
				const result = parseExistenceCheck(tokens, 0);

				// Assert
				expect(result.nextIndex).toBe(2);
			});

			it('should stop at another existence check (and has)', () => {
				// Arrange
				const tokens = [
					'has',
					'products',
					'where',
					'active',
					'=',
					'true',
					'and',
					'has',
					'reviews',
				];

				// Act
				const result = parseExistenceCheck(tokens, 0);

				// Assert - should only parse first existence check
				expect(result.check.relation).toBe('products');
				expect(result.check.where).toHaveLength(1);
				expect(result.nextIndex).toBe(6); // stops before 'and has'
			});
		});
	});

	describe('integration with parseNaturalQuery', () => {
		// Mock schema for existence check tests
		const schemaWithRelations: ResolvedSchema = {
			tables: {
				categories: {
					id: { type: 'integer', nullable: false },
					name: { type: 'text', nullable: false },
				},
				products: {
					id: { type: 'integer', nullable: false },
					categoryId: { type: 'integer', nullable: false },
					name: { type: 'text', nullable: false },
					rating: { type: 'integer', nullable: true },
				},
				reviews: {
					id: { type: 'integer', nullable: false },
					productId: { type: 'integer', nullable: false },
					rating: { type: 'integer', nullable: false },
				},
			},
			relations: {
				'categories.products': {
					source: 'categories',
					target: 'products',
					type: 'hasMany',
					sourceKey: 'id',
					targetKey: 'categoryId',
				},
				'products.reviews': {
					source: 'products',
					target: 'reviews',
					type: 'hasMany',
					sourceKey: 'id',
					targetKey: 'productId',
				},
			},
		};

		it('should parse simple existence check (SC-09)', () => {
			// Arrange - SC-09: categories where has products
			const query = 'categories where has products';

			// Act
			const result = parseNaturalQuery(query, schemaWithRelations);

			// Assert
			expect(result.table).toBe('categories');
			expect(result.existenceChecks).toHaveLength(1);
			expect(result.existenceChecks?.[0]).toEqual({
				type: 'exists',
				relation: 'products',
			});
		});

		it('should parse negated existence check (SC-10)', () => {
			// Arrange - SC-10: categories where not has products
			const query = 'categories where not has products';

			// Act
			const result = parseNaturalQuery(query, schemaWithRelations);

			// Assert
			expect(result.table).toBe('categories');
			expect(result.existenceChecks).toHaveLength(1);
			expect(result.existenceChecks?.[0]).toEqual({
				type: 'not_exists',
				relation: 'products',
			});
		});

		it('should parse existence check with nested condition (SC-11)', () => {
			// Arrange - SC-11: categories where has products where rating > 4
			const query = 'categories where has products where rating > 4';

			// Act
			const result = parseNaturalQuery(query, schemaWithRelations);

			// Assert
			expect(result.table).toBe('categories');
			expect(result.existenceChecks).toHaveLength(1);
			expect(result.existenceChecks?.[0]).toEqual({
				type: 'exists',
				relation: 'products',
				where: [{ column: 'rating', operator: '>', value: 4 }],
			});
		});

		it('should mix regular WHERE and existence checks', () => {
			// Arrange: categories where name = 'Electronics' and has products
			const query = "categories where name = 'Electronics' and has products";

			// Act
			const result = parseNaturalQuery(query, schemaWithRelations);

			// Assert
			expect(result.table).toBe('categories');
			expect(result.where).toHaveLength(1);
			expect(result.where?.[0]).toEqual({
				column: 'name',
				operator: '=',
				value: 'Electronics',
			});
			expect(result.existenceChecks).toHaveLength(1);
			expect(result.existenceChecks?.[0]).toEqual({
				type: 'exists',
				relation: 'products',
			});
		});

		it('should parse multiple existence checks', () => {
			// Arrange: categories where has products and not has reviews
			// Note: This is a bit unusual syntax but should work
			const query = 'categories where has products';

			// Act
			const result = parseNaturalQuery(query, schemaWithRelations);

			// Assert
			expect(result.existenceChecks).toHaveLength(1);
		});

		it('should parse existence check after other clauses', () => {
			// Arrange: categories where name = 'Tech' and has products where rating > 3
			const query =
				"categories where name = 'Tech' and has products where rating > 3";

			// Act
			const result = parseNaturalQuery(query, schemaWithRelations);

			// Assert
			expect(result.where?.[0]?.column).toBe('name');
			expect(result.existenceChecks?.[0]?.relation).toBe('products');
			expect(result.existenceChecks?.[0]?.where?.[0]).toEqual({
				column: 'rating',
				operator: '>',
				value: 3,
			});
		});

		it('should work with LIMIT after existence check', () => {
			// Arrange: categories where has products limit 5
			const query = 'categories where has products limit 5';

			// Act
			const result = parseNaturalQuery(query, schemaWithRelations);

			// Assert
			expect(result.existenceChecks?.[0]?.relation).toBe('products');
			expect(result.limit).toBe(5);
		});

		it('should work with ORDER BY after existence check', () => {
			// Arrange: categories where has products order by name
			const query = 'categories where has products order by name';

			// Act
			const result = parseNaturalQuery(query, schemaWithRelations);

			// Assert
			expect(result.existenceChecks?.[0]?.relation).toBe('products');
			expect(result.orderBy?.[0]?.column).toBe('name');
		});
	});
});
