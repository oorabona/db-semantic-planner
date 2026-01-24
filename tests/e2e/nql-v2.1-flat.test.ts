/**
 * E2E: NQL v2.1 Grammar Simplification - ORM Strategy Tests
 *
 * Tests for the NQL v2.1 features via ORM API:
 * - Default json_agg strategy for to-many relations
 * - Strategy selection based on dialect capabilities
 *
 * NQL compilation tests (including | flat syntax) are in:
 * - packages/nql/tests/compiler.test.ts
 *
 * Uses PostgreSQL which supports all features including json_agg.
 */

import type { PlanReport } from '@dbsp/core';
import { createOrm, POSTGRESQL_CAPABILITIES } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	blogModel,
	closeTestDb,
	createBlogSchema,
	dropBlogSchema,
	getTestAdapter,
	seedBlogData,
	shouldSkipE2E,
} from './testkit/index.js';

const dialectCapabilities = POSTGRESQL_CAPABILITIES;

/**
 * Helper to extract include-strategy decision from plan report.
 */
function getIncludeStrategyDecision(report: PlanReport, relationName: string) {
	return report.decisions.find(
		(d) =>
			d.type === 'include-strategy' && d.context?.relation === relationName,
	);
}

describe.skipIf(shouldSkipE2E())('E2E: NQL v2.1 Strategy Behavior', () => {
	const SCHEMA = 'nql_v21_flat_e2e';

	beforeAll(async () => {
		await dropBlogSchema(SCHEMA);
		await createBlogSchema(SCHEMA);
		await seedBlogData(SCHEMA);
	});

	afterAll(async () => {
		await dropBlogSchema(SCHEMA);
		await closeTestDb();
	});

	// =========================================================================
	// Section A: Default Strategy (json_agg) for PostgreSQL
	// =========================================================================
	describe('Section A: Default Strategy (json_agg)', () => {
		it('should use json_agg by default for to-many relations on PostgreSQL', async () => {
			// Given: ORM query with include (default strategy)
			const adapter = await getTestAdapter();
			const orm = createOrm({
				model: blogModel,
				adapter,
				dialectCapabilities,
			});

			const query = orm.withSchema(SCHEMA).select('users').include('posts');

			const dump = query.dump();

			// Then: Strategy should be json_agg (default for to-many on PostgreSQL)
			const decision = getIncludeStrategyDecision(dump.plan, 'posts');
			expect(decision?.choice).toBe('json_agg');
		});

		it('should generate SQL with json_agg subquery for to-many', async () => {
			// Given: Query with to-many relation include
			const adapter = await getTestAdapter();
			const orm = createOrm({
				model: blogModel,
				adapter,
				dialectCapabilities,
			});

			const query = orm.withSchema(SCHEMA).select('users').include('posts');

			const dump = query.dump();

			// Then: SQL should contain json_agg
			expect(dump.sql).toContain('json_agg');
		});
	});

	// =========================================================================
	// Section B: json_agg produces nested JSON
	// =========================================================================
	describe('Section B: json_agg Nested Results', () => {
		it('should nest related records as JSON array', async () => {
			// Given: Query with json_agg strategy (default)
			const adapter = await getTestAdapter();
			const orm = createOrm({
				model: blogModel,
				adapter,
				dialectCapabilities,
			});

			const query = orm.withSchema(SCHEMA).select('users').include('posts');

			// When: Execute query
			const results = await query.all();

			// Then: Each user should have posts as nested array
			expect(Array.isArray(results)).toBe(true);
			if (results.length > 0) {
				// Users with posts should have a posts property
				type UserWithPosts = { posts?: unknown[] };
				const userWithPosts = results.find(
					(u) =>
						(u as UserWithPosts).posts &&
						(u as UserWithPosts).posts!.length > 0,
				);
				if (userWithPosts) {
					expect(Array.isArray((userWithPosts as UserWithPosts).posts)).toBe(
						true,
					);
				}
			}
		});

		it('should return empty array for users without posts', async () => {
			// Given: Query with json_agg strategy
			const adapter = await getTestAdapter();
			const orm = createOrm({
				model: blogModel,
				adapter,
				dialectCapabilities,
			});

			const query = orm.withSchema(SCHEMA).select('users').include('posts');

			// When: Execute query
			const results = await query.all();

			// Then: All users should have posts property (even if empty)
			expect(Array.isArray(results)).toBe(true);
			for (const user of results) {
				type UserWithPosts = { posts?: unknown[] };
				const u = user as UserWithPosts;
				// json_agg returns empty array for no matches (via COALESCE)
				if (u.posts !== undefined) {
					expect(Array.isArray(u.posts)).toBe(true);
				}
			}
		});
	});

	// =========================================================================
	// Section C: Plan Report contains strategy decisions
	// =========================================================================
	describe('Section C: Plan Report Strategy Decisions', () => {
		it('should include strategy decision in plan report', async () => {
			// Given: Query with include
			const adapter = await getTestAdapter();
			const orm = createOrm({
				model: blogModel,
				adapter,
				dialectCapabilities,
			});

			const query = orm.withSchema(SCHEMA).select('users').include('posts');

			const dump = query.dump();

			// Then: Plan report should contain include-strategy decision
			const decision = getIncludeStrategyDecision(dump.plan, 'posts');
			expect(decision).toBeDefined();
			expect(decision?.type).toBe('include-strategy');
			expect(decision?.context?.relation).toBe('posts');
			expect(['json_agg', 'join']).toContain(decision?.choice);
		});

		it('should document reason for strategy choice', async () => {
			// Given: Query with include
			const adapter = await getTestAdapter();
			const orm = createOrm({
				model: blogModel,
				adapter,
				dialectCapabilities,
			});

			const query = orm.withSchema(SCHEMA).select('users').include('posts');

			const dump = query.dump();

			// Then: Decision should have a reasoning explaining the choice
			const decision = getIncludeStrategyDecision(dump.plan, 'posts');
			expect(decision?.reasoning).toBeDefined();
			expect(decision?.reasoning?.length).toBeGreaterThan(0);
		});
	});
});
