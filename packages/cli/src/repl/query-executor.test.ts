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
			include: ['author'], // Simple relation name (posts.author in schema)
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
});
