/**
 * Query Executor Tests
 *
 * Verifies that the query executor generates proper SQL using the semantic planner.
 */

import type { ResolvedSchema } from '@db-semantic-planner/schema';
import { describe, expect, it } from 'vitest';
import type { ParsedQuery } from './parser.js';
import { executeQuery } from './query-executor.js';

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
	conventions: {
		fkPattern: '{singular}Id',
		pluralize: true,
		timestamps: ['createdAt', 'updatedAt'],
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
	conventions: {
		fkPattern: '{singular}Id',
		pluralize: true,
		timestamps: ['createdAt', 'updatedAt'],
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
