/**
 * Nested json_agg compilation tests
 *
 * Tests for the recursive compileJsonAggDecision path:
 * - Single-level includes (no children)
 * - Two-level nested includes (parent → child)
 * - Deep nesting (6 levels) to verify stack safety
 * - ResTarget extraction edge cases
 */

import { parseSync } from 'pgsql-parser';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import {
	compilePlan,
	type PlanDecision,
	type SimplifiedPlanReport,
} from '../compiler.js';

function buildJsonAggDecision(
	overrides: Partial<PlanDecision> = {},
): PlanDecision {
	return {
		type: 'selectJsonAgg',
		relationName: 'posts',
		targetTable: 'posts',
		relationType: 'hasMany',
		foreignKey: 'user_id',
		parentKey: 'id',
		...overrides,
	};
}

describe('Nested json_agg compilation', () => {
	it('compiles single-level json_agg include (no children)', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [buildJsonAggDecision()],
		};

		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('json_agg');
		expect(sql).toContain('__t__');
		expect(sql).toContain('posts');
		expect(sql).toContain('__t__.user_id = users.id');
		// Should NOT have jsonb_build_object (no children)
		expect(sql).not.toContain('jsonb_build_object');

		// Must be valid SQL
		const parsed = parseSync(result.sql);
		expect(parsed.stmts).toHaveLength(1);
	});

	it('compiles two-level nested json_agg (parent → child)', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				buildJsonAggDecision({
					relationName: 'userRoles',
					targetTable: 'user_roles',
					relationType: 'hasMany',
					foreignKey: 'user_id',
					parentKey: 'id',
					children: [
						buildJsonAggDecision({
							relationName: 'role',
							targetTable: 'roles',
							relationType: 'belongsTo',
							foreignKey: 'role_id',
							parentKey: 'id',
						}),
					],
				}),
			],
		};

		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		// Root level uses __t__
		expect(sql).toContain('user_roles as __t__');
		expect(sql).toContain('__t__.user_id = users.id');

		// Nested level uses __t1__
		expect(sql).toContain('roles as __t1__');
		expect(sql).toContain('__t1__.id = __t__.role_id');

		// Must have jsonb_build_object for merging child
		expect(sql).toContain('jsonb_build_object');
		expect(sql).toContain("'role'");

		// Must be valid SQL
		const parsed = parseSync(result.sql);
		expect(parsed.stmts).toHaveLength(1);
	});

	it('compiles three-level nested json_agg', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				buildJsonAggDecision({
					relationName: 'userRoles',
					targetTable: 'user_roles',
					relationType: 'hasMany',
					foreignKey: 'user_id',
					parentKey: 'id',
					children: [
						buildJsonAggDecision({
							relationName: 'role',
							targetTable: 'roles',
							relationType: 'belongsTo',
							foreignKey: 'role_id',
							parentKey: 'id',
							children: [
								buildJsonAggDecision({
									relationName: 'permissions',
									targetTable: 'permissions',
									relationType: 'hasMany',
									foreignKey: 'role_id',
									parentKey: 'id',
								}),
							],
						}),
					],
				}),
			],
		};

		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		// Depth 0: __t__
		expect(sql).toContain('user_roles as __t__');
		// Depth 1: __t1__
		expect(sql).toContain('roles as __t1__');
		// Depth 2: __t2__
		expect(sql).toContain('permissions as __t2__');

		// Correct correlations chain through intermediate tables
		expect(sql).toContain('__t__.user_id = users.id');
		expect(sql).toContain('__t1__.id = __t__.role_id');
		expect(sql).toContain('__t2__.role_id = __t1__.id');

		// Must be valid SQL
		const parsed = parseSync(result.sql);
		expect(parsed.stmts).toHaveLength(1);
	});

	it('compiles 6-level deep nesting without stack overflow', () => {
		// Build a 6-level chain: a → b → c → d → e → f
		const tables = ['a', 'b', 'c', 'd', 'e', 'f'] as const;

		function buildChain(depth: number): PlanDecision {
			const table = tables[depth] as string;
			const parent = (tables[depth - 1] as string | undefined) ?? 'root';
			const child =
				depth < tables.length - 1 ? buildChain(depth + 1) : undefined;
			return buildJsonAggDecision({
				relationName: table,
				targetTable: table,
				relationType: 'hasMany',
				foreignKey: `${parent}_id`,
				parentKey: 'id',
				...(child ? { children: [child] } : {}),
			});
		}

		const plan: SimplifiedPlanReport = {
			rootTable: 'root',
			decisions: [buildChain(0)],
		};

		// Should not throw (stack safety)
		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		// Verify all 6 depth aliases exist
		expect(sql).toContain('as __t__'); // depth 0
		expect(sql).toContain('as __t1__'); // depth 1
		expect(sql).toContain('as __t2__'); // depth 2
		expect(sql).toContain('as __t3__'); // depth 3
		expect(sql).toContain('as __t4__'); // depth 4
		expect(sql).toContain('as __t5__'); // depth 5

		// Must be valid SQL
		const parsed = parseSync(result.sql);
		expect(parsed.stmts).toHaveLength(1);
	});

	it('skips children with missing required fields', () => {
		// Build child without relationType (omitted, not undefined)
		const brokenChild: PlanDecision = {
			type: 'selectJsonAgg',
			relationName: 'orphan',
			targetTable: 'orphans',
			foreignKey: 'user_id',
			parentKey: 'id',
		};
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				buildJsonAggDecision({
					children: [brokenChild],
				}),
			],
		};

		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		// Should compile without the broken child
		expect(sql).toContain('posts');
		expect(sql).not.toContain('orphans');
		// Should NOT have jsonb_build_object (child was skipped)
		expect(sql).not.toContain('jsonb_build_object');

		// Must be valid SQL
		const parsed = parseSync(result.sql);
		expect(parsed.stmts).toHaveLength(1);
	});
});
