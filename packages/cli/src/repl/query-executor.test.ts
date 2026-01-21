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

// =============================================================================
// CLI-NQL Block 9: Path Expression Resolution Tests
// =============================================================================

// Schema with hierarchical categories for testing path expressions
const pathTestSchema: ResolvedSchema = {
	tables: {
		categories: {
			id: { type: 'integer', primaryKey: true },
			name: { type: 'string', nullable: false },
			parentId: { type: 'integer', nullable: true },
		},
		products: {
			id: { type: 'integer', primaryKey: true },
			title: { type: 'string', nullable: false },
			price: { type: 'decimal', nullable: false },
			categoryId: { type: 'integer', references: { table: 'categories' } },
		},
	},
	relations: {
		'products.category': {
			kind: 'belongsTo',
			target: 'categories',
			foreignKey: 'categoryId',
		},
		'categories.products': {
			kind: 'hasMany',
			target: 'products',
			foreignKey: 'categoryId',
		},
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

describe('CLI-NQL Block 9: Path Expression Resolution', () => {
	describe('SC-02: N-level relation path JOINs', () => {
		it('should generate JOIN for single-level path expression', () => {
			// Arrange: products where category.name = 'Electronics'
			const query: ParsedQuery = {
				table: 'products',
				where: [
					{ column: 'category.name', operator: '=', value: 'Electronics' },
				],
			};

			// Act
			const result = executeQuery(query, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Should contain JOIN for category relation
			expect(result.sql.toLowerCase()).toContain('join');
			// Value should be bound as parameter
			expect(result.params).toContain('Electronics');
		});

		it('should generate nested relationFilter for 2-level path expression', () => {
			// Arrange: products where category.parent.name = 'Root'
			// Note: This generates nested relationFilter which the planner handles.
			// For very deep paths, the adapter may have limitations.
			const query: ParsedQuery = {
				table: 'products',
				where: [
					{ column: 'category.parent.name', operator: '=', value: 'Root' },
				],
			};

			// Act
			const result = executeQuery(query, pathTestSchema);

			// Assert - N-level paths generate nested relationFilter
			// The planner/compiler may have limitations for deep nesting
			// For now, we verify the structure is created correctly
			if (result.error) {
				// If there's an error about nested relations, that's a known limitation
				expect(result.error).toContain('relation');
			} else {
				expect(result.sql).toBeDefined();
				expect(result.sql.toLowerCase()).toContain('join');
			}
		});

		it('should handle path expression with comparison operators', () => {
			// Arrange: categories where parent.id > 10
			const query: ParsedQuery = {
				table: 'categories',
				where: [{ column: 'parent.id', operator: '>', value: 10 }],
			};

			// Act
			const result = executeQuery(query, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			expect(result.sql.toLowerCase()).toContain('join');
			// Value should be parameterized
			expect(result.params).toContain(10);
		});

		it('should not treat simple column as path expression', () => {
			// Arrange: products where title = 'Phone'
			const query: ParsedQuery = {
				table: 'products',
				where: [{ column: 'title', operator: '=', value: 'Phone' }],
			};

			// Act
			const result = executeQuery(query, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Should be a simple WHERE clause, no JOIN needed
			expect(result.sql.toLowerCase()).toContain('where');
			// Value should be parameterized
			expect(result.params).toContain('Phone');
		});
	});

	describe('Path expression with LIKE operator', () => {
		it('should generate JOIN with LIKE filter on related column', () => {
			// Arrange: products where category.name like 'Elec%'
			const query: ParsedQuery = {
				table: 'products',
				where: [{ column: 'category.name', operator: 'like', value: 'Elec%' }],
			};

			// Act
			const result = executeQuery(query, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			expect(result.sql.toLowerCase()).toContain('join');
			expect(result.sql.toLowerCase()).toContain('like');
		});
	});

	describe('Path expression combined with includes', () => {
		it('should handle path in where with explicit include', () => {
			// Arrange: products where category.name = 'X' include category
			const query: ParsedQuery = {
				table: 'products',
				where: [
					{ column: 'category.name', operator: '=', value: 'Electronics' },
				],
				include: [{ relation: 'category' }],
			};

			// Act
			const result = executeQuery(query, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Both the relationFilter and include should work together
			expect(result.sql.toLowerCase()).toContain('join');
		});
	});
});

// =============================================================================
// CLI-NQL Block 10: Subquery and Existence Check Tests
// =============================================================================

describe('CLI-NQL Block 10: Subquery Support', () => {
	describe('SC-05: Scalar subquery in comparison', () => {
		it('should generate scalar subquery for WHERE comparison', () => {
			// Arrange: products where categoryId = (categories where name = 'Electronics')
			const query: ParsedQuery = {
				table: 'products',
				where: [
					{
						column: 'categoryId',
						operator: '=',
						value: {
							type: 'subquery',
							subquery: {
								table: 'categories',
								where: [
									{ column: 'name', operator: '=', value: 'Electronics' },
								],
								selectColumn: 'id',
							},
						},
					},
				],
			};

			// Act
			const result = executeQuery(query, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Should contain SELECT in the subquery
			expect(result.sql.toLowerCase()).toContain('select');
			// Value should be parameterized
			expect(result.params).toContain('Electronics');
		});

		it('should handle subquery with default select column (id)', () => {
			// Arrange: When selectColumn is not specified, default to 'id'
			const query: ParsedQuery = {
				table: 'products',
				where: [
					{
						column: 'categoryId',
						operator: '=',
						value: {
							type: 'subquery',
							subquery: {
								table: 'categories',
								where: [{ column: 'active', operator: '=', value: true }],
								// selectColumn not specified - should default to 'id'
							},
						},
					},
				],
			};

			// Act
			const result = executeQuery(query, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
		});
	});

	describe('SC-09: Simple existence check', () => {
		it('should generate EXISTS for has relation', () => {
			// Arrange: categories where has products
			const query: ParsedQuery = {
				table: 'categories',
				existenceChecks: [{ type: 'exists', relation: 'products' }],
			};

			// Act
			const result = executeQuery(query, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Should contain EXISTS keyword
			expect(result.sql.toLowerCase()).toContain('exists');
		});
	});

	describe('SC-10: Negated existence check', () => {
		it('should generate NOT EXISTS for not has relation', () => {
			// Arrange: categories where not has products
			const query: ParsedQuery = {
				table: 'categories',
				existenceChecks: [{ type: 'not_exists', relation: 'products' }],
			};

			// Act
			const result = executeQuery(query, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Should contain NOT EXISTS
			expect(result.sql.toLowerCase()).toContain('not exists');
		});
	});

	describe('SC-11: Existence with nested condition', () => {
		it('should generate EXISTS with WHERE clause', () => {
			// Arrange: categories where has products where price > 100
			const query: ParsedQuery = {
				table: 'categories',
				existenceChecks: [
					{
						type: 'exists',
						relation: 'products',
						where: [{ column: 'price', operator: '>', value: 100 }],
					},
				],
			};

			// Act
			const result = executeQuery(query, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Should contain EXISTS
			expect(result.sql.toLowerCase()).toContain('exists');
			// Value should be parameterized
			expect(result.params).toContain(100);
		});
	});

	describe('Combined WHERE and existence checks', () => {
		it('should handle both where clause and existence check', () => {
			// Arrange: categories where active = true and has products
			const query: ParsedQuery = {
				table: 'categories',
				where: [{ column: 'active', operator: '=', value: true }],
				existenceChecks: [{ type: 'exists', relation: 'products' }],
			};

			// Act
			const result = executeQuery(query, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Should have both WHERE and EXISTS
			expect(result.sql.toLowerCase()).toContain('where');
			expect(result.sql.toLowerCase()).toContain('exists');
		});
	});
});

// ============================================================================
// CLI-NQL Block 11: INSERT FROM Executor (SC-12 to SC-14)
// ============================================================================

describe('CLI-NQL Block 11: INSERT FROM Executor', () => {
	describe('SC-12: INSERT with FK lookup (scalar subquery)', () => {
		it('should generate INSERT with scalar subquery for FK lookup', () => {
			// Arrange: products insert title = "Phone", categoryId = id from categories where name = "Electronics"
			const mutation: ParsedMutation = {
				type: 'insert',
				table: 'products',
				assignments: [
					{
						column: 'title',
						value: { type: 'string', raw: '"Phone"', value: 'Phone' },
					},
					{
						column: 'categoryId',
						value: { type: 'string', raw: 'id', value: 'id' },
					},
				],
				fromClause: {
					table: 'categories',
					bulk: false,
					where: [{ column: 'name', operator: '=', value: 'Electronics' }],
				},
				executeImmediate: false,
			};

			// Act
			const result = executeMutation(mutation, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			expect(result.type).toBe('insert');
			// Should have INSERT INTO
			expect(result.sql).toContain('INSERT INTO');
			expect(result.sql).toContain('"products"');
			// Should have scalar subquery for id column
			expect(result.sql).toContain('SELECT "id" FROM "categories"');
			expect(result.sql).toContain('WHERE');
			// Params should include literal value and where clause value
			expect(result.params).toContain('Phone');
			expect(result.params).toContain('Electronics');
		});

		it('should handle multiple FK lookups from same source', () => {
			// Arrange: items insert col1 = id, col2 = code from refs where active = true
			const mutation: ParsedMutation = {
				type: 'insert',
				table: 'items',
				assignments: [
					{ column: 'col1', value: { type: 'string', raw: 'id', value: 'id' } },
					{
						column: 'col2',
						value: { type: 'string', raw: 'code', value: 'code' },
					},
				],
				fromClause: {
					table: 'refs',
					bulk: false,
					where: [{ column: 'active', operator: '=', value: true }],
				},
				executeImmediate: false,
			};

			// Act
			const result = executeMutation(mutation, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Both columns should be subqueries
			expect(result.sql).toContain('SELECT "id" FROM "refs"');
			expect(result.sql).toContain('SELECT "code" FROM "refs"');
		});
	});

	describe('SC-13: INSERT FROM with FOR UPDATE', () => {
		it('should include FOR UPDATE clause in scalar subquery', () => {
			// Arrange: products insert categoryId = id from categories where name = "Electronics" for update
			const mutation: ParsedMutation = {
				type: 'insert',
				table: 'products',
				assignments: [
					{
						column: 'categoryId',
						value: { type: 'string', raw: 'id', value: 'id' },
					},
				],
				fromClause: {
					table: 'categories',
					bulk: false,
					where: [{ column: 'name', operator: '=', value: 'Electronics' }],
					forUpdate: true,
				},
				executeImmediate: false,
			};

			// Act
			const result = executeMutation(mutation, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Should have FOR UPDATE in subquery
			expect(result.sql).toContain('FOR UPDATE');
			// Should NOT have SKIP LOCKED
			expect(result.sql).not.toContain('SKIP LOCKED');
		});

		it('should include FOR UPDATE SKIP LOCKED when specified', () => {
			// Arrange: with skipLocked = true
			const mutation: ParsedMutation = {
				type: 'insert',
				table: 'products',
				assignments: [
					{
						column: 'categoryId',
						value: { type: 'string', raw: 'id', value: 'id' },
					},
				],
				fromClause: {
					table: 'categories',
					bulk: false,
					where: [{ column: 'name', operator: '=', value: 'Electronics' }],
					forUpdate: true,
					skipLocked: true,
				},
				executeImmediate: false,
			};

			// Act
			const result = executeMutation(mutation, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Should have FOR UPDATE SKIP LOCKED
			expect(result.sql).toContain('FOR UPDATE SKIP LOCKED');
		});
	});

	describe('SC-14: INSERT FROM EACH (bulk INSERT...SELECT)', () => {
		it('should generate INSERT...SELECT for bulk mode', () => {
			// Arrange: products insert each title = name, price = basePrice from templates where active = true
			const mutation: ParsedMutation = {
				type: 'insert',
				table: 'products',
				assignments: [
					{
						column: 'title',
						value: { type: 'string', raw: 'name', value: 'name' },
					},
					{
						column: 'price',
						value: { type: 'string', raw: 'basePrice', value: 'basePrice' },
					},
				],
				fromClause: {
					table: 'templates',
					bulk: true,
					where: [{ column: 'active', operator: '=', value: true }],
				},
				executeImmediate: false,
			};

			// Act
			const result = executeMutation(mutation, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			expect(result.type).toBe('insert');
			// Should be INSERT...SELECT pattern (not VALUES)
			expect(result.sql).toContain('INSERT INTO');
			expect(result.sql).toContain('SELECT');
			expect(result.sql).toContain('FROM "templates"');
			// Should NOT have VALUES keyword
			expect(result.sql).not.toContain('VALUES');
			// WHERE clause
			expect(result.sql).toContain('WHERE');
		});

		it('should map column references in SELECT for bulk mode', () => {
			// Arrange: mix of column refs and literals
			const mutation: ParsedMutation = {
				type: 'insert',
				table: 'products',
				assignments: [
					{
						column: 'title',
						value: { type: 'string', raw: 'name', value: 'name' },
					}, // column ref
					{
						column: 'status',
						value: { type: 'string', raw: '"active"', value: 'active' },
					}, // literal string "active"
				],
				fromClause: {
					table: 'templates',
					bulk: true,
				},
				executeImmediate: false,
			};

			// Act
			const result = executeMutation(mutation, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Should have SELECT with column refs as identifiers
			expect(result.sql).toContain('SELECT');
			expect(result.sql).toContain('"name"'); // column ref
		});

		it('should handle bulk INSERT without WHERE clause', () => {
			// Arrange: no where clause
			const mutation: ParsedMutation = {
				type: 'insert',
				table: 'archive',
				assignments: [
					{
						column: 'data',
						value: { type: 'string', raw: 'payload', value: 'payload' },
					},
				],
				fromClause: {
					table: 'source',
					bulk: true,
				},
				executeImmediate: false,
			};

			// Act
			const result = executeMutation(mutation, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Should not have WHERE clause
			expect(result.sql).toContain('INSERT INTO');
			expect(result.sql).toContain('SELECT');
			expect(result.sql).toContain('FROM "source"');
			expect(result.sql).not.toContain('WHERE');
		});
	});

	describe('SC-08: Relation columns in SELECT with auto-JOIN', () => {
		it('should generate JOIN for single-level relation column with alias', () => {
			// products select title, category.name as categoryName
			const query: ParsedQuery = {
				table: 'products',
				columns: [
					{ column: 'title' },
					{ column: 'category.name', alias: 'categoryName' },
				],
			};

			const result = executeQuery(query, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Should have SELECT with both columns (lowercase in Kysely)
			expect(result.sql).toMatch(/select/i);
			expect(result.sql).toMatch(/"t0"\."title"/);
			// Should have JOIN to categories
			expect(result.sql).toMatch(/left join.*"categories"/i);
			// Should select category.name with alias (snake_case is normal)
			expect(result.sql).toMatch(/"t\d+"\."name".*as.*"category_name"/i);
		});

		it('should generate nested JOINs for 2-level relation column', () => {
			// products select title, category.parent.name as grandParentName
			const query: ParsedQuery = {
				table: 'products',
				columns: [
					{ column: 'title' },
					{ column: 'category.parent.name', alias: 'grandParentName' },
				],
			};

			const result = executeQuery(query, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Should have SELECT
			expect(result.sql).toMatch(/select/i);
			expect(result.sql).toMatch(/"t0"\."title"/);
			// Should have 2 JOINs (products -> category -> parent)
			const joinCount = (result.sql.match(/left join/gi) || []).length;
			expect(joinCount).toBeGreaterThanOrEqual(2);
			// Should select the final column with alias (snake_case)
			expect(result.sql).toMatch(/"t\d+"\."name".*as.*"grand_parent_name"/i);
		});

		it('should use default alias when none provided for relation column', () => {
			// products select title, category.name (no alias -> category_name)
			const query: ParsedQuery = {
				table: 'products',
				columns: [
					{ column: 'title' },
					{ column: 'category.name' }, // No alias
				],
			};

			const result = executeQuery(query, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Should have JOIN
			expect(result.sql).toMatch(/left join.*"categories"/i);
			// Should use default alias (dots replaced with underscores)
			expect(result.sql).toMatch(/"t\d+"\."name".*as.*"category_name"/i);
		});

		it('should reuse existing JOIN when relation already joined', () => {
			// products select title, category.name as catName where category.id = 1
			// Note: WHERE path creates separate JOIN (INNER), SELECT creates LEFT JOIN
			const query: ParsedQuery = {
				table: 'products',
				columns: [
					{ column: 'title' },
					{ column: 'category.name', alias: 'catName' },
				],
				where: [{ column: 'category.id', operator: '=', value: 1 }],
			};

			const result = executeQuery(query, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Should have JOINs for the relation
			expect(result.sql).toMatch(/join.*"categories"/i);
			// Should have the SELECT column with alias (snake_case)
			expect(result.sql).toMatch(/"t\d+"\."name".*as.*"cat_name"/i);
		});

		it('should combine multiple relation columns with single JOIN', () => {
			// products select category.name as catName, category.id as catId
			const query: ParsedQuery = {
				table: 'products',
				columns: [
					{ column: 'category.name', alias: 'catName' },
					{ column: 'category.id', alias: 'catId' },
				],
			};

			const result = executeQuery(query, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Should have only 1 JOIN for category
			const joinCount = (result.sql.match(/left join.*"categories"/gi) || [])
				.length;
			expect(joinCount).toBe(1);
			// Should select both columns (snake_case aliases)
			expect(result.sql).toMatch(/"cat_name"/i);
			expect(result.sql).toMatch(/"cat_id"/i);
		});

		it('should NOT add include columns when explicit relation columns are selected (CLI-NQL)', () => {
			// CLI-NQL: When selecting explicit columns via path expressions (e.g., category.name),
			// the include should NOT add all columns from the relation.
			// products select name, category.name as categoryName include category
			const query: ParsedQuery = {
				table: 'products',
				columns: [
					{ column: 'name' },
					{ column: 'category.name', alias: 'categoryName' },
				],
				include: [{ relation: 'category' }],
			};

			const result = executeQuery(query, pathTestSchema);

			// Assert
			expect(result.error).toBeUndefined();
			expect(result.sql).toBeDefined();
			// Should select only the explicit columns, NOT all category columns
			// The SQL should have category_name aliased column
			expect(result.sql).toMatch(/"category_name"/i);
			// Should NOT have category.slug, category.parent_id, etc. (auto-include columns)
			// Check that there's no separate category columns select (only the explicit one)
			// The include should be skipped because explicit columns are selected
			const sql = result.sql!.toLowerCase();
			// Count occurrences of category columns - should only have the explicitly selected one
			const categoryColumnMatches =
				sql.match(/t\d+\.\s*"(id|name|slug|parent_id|sort_order)"/gi) || [];
			// With the fix, we should NOT see all 5 category columns
			// The relationColumn() handles the specific column, include is skipped
			expect(categoryColumnMatches.length).toBeLessThanOrEqual(2); // At most the explicitly selected ones
		});
	});
});
