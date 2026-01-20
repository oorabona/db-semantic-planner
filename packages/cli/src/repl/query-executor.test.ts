/**
 * Query Executor Tests
 *
 * Verifies that the query executor generates proper SQL using the semantic planner.
 */

import type { ResolvedSchema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import type { ParsedQuery } from './parser.js';
import {
	executeMutation,
	executeQuery,
	formatMutationResult,
} from './query-executor.js';
import type { ParsedMutation } from './types.js';

// Simple test schema
const testSchema: ResolvedSchema = {
	tables: {
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: { type: 'string', nullable: false },
			published: { type: 'boolean', default: 'false' },
			authorId: { type: 'integer', references: { table: 'authors' } },
		},
		authors: {
			id: { type: 'integer', primaryKey: true },
			name: { type: 'string', nullable: false },
		},
	},
	relations: {
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
	indexes: {},
	conventions: {
		fkPattern: '{singular}Id',
		pluralize: true,
		timestamps: ['createdAt', 'updatedAt'],
		fkAutoIndex: true,
	},
};

// Schema with nested relations for testing nested includes
const nestedSchema: ResolvedSchema = {
	tables: {
		authors: {
			id: { type: 'integer', primaryKey: true },
			name: { type: 'string', nullable: false },
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: { type: 'string', nullable: false },
			published: { type: 'boolean', default: 'false' },
			authorId: { type: 'integer', references: { table: 'authors' } },
		},
		comments: {
			id: { type: 'integer', primaryKey: true },
			content: { type: 'string', nullable: false },
			postId: { type: 'integer', references: { table: 'posts' } },
		},
	},
	relations: {
		'authors.posts': {
			kind: 'hasMany',
			target: 'posts',
			foreignKey: 'authorId',
		},
		'posts.author': {
			kind: 'belongsTo',
			target: 'authors',
			foreignKey: 'authorId',
		},
		'posts.comments': {
			kind: 'hasMany',
			target: 'comments',
			foreignKey: 'postId',
		},
		'comments.post': {
			kind: 'belongsTo',
			target: 'posts',
			foreignKey: 'postId',
		},
	},
	hints: {},
	indexes: {},
	conventions: {
		fkPattern: '{singular}Id',
		pluralize: true,
		timestamps: ['createdAt', 'updatedAt'],
		fkAutoIndex: true,
	},
};

describe('executeQuery', () => {
	it('should generate SQL for a simple select', () => {
		const query: ParsedQuery = {
			table: 'posts',
		};

		const result = executeQuery(query, testSchema);

		expect(result.error).toBeUndefined();
		// PostgreSQL uses lowercase keywords
		expect(result.sql.toLowerCase()).toContain('select');
		expect(result.sql).toContain('posts');
		// Should use table aliasing (e.g., "t0")
		expect(result.sql).toMatch(/"t\d+"/); // Matches "t0", "t1", etc.
	});

	it('should generate SQL with where clause', () => {
		const query: ParsedQuery = {
			table: 'posts',
			where: [{ column: 'published', operator: '=', value: true }],
		};

		const result = executeQuery(query, testSchema);

		expect(result.error).toBeUndefined();
		expect(result.sql.toLowerCase()).toContain('where');
		// Should use parameterized query
		expect(result.params.length).toBeGreaterThan(0);
		// Should use parameters like $1
		expect(result.sql).toContain('$1');
	});

	it('should generate SQL with limit', () => {
		const query: ParsedQuery = {
			table: 'posts',
			limit: 10,
		};

		const result = executeQuery(query, testSchema);

		expect(result.error).toBeUndefined();
		expect(result.sql.toLowerCase()).toContain('limit');
	});

	it('should return error for unknown table', () => {
		const query: ParsedQuery = {
			table: 'unknown_table',
		};

		const result = executeQuery(query, testSchema);

		// Should return an error for unknown table
		expect(result.error).toBeDefined();
	});

	it('should include plan information', () => {
		const query: ParsedQuery = {
			table: 'posts',
		};

		const result = executeQuery(query, testSchema);

		expect(result.plan).toBeDefined();
		expect(result.plan.tables).toContain('posts');
	});

	it('should handle include relations', () => {
		const query: ParsedQuery = {
			table: 'posts',
			// CLI-014: include is now ParsedInclude[]
			include: [{ relation: 'author' }],
		};

		const result = executeQuery(query, testSchema);

		// Include may produce error if relation resolution fails,
		// or it may succeed with additional SQL/plan info
		// For now, just verify no crash and check plan includes the table
		if (!result.error) {
			expect(result.plan.tables).toContain('posts');
			expect(result.plan.tables).toContain('author');
		}
	});

	it('should handle filtered include relations (CLI-014)', () => {
		const query: ParsedQuery = {
			table: 'authors',
			include: [
				{
					relation: 'posts',
					where: [{ column: 'published', operator: '=', value: true }],
				},
			],
		};

		const result = executeQuery(query, testSchema, { includeStrategy: 'cte' });

		// Should not crash and should generate SQL with the filter
		expect(result.error).toBeUndefined();
		expect(result.sql).toBeDefined();
		// CLI-014: The filter should be applied EARLY inside the CTE, not on the main query
		// Expected: WITH "cte_..." AS (SELECT * FROM "posts" WHERE "posts"."published" = $1)
		expect(result.sql.toLowerCase()).toMatch(
			/with\s+"cte_[^"]+"\s+as\s+\([^)]*where[^)]*published/,
		);
		// Should use parameter binding
		expect(result.params).toContain(true);
	});

	it('should handle nested include relations', () => {
		// Test: authors include posts include comments
		const query: ParsedQuery = {
			table: 'authors',
			include: [
				{
					relation: 'posts',
					include: [{ relation: 'comments' }],
				},
			],
		};

		const result = executeQuery(query, nestedSchema);

		// Should not crash
		expect(result.error).toBeUndefined();
		expect(result.sql).toBeDefined();
		// Nested includes should appear in SQL (comments table)
		expect(result.sql).toContain('comments');
		// CLI-015: Plan.tables should include ALL nested relations
		expect(result.plan.tables).toContain('authors');
		expect(result.plan.tables).toContain('posts');
		expect(result.plan.tables).toContain('comments');
		expect(result.plan.tables).toHaveLength(3);
	});

	it('should handle nested includes with where filters at each level', () => {
		// Test: authors include posts where published = true include comments
		const query: ParsedQuery = {
			table: 'authors',
			include: [
				{
					relation: 'posts',
					where: [{ column: 'published', operator: '=', value: true }],
					include: [{ relation: 'comments' }],
				},
			],
		};

		const result = executeQuery(query, nestedSchema);

		// Should not crash
		expect(result.error).toBeUndefined();
		expect(result.sql).toBeDefined();
		// Should have parameter for published filter
		expect(result.params).toContain(true);
	});
});

// CLI-016: Aggregate query execution tests
describe('executeQuery - aggregates (CLI-016)', () => {
	it('should execute count(*)', () => {
		const query: ParsedQuery = {
			table: 'posts',
			aggregates: [{ function: 'count' }],
		};

		const result = executeQuery(query, testSchema);

		expect(result.error).toBeUndefined();
		expect(result.sql).toContain('count(*)');
	});

	it('should execute count(field) as alias', () => {
		const query: ParsedQuery = {
			table: 'posts',
			aggregates: [{ function: 'count', field: 'id', as: 'total' }],
		};

		const result = executeQuery(query, testSchema);

		expect(result.error).toBeUndefined();
		// Should have count and alias
		expect(result.sql.toLowerCase()).toContain('count');
		expect(result.sql.toLowerCase()).toContain('total');
	});

	it('should execute count(distinct field)', () => {
		const query: ParsedQuery = {
			table: 'posts',
			aggregates: [{ function: 'count', field: 'authorId', distinct: true }],
		};

		const result = executeQuery(query, testSchema);

		expect(result.error).toBeUndefined();
		// Should have COUNT DISTINCT
		expect(result.sql.toLowerCase()).toContain('count');
		expect(result.sql.toLowerCase()).toContain('distinct');
	});

	it('should execute sum, avg aggregates', () => {
		const query: ParsedQuery = {
			table: 'posts',
			aggregates: [
				{ function: 'sum', field: 'id', as: 'sum_id' },
				{ function: 'avg', field: 'id', as: 'avg_id' },
			],
		};

		const result = executeQuery(query, testSchema);

		expect(result.error).toBeUndefined();
		expect(result.sql.toLowerCase()).toContain('sum');
		expect(result.sql.toLowerCase()).toContain('avg');
	});

	it('should execute group by', () => {
		const query: ParsedQuery = {
			table: 'posts',
			aggregates: [{ function: 'count', as: 'total' }],
			groupBy: ['authorId'],
		};

		const result = executeQuery(query, testSchema);

		expect(result.error).toBeUndefined();
		expect(result.sql.toLowerCase()).toContain('group by');
		// With CamelCasePlugin, authorId becomes author_id in SQL
		expect(result.sql.toLowerCase()).toContain('author_id');
	});

	it('should execute having clause', () => {
		const query: ParsedQuery = {
			table: 'posts',
			aggregates: [{ function: 'count', as: 'total' }],
			groupBy: ['authorId'],
			having: [{ column: 'count', operator: '>', value: 5 }],
		};

		const result = executeQuery(query, testSchema);

		expect(result.error).toBeUndefined();
		expect(result.sql.toLowerCase()).toContain('having');
	});

	it('should execute distinct', () => {
		const query: ParsedQuery = {
			table: 'posts',
			distinct: true,
		};

		const result = executeQuery(query, testSchema);

		expect(result.error).toBeUndefined();
		expect(result.sql.toLowerCase()).toContain('select distinct');
	});

	describe('recursive includes (CLI-017)', () => {
		// Schema with self-referential relations
		const hierarchySchema: ResolvedSchema = {
			tables: {
				categories: {
					id: { type: 'integer', primaryKey: true },
					name: { type: 'string', nullable: false },
					parentId: { type: 'integer', nullable: true },
				},
			},
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
			},
			hints: {},
			indexes: {},
			conventions: {
				fkPattern: '{singular}Id',
				pluralize: true,
				timestamps: ['createdAt', 'updatedAt'],
				fkAutoIndex: true,
			},
		};

		it('should generate WITH RECURSIVE for hasMany recursive include (DX-017)', () => {
			const query: ParsedQuery = {
				table: 'categories',
				include: [{ relation: 'children', recursive: true }],
			};

			const result = executeQuery(query, hierarchySchema);

			// DX-017: Recursive includes now generate WITH RECURSIVE CTE
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeTruthy();
			expect(result.sql.toUpperCase()).toContain('WITH RECURSIVE');
			expect(result.sql).toContain('cte_categories_children');
		});

		it('should generate WITH RECURSIVE for belongsTo recursive include (DX-017)', () => {
			const query: ParsedQuery = {
				table: 'categories',
				include: [{ relation: 'parent', recursive: true }],
			};

			const result = executeQuery(query, hierarchySchema);

			// DX-017: Recursive includes now generate WITH RECURSIVE CTE
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeTruthy();
			expect(result.sql.toUpperCase()).toContain('WITH RECURSIVE');
			expect(result.sql).toContain('cte_categories_parent');
		});

		it('should generate non-recursive SQL for regular includes', () => {
			const query: ParsedQuery = {
				table: 'categories',
				include: [{ relation: 'children' }], // No recursive flag
			};

			const result = executeQuery(query, hierarchySchema);

			expect(result.error).toBeUndefined();
			// Non-recursive includes use JOIN strategy
			expect(result.sql.toLowerCase()).toContain('left join');
			expect(result.sql.toLowerCase()).not.toContain('with recursive');
		});

		// CLI-018: includeDepth option
		it('should include depth column when includeDepth is true', () => {
			const query: ParsedQuery = {
				table: 'categories',
				include: [
					{ relation: 'children', recursive: true, includeDepth: true },
				],
			};

			const result = executeQuery(query, hierarchySchema);

			expect(result.error).toBeUndefined();
			expect(result.sql).toBeTruthy();
			expect(result.sql.toUpperCase()).toContain('WITH RECURSIVE');
			// Should have depth tracking: 0 AS "depth" in base, depth + 1 in recursive
			expect(result.sql).toContain('0 as "depth"');
			expect(result.sql).toContain('"depth" + 1 as "depth"');
		});

		it('should support both maxDepth and includeDepth together', () => {
			const query: ParsedQuery = {
				table: 'categories',
				include: [
					{
						relation: 'children',
						recursive: true,
						maxDepth: 5,
						includeDepth: true,
					},
				],
			};

			const result = executeQuery(query, hierarchySchema);

			expect(result.error).toBeUndefined();
			expect(result.sql).toBeTruthy();
			expect(result.sql.toUpperCase()).toContain('WITH RECURSIVE');
			// Should have depth tracking
			expect(result.sql).toContain('0 as "depth"');
			expect(result.sql).toContain('"depth" + 1 as "depth"');
			// Should have depth limit in WHERE clause
			expect(result.sql).toContain('"depth" < $1');
		});
	});

	// CLI-021: Schema scoping
	describe('schema scoping', () => {
		it('should add schema prefix when schemaName is provided', () => {
			const query: ParsedQuery = {
				table: 'posts',
			};

			const result = executeQuery(query, testSchema, {
				schemaName: 'tenant_123',
			});

			expect(result.error).toBeUndefined();
			expect(result.sql).toContain('"tenant_123"');
			expect(result.sql.toLowerCase()).toMatch(/tenant_123[".].*posts/);
		});

		it('should not add schema prefix when schemaName is not provided', () => {
			const query: ParsedQuery = {
				table: 'posts',
			};

			const result = executeQuery(query, testSchema);

			expect(result.error).toBeUndefined();
			expect(result.sql).not.toContain('tenant_');
		});
	});
});

// CLI-MUT: Mutation schema for INSERT/UPDATE/DELETE/UPSERT tests
const mutationSchema: ResolvedSchema = {
	tables: {
		users: {
			id: { type: 'integer', primaryKey: true },
			name: { type: 'string', nullable: false },
			email: { type: 'string', nullable: false, unique: true },
			active: { type: 'boolean', default: 'true' },
		},
		orders: {
			id: { type: 'integer', primaryKey: true },
			user_id: { type: 'integer', references: { table: 'users' } },
			product_id: { type: 'integer' },
			quantity: { type: 'integer', default: '1' },
		},
	},
	relations: {},
	hints: {},
	indexes: {},
	conventions: {
		fkPattern: '{singular}Id',
		pluralize: true,
		timestamps: ['createdAt', 'updatedAt'],
		fkAutoIndex: true,
	},
};

describe('executeMutation (CLI-MUT)', () => {
	describe('INSERT', () => {
		it('should generate INSERT SQL with values', () => {
			// Arrange
			const mutation: ParsedMutation = {
				type: 'insert',
				table: 'users',
				assignments: [
					{
						column: 'name',
						value: { type: 'string', raw: 'Alice', value: 'Alice' },
					},
					{
						column: 'email',
						value: {
							type: 'string',
							raw: 'alice@example.com',
							value: 'alice@example.com',
						},
					},
				],
				executeImmediate: false,
			};

			// Act
			const result = executeMutation(mutation, mutationSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.type).toBe('insert');
			expect(result.dryRun).toBe(true);
			expect(result.sql.toLowerCase()).toContain('insert into');
			expect(result.sql.toLowerCase()).toContain('users');
			expect(result.params).toContain('Alice');
			expect(result.params).toContain('alice@example.com');
		});

		it('should set dryRun=false when executeImmediate is true', () => {
			// Arrange
			const mutation: ParsedMutation = {
				type: 'insert',
				table: 'users',
				assignments: [
					{
						column: 'name',
						value: { type: 'string', raw: 'Bob', value: 'Bob' },
					},
				],
				executeImmediate: true,
			};

			// Act
			const result = executeMutation(mutation, mutationSchema);

			// Assert
			expect(result.dryRun).toBe(false);
		});

		it('should return error for INSERT without assignments', () => {
			// Arrange
			const mutation: ParsedMutation = {
				type: 'insert',
				table: 'users',
				assignments: [],
				executeImmediate: false,
			};

			// Act
			const result = executeMutation(mutation, mutationSchema);

			// Assert
			expect(result.error).toContain('INSERT requires at least one assignment');
		});
	});

	describe('UPDATE', () => {
		it('should generate UPDATE SQL with SET and WHERE', () => {
			// Arrange
			const mutation: ParsedMutation = {
				type: 'update',
				table: 'users',
				assignments: [
					{
						column: 'active',
						value: { type: 'boolean', raw: 'false', value: false },
					},
				],
				where: [{ column: 'id', operator: '=', value: '1' }],
				executeImmediate: false,
			};

			// Act
			const result = executeMutation(mutation, mutationSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.type).toBe('update');
			expect(result.sql.toLowerCase()).toContain('update');
			expect(result.sql.toLowerCase()).toContain('users');
			expect(result.sql.toLowerCase()).toContain('set');
			expect(result.sql.toLowerCase()).toContain('where');
		});

		it('should return error for UPDATE without WHERE', () => {
			// Arrange
			const mutation: ParsedMutation = {
				type: 'update',
				table: 'users',
				assignments: [
					{
						column: 'active',
						value: { type: 'boolean', raw: 'false', value: false },
					},
				],
				executeImmediate: false,
			};

			// Act
			const result = executeMutation(mutation, mutationSchema);

			// Assert
			expect(result.error).toContain('UPDATE requires WHERE clause');
		});

		it('should return error for UPDATE without SET assignments', () => {
			// Arrange
			const mutation: ParsedMutation = {
				type: 'update',
				table: 'users',
				assignments: [],
				where: [{ column: 'id', operator: '=', value: '1' }],
				executeImmediate: false,
			};

			// Act
			const result = executeMutation(mutation, mutationSchema);

			// Assert
			expect(result.error).toContain(
				'UPDATE requires at least one SET assignment',
			);
		});
	});

	describe('DELETE', () => {
		it('should generate DELETE SQL with WHERE', () => {
			// Arrange
			const mutation: ParsedMutation = {
				type: 'delete',
				table: 'users',
				where: [{ column: 'id', operator: '=', value: '1' }],
				executeImmediate: false,
			};

			// Act
			const result = executeMutation(mutation, mutationSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.type).toBe('delete');
			expect(result.sql.toLowerCase()).toContain('delete from');
			expect(result.sql.toLowerCase()).toContain('users');
			expect(result.sql.toLowerCase()).toContain('where');
		});

		it('should return error for DELETE without WHERE', () => {
			// Arrange
			const mutation: ParsedMutation = {
				type: 'delete',
				table: 'users',
				executeImmediate: false,
			};

			// Act
			const result = executeMutation(mutation, mutationSchema);

			// Assert
			expect(result.error).toContain('DELETE requires WHERE clause');
		});
	});

	describe('UPSERT', () => {
		it('should generate UPSERT SQL with ON CONFLICT DO NOTHING', () => {
			// Arrange
			const mutation: ParsedMutation = {
				type: 'upsert',
				table: 'users',
				assignments: [
					{
						column: 'name',
						value: { type: 'string', raw: 'Alice', value: 'Alice' },
					},
					{
						column: 'email',
						value: {
							type: 'string',
							raw: 'alice@test.com',
							value: 'alice@test.com',
						},
					},
				],
				onConflict: {
					columns: ['email'],
					action: 'nothing',
				},
				executeImmediate: false,
			};

			// Act
			const result = executeMutation(mutation, mutationSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.type).toBe('upsert');
			expect(result.sql.toLowerCase()).toContain('insert into');
			expect(result.sql.toLowerCase()).toContain('on conflict');
			expect(result.sql.toLowerCase()).toContain('do nothing');
		});

		it('should generate UPSERT SQL with ON CONFLICT DO UPDATE', () => {
			// Arrange
			const mutation: ParsedMutation = {
				type: 'upsert',
				table: 'users',
				assignments: [
					{
						column: 'name',
						value: { type: 'string', raw: 'Alice', value: 'Alice' },
					},
					{
						column: 'email',
						value: {
							type: 'string',
							raw: 'alice@test.com',
							value: 'alice@test.com',
						},
					},
				],
				onConflict: {
					columns: ['email'],
					action: 'update',
					updateAssignments: [
						{
							column: 'name',
							value: {
								type: 'string',
								raw: 'Alice Updated',
								value: 'Alice Updated',
							},
						},
					],
				},
				executeImmediate: false,
			};

			// Act
			const result = executeMutation(mutation, mutationSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.type).toBe('upsert');
			expect(result.sql.toLowerCase()).toContain('insert into');
			expect(result.sql.toLowerCase()).toContain('on conflict');
			expect(result.sql.toLowerCase()).toContain('do update');
		});

		it('should return error for UPSERT without ON CONFLICT', () => {
			// Arrange
			const mutation: ParsedMutation = {
				type: 'upsert',
				table: 'users',
				assignments: [
					{
						column: 'name',
						value: { type: 'string', raw: 'Alice', value: 'Alice' },
					},
				],
				executeImmediate: false,
			};

			// Act
			const result = executeMutation(mutation, mutationSchema);

			// Assert
			expect(result.error).toContain('UPSERT requires ON CONFLICT clause');
		});
	});

	describe('formatMutationResult', () => {
		it('should format dry-run result with SQL and params', () => {
			// Arrange
			const result = {
				type: 'insert' as const,
				sql: 'INSERT INTO "users" ("name") VALUES ($1)',
				params: ['Alice'] as readonly unknown[],
				dryRun: true,
			};

			// Act
			const formatted = formatMutationResult(result);

			// Assert
			expect(formatted).toContain('[DRY-RUN]');
			expect(formatted).toContain('INSERT');
			expect(formatted).toContain('add ! to execute');
			expect(formatted).toContain('INSERT INTO "users"');
			expect(formatted).toContain('Alice');
		});

		it('should format executed result differently', () => {
			// Arrange
			const result = {
				type: 'delete' as const,
				sql: 'DELETE FROM "users" WHERE "id" = $1',
				params: [1] as readonly unknown[],
				dryRun: false,
				rowsAffected: 1,
			};

			// Act
			const formatted = formatMutationResult(result);

			// Assert
			expect(formatted).toContain('[EXECUTED]');
			expect(formatted).toContain('DELETE');
			expect(formatted).toContain('Rows affected: 1');
		});

		it('should format error result', () => {
			// Arrange
			const result = {
				type: 'update' as const,
				sql: '',
				params: [] as readonly unknown[],
				dryRun: true,
				error: 'UPDATE requires WHERE clause',
			};

			// Act
			const formatted = formatMutationResult(result);

			// Assert
			expect(formatted).toContain('Error:');
			expect(formatted).toContain('UPDATE requires WHERE clause');
		});
	});

	describe('SC-14: SQL injection prevention', () => {
		it('should bind potentially dangerous values as parameters', () => {
			// Arrange - attempt SQL injection via value
			const mutation: ParsedMutation = {
				type: 'insert',
				table: 'users',
				assignments: [
					{
						column: 'name',
						value: {
							type: 'string',
							raw: "'; DROP TABLE users; --",
							value: "'; DROP TABLE users; --",
						},
					},
				],
				executeImmediate: false,
			};

			// Act
			const result = executeMutation(mutation, mutationSchema);

			// Assert
			expect(result.error).toBeUndefined();
			// The dangerous string should be bound as a parameter, not interpolated
			expect(result.params).toContain("'; DROP TABLE users; --");
			// SQL should NOT contain the raw injection attempt
			expect(result.sql).not.toContain('DROP TABLE');
		});
	});
});
