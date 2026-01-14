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
