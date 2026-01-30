/**
 * @module compiler-join-filter.test
 * Unit tests for F-005: JOIN compilation for filter-strategy.
 *
 * When the planner emits choice: 'join' for a belongsTo (to-one) relation,
 * the compiler should produce an INNER JOIN instead of EXISTS subquery.
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

describe('JOIN filter compilation (F-005)', () => {
	describe('belongsTo filter with choice=join', () => {
		it('should compile JOIN instead of EXISTS for choice=join', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						choice: 'join',
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

			// Should contain JOIN, not EXISTS
			expect(result.sql).toContain('JOIN');
			expect(result.sql).not.toContain('EXISTS');
			// ON condition: target PK = source FK
			expect(result.sql).toMatch(/authors\.id\s*=\s*posts\.author_id/);
			// User condition in WHERE
			expect(result.sql).toMatch(/authors\.name\s*=\s*\$1/);
			expect(result.parameters).toEqual(['Alice']);
		});

		it('should compile JOIN without user conditions', () => {
			// JOIN alone filters: only rows where FK points to valid target
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						choice: 'join',
						targetTable: 'authors',
						foreignKey: 'author_id',
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			expect(result.sql).toContain('JOIN');
			expect(result.sql).not.toContain('EXISTS');
			expect(result.sql).toMatch(/authors\.id\s*=\s*posts\.author_id/);
			// No WHERE clause needed (JOIN itself filters)
			expect(result.sql).not.toMatch(/WHERE/);
		});

		it('should use derived FK when foreignKey not specified', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						choice: 'join',
						targetTable: 'authors',
						// No foreignKey — compiler derives from target table name
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			expect(result.sql).toContain('JOIN');
			// Derived FK: singular(targetTable) + 'Id' → authorsId (identity naming)
			expect(result.sql).toMatch(/authors\.id/);
		});
	});

	describe('fallback to EXISTS when choice != join', () => {
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

	describe('multiple JOINs', () => {
		it('should compile multiple JOINs from different filters', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						choice: 'join',
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

			// Both JOINs present
			expect(result.sql).toMatch(/JOIN\s+authors/);
			expect(result.sql).toMatch(/JOIN\s+categories/);
			expect(result.sql).not.toContain('EXISTS');
			// Both user conditions in WHERE
			expect(result.parameters).toEqual(['Alice', 'tech']);
		});
	});

	describe('self-referential relation', () => {
		it('should use alias for self-referential JOIN', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'categories',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						choice: 'join',
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

			expect(result.sql).toContain('JOIN');
			// Should use alias to avoid ambiguity
			expect(result.sql).toMatch(/AS\s+parent/i);
		});
	});

	describe('mixed JOIN and EXISTS', () => {
		it('should compile JOIN for choice=join and EXISTS for choice=exists', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					// belongsTo author → JOIN
					{
						type: 'where',
						operator: 'exists',
						choice: 'join',
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
					// hasMany comments → EXISTS
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

			// JOIN for authors
			expect(result.sql).toMatch(/JOIN\s+authors/);
			// EXISTS for comments
			expect(result.sql).toContain('EXISTS');
			expect(result.sql).toMatch(/comments/);
		});
	});
});
