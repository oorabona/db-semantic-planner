/**
 * Plan Decision Extractor Tests
 *
 * Tests for extractJsonAggDecisions tree-building logic:
 * - Single root include (no nesting)
 * - Multi-root includes (siblings)
 * - Nested includes (parent → child via intentPath)
 * - Deeply nested includes (3+ levels)
 * - Edge cases: missing intentPath, orphan child, no target
 */

import type { PlanReport } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { extractJsonAggDecisions } from '../plan-decision-extractor.js';

type Decision = PlanReport['decisions'][number];

function makePlanReport(
	decisions: Decision[],
	rootTable = 'users',
): PlanReport {
	return {
		rootTable,
		decisions,
		intent: {},
		warnings: [],
	} as unknown as PlanReport;
}

function makeIncludeDecision(
	context: Record<string, unknown>,
): Decision {
	return {
		id: 'test',
		type: 'include-strategy',
		choice: 'json_agg',
		reasoning: 'test',
		alternatives: [],
		context: {
			sourceTable: 'users',
			...context,
		},
	} as unknown as Decision;
}

describe('extractJsonAggDecisions', () => {
	it('returns empty for no include-strategy decisions', () => {
		const plan = makePlanReport([
			{
				id: 'w1',
				type: 'filter-strategy',
				choice: 'exists',
				reasoning: 'test',
				alternatives: [],
				context: { sourceTable: 'users', target: 'roles' },
			} as unknown as Decision,
		]);
		expect(extractJsonAggDecisions(plan)).toEqual([]);
	});

	it('extracts single root include', () => {
		const plan = makePlanReport([
			makeIncludeDecision({
				target: 'posts',
				relation: 'posts',
				intentPath: 'include[0]',
			}),
		]);

		const result = extractJsonAggDecisions(plan);
		expect(result).toHaveLength(1);
		expect(result[0]?.type).toBe('selectJsonAgg');
		expect(result[0]?.relationName).toBe('posts');
		expect(result[0]?.targetTable).toBe('posts');
		expect(result[0]?.children).toBeUndefined();
	});

	it('extracts multiple sibling root includes', () => {
		const plan = makePlanReport([
			makeIncludeDecision({
				target: 'posts',
				relation: 'posts',
				intentPath: 'include[0]',
			}),
			makeIncludeDecision({
				target: 'comments',
				relation: 'comments',
				intentPath: 'include[1]',
			}),
		]);

		const result = extractJsonAggDecisions(plan);
		expect(result).toHaveLength(2);
		expect(result[0]?.relationName).toBe('posts');
		expect(result[1]?.relationName).toBe('comments');
	});

	it('builds tree for nested include (parent → child)', () => {
		const plan = makePlanReport([
			makeIncludeDecision({
				target: 'user_roles',
				relation: 'userRoles',
				relationType: 'hasMany',
				foreignKey: 'user_id',
				intentPath: 'include[0]',
			}),
			makeIncludeDecision({
				target: 'roles',
				relation: 'role',
				relationType: 'belongsTo',
				foreignKey: 'role_id',
				sourceTable: 'user_roles',
				intentPath: 'include[0].include[0]',
			}),
		]);

		const result = extractJsonAggDecisions(plan);
		expect(result).toHaveLength(1);
		expect(result[0]?.relationName).toBe('userRoles');
		expect(result[0]?.children).toBeDefined();
		expect(result[0]?.children).toHaveLength(1);
		expect(result[0]?.children?.[0]?.relationName).toBe('role');
		expect(result[0]?.children?.[0]?.children).toBeUndefined();
	});

	it('builds tree for 3-level nesting', () => {
		const plan = makePlanReport([
			makeIncludeDecision({
				target: 'user_roles',
				relation: 'userRoles',
				intentPath: 'include[0]',
			}),
			makeIncludeDecision({
				target: 'roles',
				relation: 'role',
				sourceTable: 'user_roles',
				intentPath: 'include[0].include[0]',
			}),
			makeIncludeDecision({
				target: 'permissions',
				relation: 'permissions',
				sourceTable: 'roles',
				intentPath: 'include[0].include[0].include[0]',
			}),
		]);

		const result = extractJsonAggDecisions(plan);
		expect(result).toHaveLength(1);
		expect(result[0]?.children).toHaveLength(1);
		expect(result[0]?.children?.[0]?.children).toHaveLength(1);
		expect(result[0]?.children?.[0]?.children?.[0]?.relationName).toBe(
			'permissions',
		);
	});

	it('treats include without intentPath as root', () => {
		const plan = makePlanReport([
			makeIncludeDecision({
				target: 'posts',
				relation: 'posts',
			}),
		]);

		const result = extractJsonAggDecisions(plan);
		expect(result).toHaveLength(1);
		expect(result[0]?.relationName).toBe('posts');
	});

	it('treats orphan child (no matching parent) as root', () => {
		const plan = makePlanReport([
			makeIncludeDecision({
				target: 'permissions',
				relation: 'permissions',
				intentPath: 'include[99].include[0]',
			}),
		]);

		const result = extractJsonAggDecisions(plan);
		expect(result).toHaveLength(1);
		expect(result[0]?.relationName).toBe('permissions');
	});

	it('ignores non-json_agg include-strategy decisions', () => {
		const plan = makePlanReport([
			{
				id: 'j1',
				type: 'include-strategy',
				choice: 'join',
				reasoning: 'test',
				alternatives: [],
				context: {
					sourceTable: 'users',
					target: 'authors',
					relation: 'author',
					intentPath: 'include[0]',
				},
			} as unknown as Decision,
		]);

		const result = extractJsonAggDecisions(plan);
		expect(result).toEqual([]);
	});

	it('skips decisions with no target', () => {
		const plan = makePlanReport([
			makeIncludeDecision({
				target: undefined,
				relation: 'ghost',
				intentPath: 'include[0]',
			}),
		]);

		const result = extractJsonAggDecisions(plan);
		expect(result).toEqual([]);
	});

	it('handles multiple children under same parent', () => {
		const plan = makePlanReport([
			makeIncludeDecision({
				target: 'user_roles',
				relation: 'userRoles',
				intentPath: 'include[0]',
			}),
			makeIncludeDecision({
				target: 'roles',
				relation: 'role',
				sourceTable: 'user_roles',
				intentPath: 'include[0].include[0]',
			}),
			makeIncludeDecision({
				target: 'permissions',
				relation: 'permissions',
				sourceTable: 'user_roles',
				intentPath: 'include[0].include[1]',
			}),
		]);

		const result = extractJsonAggDecisions(plan);
		expect(result).toHaveLength(1);
		expect(result[0]?.children).toHaveLength(2);
		expect(result[0]?.children?.[0]?.relationName).toBe('role');
		expect(result[0]?.children?.[1]?.relationName).toBe('permissions');
	});
});
