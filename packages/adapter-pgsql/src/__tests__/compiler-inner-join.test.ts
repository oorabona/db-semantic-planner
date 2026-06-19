/**
 * @module compiler-inner-join.test
 * Unit tests for INNER JOIN compilation via include(join: 'inner').
 *
 * When a PlanDecision has choice: 'join' and joinType: 'inner',
 * the compiler should produce JOIN (SQL INNER JOIN, no LEFT keyword) instead of LEFT JOIN.
 *
 * Note: The pgsql deparser renders JOIN_INNER as plain "JOIN" (not "INNER JOIN"),
 * which is semantically equivalent. Tests verify absence of "LEFT JOIN".
 */

import { describe, expect, it } from 'vitest';
import {
	compilePlan,
	type PlanDecision,
	type SimplifiedPlanReport,
} from '../compiler.js';

function compileToSql(plan: SimplifiedPlanReport): {
	sql: string;
	parameters: readonly unknown[];
} {
	return compilePlan(plan);
}

describe('INNER JOIN include compilation', () => {
	describe('join: "inner" — produces INNER JOIN', () => {
		it('should compile JOIN (inner) instead of LEFT JOIN', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'symbols',
				decisions: [
					{ type: 'select', column: '*', table: 'symbols' },
					{
						type: 'includeStrategy',
						choice: 'join',
						joinType: 'inner',
						relationName: 'file',
						targetTable: 'files',
						relationType: 'belongsTo',
						foreignKey: 'file_id',
						parentKey: 'id',
						columns: ['id', 'path'],
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			// JOIN_INNER is rendered as plain 'JOIN' by the pgsql deparser (semantically INNER JOIN)
			expect(result.sql).toContain('JOIN');
			expect(result.sql).not.toContain('LEFT JOIN');
			expect(result.sql).toMatch(/symbols\.file_id\s*=\s*file\.id/);
			expect(result.sql).toContain('"file.id"');
			expect(result.sql).toContain('"file.path"');
		});

		it('compiles a manual JOIN ON every composite key column', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{ type: 'select', column: '*', table: 'orders' },
					{
						type: 'join',
						joinType: 'inner',
						targetTable: 'order_items',
						alias: 'items',
						sourceColumn: ['order_id', 'tenant_id'],
						targetColumn: ['order_id', 'tenant_id'],
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			expect(result.sql).toContain('JOIN');
			expect(result.sql).toMatch(
				/orders\.order_id\s*=\s*items\.order_id\s+AND\s+orders\.tenant_id\s*=\s*items\.tenant_id/i,
			);
		});

		it('default (no joinType) should still produce LEFT JOIN', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'symbols',
				decisions: [
					{ type: 'select', column: '*', table: 'symbols' },
					{
						type: 'includeStrategy',
						choice: 'join',
						relationName: 'file',
						targetTable: 'files',
						relationType: 'belongsTo',
						foreignKey: 'file_id',
						parentKey: 'id',
						columns: ['id', 'path'],
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			expect(result.sql).toContain('LEFT JOIN');
			expect(result.sql).not.toContain('INNER JOIN');
		});

		it('explicit joinType: "left" should produce LEFT JOIN', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'symbols',
				decisions: [
					{ type: 'select', column: '*', table: 'symbols' },
					{
						type: 'includeStrategy',
						choice: 'join',
						joinType: 'left',
						relationName: 'file',
						targetTable: 'files',
						relationType: 'belongsTo',
						foreignKey: 'file_id',
						parentKey: 'id',
						columns: ['id', 'path'],
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			expect(result.sql).toContain('LEFT JOIN');
			expect(result.sql).not.toContain('INNER JOIN');
		});

		it('JOIN (inner) with wildcard columns', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'symbols',
				decisions: [
					{ type: 'select', column: '*', table: 'symbols' },
					{
						type: 'includeStrategy',
						choice: 'join',
						joinType: 'inner',
						relationName: 'file',
						targetTable: 'files',
						relationType: 'belongsTo',
						foreignKey: 'file_id',
						parentKey: 'id',
						columns: ['*'],
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			expect(result.sql).toContain('JOIN');
			expect(result.sql).not.toContain('LEFT JOIN');
			// Wildcard: file.* alias
			expect(result.sql).toMatch(/file\s*\.\s*\*/);
		});

		it('two inner JOINs to different tables', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'symbols',
				decisions: [
					{ type: 'select', column: '*', table: 'symbols' },
					{
						type: 'includeStrategy',
						choice: 'join',
						joinType: 'inner',
						relationName: 'file',
						targetTable: 'files',
						relationType: 'belongsTo',
						foreignKey: 'file_id',
						parentKey: 'id',
						columns: ['path'],
					} satisfies PlanDecision,
					{
						type: 'includeStrategy',
						choice: 'join',
						joinType: 'inner',
						relationName: 'project',
						targetTable: 'projects',
						relationType: 'belongsTo',
						foreignKey: 'project_id',
						parentKey: 'id',
						columns: ['name'],
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			// Both are JOIN (INNER), neither is LEFT JOIN
			expect(result.sql).not.toContain('LEFT JOIN');
			expect(result.sql).toMatch(/JOIN\s+files\s+AS\s+file/i);
			expect(result.sql).toMatch(/JOIN\s+projects\s+AS\s+project/i);
		});

		it('mixed inner JOIN and LEFT JOIN includes', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'symbols',
				decisions: [
					{ type: 'select', column: '*', table: 'symbols' },
					// inner JOIN: required relation
					{
						type: 'includeStrategy',
						choice: 'join',
						joinType: 'inner',
						relationName: 'file',
						targetTable: 'files',
						relationType: 'belongsTo',
						foreignKey: 'file_id',
						parentKey: 'id',
						columns: ['path'],
					} satisfies PlanDecision,
					// LEFT JOIN: optional relation
					{
						type: 'includeStrategy',
						choice: 'join',
						relationName: 'author',
						targetTable: 'users',
						relationType: 'belongsTo',
						foreignKey: 'author_id',
						parentKey: 'id',
						columns: ['name'],
					} satisfies PlanDecision,
				],
			};

			const result = compileToSql(plan);

			// file uses INNER (plain JOIN), author uses LEFT JOIN
			expect(result.sql).toContain('LEFT JOIN');
			// The file JOIN should appear — check both patterns
			expect(result.sql).toMatch(/JOIN\s+files\s+AS\s+file/i);
			expect(result.sql).toMatch(/LEFT JOIN\s+users\s+AS\s+author/i);
		});
	});
});
