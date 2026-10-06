/**
 * @module compiler-join-filter.test
 * Unit tests for F-005: relation filters compile as EXISTS.
 */

import {
	compilePlan,
	type PlanDecision,
	type SimplifiedPlanReport,
} from '@dbsp/adapter-pgsql/internal';
import { describe, expect, it } from 'vitest';

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

describe('EXISTS filter compilation (F-005)', () => {
	describe('belongsTo filter with choice=exists', () => {
		it('should compile EXISTS for a belongsTo filter', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						choice: 'exists',
						relationType: 'belongsTo',
						targetTable: 'authors',
						foreignKey: 'author_id',
						conditions: [
							{
								type: 'where',
								column: 'name',
								operator: 'eq',
								value: 'Alice',
								table: 'authors',
							},
						],
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			expect(result.sql).toBe(
				'SELECT * FROM posts WHERE EXISTS (SELECT 1 FROM authors AS authors_exists_0 WHERE posts.author_id = authors_exists_0.id AND authors_exists_0.name = $1)',
			);

			expect(result.parameters).toEqual(['Alice']);
		});

		it('should compile EXISTS without user conditions', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						choice: 'exists',
						relationType: 'belongsTo',
						targetTable: 'authors',
						foreignKey: 'author_id',
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			expect(result.sql).toBe(
				'SELECT * FROM posts WHERE EXISTS (SELECT 1 FROM authors AS authors_exists_0 WHERE posts.author_id = authors_exists_0.id)',
			);
		});

		it('should use derived FK when foreignKey not specified', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						choice: 'exists',
						relationType: 'belongsTo',
						targetTable: 'authors',
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			expect(result.sql).toBe(
				'SELECT * FROM posts WHERE EXISTS (SELECT 1 FROM authors AS authors_exists_0 WHERE posts.author_id = authors_exists_0.id)',
			);
		});
	});

	describe('EXISTS without a strategy override', () => {
		it('should use EXISTS when no choice specified', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'authors',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						targetTable: 'posts',
						foreignKey: 'author_id',
						conditions: [
							{
								type: 'where',
								column: 'published',
								operator: 'eq',
								value: true,
								table: 'posts',
							},
						],
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			expect(result.sql).toContain('EXISTS');
			expect(result.sql).not.toMatch(/\bJOIN\b/);
		});

		it('should use EXISTS when choice=exists', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'authors',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						choice: 'exists',
						targetTable: 'posts',
						foreignKey: 'author_id',
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			expect(result.sql).toContain('EXISTS');
		});
	});

	describe('multiple EXISTS predicates', () => {
		it('should compile multiple EXISTS predicates from different filters', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						choice: 'exists',
						relationType: 'belongsTo',
						targetTable: 'authors',
						foreignKey: 'author_id',
						conditions: [
							{
								type: 'where',
								column: 'name',
								operator: 'eq',
								value: 'Alice',
								table: 'authors',
							},
						],
					} satisfies PlanDecision,
					{
						type: 'where',
						operator: 'exists',
						choice: 'exists',
						relationType: 'belongsTo',
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

			expect(result.sql).toBe(
				'SELECT * FROM posts WHERE EXISTS (SELECT 1 FROM authors AS authors_exists_0 WHERE posts.author_id = authors_exists_0.id AND authors_exists_0.name = $1) AND EXISTS (SELECT 1 FROM categories AS categories_exists_1 WHERE posts.category_id = categories_exists_1.id AND categories_exists_1.slug = $2)',
			);

			expect(result.parameters).toEqual(['Alice', 'tech']);
		});
	});

	describe('self-referential relation', () => {
		it('should use a scoped alias for self-referential EXISTS', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'categories',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						choice: 'exists',
						relationType: 'belongsTo',
						targetTable: 'categories',
						foreignKey: 'parent_id',
						relationName: 'parent',
						conditions: [
							{
								type: 'where',
								column: 'name',
								operator: 'eq',
								value: 'Root',
								table: 'categories',
							},
						],
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			expect(result.sql).toBe(
				'SELECT * FROM categories WHERE EXISTS (SELECT 1 FROM categories AS categories_exists_0 WHERE categories.parent_id = categories_exists_0.id AND categories_exists_0.name = $1)',
			);
		});
	});

	describe('to-one and to-many EXISTS', () => {
		it('should compile EXISTS for both to-one and to-many filters', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },

					{
						type: 'where',
						operator: 'exists',
						choice: 'exists',
						relationType: 'belongsTo',
						targetTable: 'authors',
						foreignKey: 'author_id',
						conditions: [
							{
								type: 'where',
								column: 'active',
								operator: 'eq',
								value: true,
								table: 'authors',
							},
						],
					} satisfies PlanDecision,

					{
						type: 'where',
						operator: 'exists',
						targetTable: 'comments',
						foreignKey: 'post_id',
						conditions: [
							{
								type: 'where',
								column: 'approved',
								operator: 'eq',
								value: true,
								table: 'comments',
							},
						],
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			expect(result.sql).toBe(
				'SELECT * FROM posts WHERE EXISTS (SELECT 1 FROM authors AS authors_exists_0 WHERE posts.author_id = authors_exists_0.id AND authors_exists_0.active = $1) AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts.id = comments_exists_1.post_id AND comments_exists_1.approved = $2)',
			);
		});
	});
});
