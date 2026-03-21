/**
 * @module compiler-left-join.test
 * Unit tests for F-006: LEFT JOIN compilation for include-strategy.
 *
 * When the planner emits choice: 'join' for a to-one (belongsTo/hasOne) include,
 * the compiler should produce LEFT JOIN + aliased columns instead of json_agg subquery.
 */

import { describe, expect, it } from 'vitest';
import {
	compilePlan,
	type PlanDecision,
	type SimplifiedPlanReport,
} from '../compiler.js';

// ============================================================================
// Helpers
// ============================================================================

function compileToSql(plan: SimplifiedPlanReport): {
	sql: string;
	parameters: readonly unknown[];
} {
	return compilePlan(plan);
}

// ============================================================================
// Tests
// ============================================================================

describe('LEFT JOIN include compilation (F-006)', () => {
	describe('belongsTo include with choice=join', () => {
		it('should compile LEFT JOIN with aliased columns', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*', table: 'posts' },
					{
						type: 'includeStrategy',
						choice: 'join',
						relationName: 'author',
						targetTable: 'authors',
						relationType: 'belongsTo',
						foreignKey: 'author_id',
						parentKey: 'id',
						columns: ['id', 'name', 'email'],
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			// Should contain LEFT JOIN, not json_agg
			expect(result.sql).toContain('LEFT JOIN');
			expect(result.sql).not.toContain('json_agg');
			// ON condition: source FK = target PK (or equivalent)
			expect(result.sql).toMatch(/posts\.author_id\s*=\s*author\.id/);
			// Aliased columns for hydration
			expect(result.sql).toContain('"author.id"');
			expect(result.sql).toContain('"author.name"');
			expect(result.sql).toContain('"author.email"');
		});

		it('should always include PK in columns', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*', table: 'posts' },
					{
						type: 'includeStrategy',
						choice: 'join',
						relationName: 'author',
						targetTable: 'authors',
						relationType: 'belongsTo',
						foreignKey: 'author_id',
						parentKey: 'id',
						columns: ['id', 'name'], // PK included
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			// PK column should always be present
			expect(result.sql).toContain('"author.id"');
			expect(result.sql).toContain('"author.name"');
		});

		it('should compile LEFT JOIN with PK only when no other columns', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*', table: 'posts' },
					{
						type: 'includeStrategy',
						choice: 'join',
						relationName: 'author',
						targetTable: 'authors',
						relationType: 'belongsTo',
						foreignKey: 'author_id',
						parentKey: 'id',
						columns: ['id'], // PK only
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			expect(result.sql).toContain('LEFT JOIN');
			expect(result.sql).toContain('"author.id"');
		});
	});

	describe('fallback to json_agg when choice != join', () => {
		it('should use json_agg for selectJsonAgg decisions', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'authors',
				decisions: [
					{ type: 'select', column: '*', table: 'authors' },
					{
						type: 'includeStrategy',
						choice: 'json_agg',
						relationName: 'posts',
						targetTable: 'posts',
						relationType: 'hasMany',
						foreignKey: 'author_id',
						parentKey: 'id',
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			expect(result.sql).toContain('json_agg');
			expect(result.sql).not.toMatch(/LEFT\s+JOIN/);
		});
	});

	describe('multiple to-one includes to same table', () => {
		it('should produce two LEFT JOINs with different aliases', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*', table: 'posts' },
					// author (belongsTo users)
					{
						type: 'includeStrategy',
						choice: 'join',
						relationName: 'author',
						targetTable: 'users',
						relationType: 'belongsTo',
						foreignKey: 'author_id',
						parentKey: 'id',
						columns: ['id', 'name'],
					} satisfies PlanDecision,
					// editor (belongsTo users)
					{
						type: 'includeStrategy',
						choice: 'join',
						relationName: 'editor',
						targetTable: 'users',
						relationType: 'belongsTo',
						foreignKey: 'editor_id',
						parentKey: 'id',
						columns: ['id', 'name'],
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			// Two LEFT JOINs with different aliases
			expect(result.sql).toMatch(/LEFT JOIN\s+users\s+AS\s+author/i);
			expect(result.sql).toMatch(/LEFT JOIN\s+users\s+AS\s+editor/i);
			// Distinct aliased columns
			expect(result.sql).toContain('"author.id"');
			expect(result.sql).toContain('"author.name"');
			expect(result.sql).toContain('"editor.id"');
			expect(result.sql).toContain('"editor.name"');
		});
	});

	describe('2-hop nested LEFT JOIN include (INCLUDE-2HOP)', () => {
		it('should use intermediate table FK for second-hop join', () => {
			// Scenario: calls → callee (symbols) → file (files)
			// First hop: calls.callee_id → symbols.id  (belongsTo)
			// Second hop: symbols.file_id → files.id   (belongsTo)
			// Bug: without fix, second hop uses calls.file_id instead of symbols.file_id
			const plan: SimplifiedPlanReport = {
				rootTable: 'calls',
				decisions: [
					{ type: 'select', column: '*', table: 'calls' },
					// First hop: calls → symbols via callee_id
					{
						type: 'includeStrategy',
						choice: 'join',
						relationName: 'callee',
						targetTable: 'symbols',
						sourceTable: 'calls',
						relationType: 'belongsTo',
						foreignKey: 'callee_id',
						parentKey: 'id',
						columns: ['id', 'name'],
					} satisfies PlanDecision,
					// Second hop: symbols → files via file_id
					// sourceTable MUST be 'symbols', not 'calls'
					{
						type: 'includeStrategy',
						choice: 'join',
						relationName: 'file',
						targetTable: 'files',
						sourceTable: 'symbols',
						relationType: 'belongsTo',
						foreignKey: 'file_id',
						parentKey: 'id',
						columns: ['id', 'path'],
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			// First hop: calls.callee_id = callee.id
			expect(result.sql).toMatch(/calls\.callee_id\s*=\s*callee\.id/);
			// Second hop: MUST use callee.file_id (symbols alias), NOT calls.file_id
			expect(result.sql).toMatch(/callee\.file_id\s*=\s*file\.id/);
			// Must NOT use calls.file_id (the bug)
			expect(result.sql).not.toContain('calls.file_id');
			// Both JOINs present
			expect(result.sql).toMatch(/LEFT JOIN\s+symbols\s+AS\s+callee/);
			expect(result.sql).toMatch(/LEFT JOIN\s+files\s+AS\s+file/);
		});

		it('should use intermediate table for hasMany second hop', () => {
			// Scenario: users → posts (hasMany) → comments (hasMany)
			// First hop: posts.author_id → users.id  (hasMany: users.id = posts.author_id)
			// Second hop: comments.post_id → posts.id (hasMany: posts.id = comments.post_id)
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*', table: 'users' },
					{
						type: 'includeStrategy',
						choice: 'join',
						relationName: 'posts',
						targetTable: 'posts',
						sourceTable: 'users',
						relationType: 'hasMany',
						foreignKey: 'author_id',
						parentKey: 'id',
						columns: ['id', 'title'],
					} satisfies PlanDecision,
					{
						type: 'includeStrategy',
						choice: 'join',
						relationName: 'comments',
						targetTable: 'comments',
						sourceTable: 'posts',
						relationType: 'hasMany',
						foreignKey: 'post_id',
						parentKey: 'id',
						columns: ['id', 'body'],
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			// Second hop must join on posts.id = comments.post_id (not users.id)
			expect(result.sql).toMatch(/posts\.id\s*=\s*comments\.post_id/);
			expect(result.sql).not.toContain('users.post_id');
		});
	});

	describe('mixed JOIN filter + LEFT JOIN include', () => {
		it('should compile INNER JOIN for filter and LEFT JOIN for include', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*', table: 'posts' },
					// LEFT JOIN include for author
					{
						type: 'includeStrategy',
						choice: 'join',
						relationName: 'author',
						targetTable: 'authors',
						relationType: 'belongsTo',
						foreignKey: 'author_id',
						parentKey: 'id',
						columns: ['id', 'name'],
					} satisfies PlanDecision,
					// INNER JOIN filter for category
					{
						type: 'where',
						operator: 'exists',
						choice: 'join',
						targetTable: 'categories',
						foreignKey: 'category_id',
						conditions: [
							{
								type: 'where',
								column: 'slug',
								operator: 'eq',
								value: 'tech',
								table: 'categories',
							},
						],
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			// LEFT JOIN for include
			expect(result.sql).toMatch(/LEFT JOIN\s+authors/i);
			expect(result.sql).toContain('"author.id"');
			// INNER JOIN for filter
			expect(result.sql).toMatch(/JOIN\s+categories/);
			expect(result.parameters).toEqual(['tech']);
		});
	});
});
