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

import { compile } from '@dbsp/adapter-kysely';
import type { PlanReport, QueryIntent } from '@dbsp/core';
import { createOrm, POSTGRESQL_CAPABILITIES, plan } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	blogModel,
	closeTestDb,
	createBlogSchema,
	dropBlogSchema,
	getTestAdapter,
	getTestDb,
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

			const query = orm.withSchema(SCHEMA).select('authors').include('posts');

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

			const query = orm.withSchema(SCHEMA).select('authors').include('posts');

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

			const query = orm.withSchema(SCHEMA).select('authors').include('posts');

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

			const query = orm.withSchema(SCHEMA).select('authors').include('posts');

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

			const query = orm.withSchema(SCHEMA).select('authors').include('posts');

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

			const query = orm.withSchema(SCHEMA).select('authors').include('posts');

			const dump = query.dump();

			// Then: Decision should have a reasoning explaining the choice
			const decision = getIncludeStrategyDecision(dump.plan, 'posts');
			expect(decision?.reasoning).toBeDefined();
			expect(decision?.reasoning?.length).toBeGreaterThan(0);
		});
	});

	// =========================================================================
	// Section D: SPEC-002 Cross-table Relation Filters
	// =========================================================================
	describe('Section D: SPEC-002 Cross-table Relation Filters', () => {
		/**
		 * Helper to extract filter-strategy decision from plan report.
		 */
		function getFilterStrategyDecision(
			report: PlanReport,
			relationName: string,
		) {
			return report.decisions.find(
				(d) =>
					d.type === 'filter-strategy' && d.context?.relation === relationName,
			);
		}

		it('should filter authors by posts.published using EXISTS via raw Intent', async () => {
			// SPEC-002: hasMany relation filter with WHERE posts.published = true
			// Uses raw Intent API since whereRelation() is not yet on QueryBuilder
			const db = await getTestDb();
			const adapter = await getTestAdapter();

			// Build intent manually with relation filter (QueryIntent format)
			const intent: QueryIntent = {
				type: 'select',
				from: 'authors',
				where: {
					kind: 'relationFilter',
					relation: 'posts',
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'published',
						operator: 'eq',
						value: true,
					},
				},
			};

			// Plan and compile (with dialectCapabilities for proper strategy selection)
			const planReport = plan(intent, blogModel, { dialectCapabilities });
			const compiled = compile(planReport, blogModel, db, SCHEMA);

			// Execute
			const rows = await adapter.execute(compiled);

			// Then: Should return both authors (both have at least one published post)
			expect(rows).toHaveLength(2);

			// Check plan decision
			const decision = getFilterStrategyDecision(planReport, 'posts');
			expect(decision?.choice).toBe('exists');
		});

		it('should filter posts by author.name using JOIN via raw Intent', async () => {
			// SPEC-002: belongsTo relation filter with WHERE author.name = 'Alice'
			const db = await getTestDb();
			const adapter = await getTestAdapter();

			// Build intent manually with relation filter (QueryIntent format)
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				where: {
					kind: 'relationFilter',
					relation: 'author',
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'name',
						operator: 'eq',
						value: 'Alice Johnson',
					},
				},
			};

			// Plan and compile (with dialectCapabilities for proper strategy selection)
			const planReport = plan(intent, blogModel, { dialectCapabilities });
			const compiled = compile(planReport, blogModel, db, SCHEMA);

			// Execute
			const rows = await adapter.execute(compiled);

			// Then: Should use JOIN for belongsTo (single row, no explosion risk)
			const decision = getFilterStrategyDecision(planReport, 'author');
			expect(decision?.choice).toBe('join');

			// And: Should return only Alice's posts (3 posts)
			expect(rows).toHaveLength(3);
		});

		it('should apply shared filter to json_agg when WHERE and SELECT use same relation', async () => {
			// SPEC-002: Shared filter optimization
			// When WHERE has posts.published = true, the json_agg should also filter
			const db = await getTestDb();
			const adapter = await getTestAdapter();

			// Build intent with both include and relation filter on same relation (QueryIntent format)
			const intent: QueryIntent = {
				type: 'select',
				from: 'authors',
				include: [{ relation: 'posts' }],
				where: {
					kind: 'relationFilter',
					relation: 'posts',
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'published',
						operator: 'eq',
						value: true,
					},
				},
			};

			// Plan and compile to get SQL (with dialectCapabilities for json_agg strategy)
			const planReport = plan(intent, blogModel, { dialectCapabilities });
			const compiled = compile(planReport, blogModel, db, SCHEMA);

			// Debug: check include strategy decision
			const includeDecision = getIncludeStrategyDecision(planReport, 'posts');
			console.log('Include strategy decision:', includeDecision?.choice);
			console.log('Generated SQL:', compiled.sql);

			// Then: SQL should have EXISTS for WHERE check
			expect(compiled.sql.toLowerCase()).toContain('exists');
			// And: SQL should have json_agg for include
			expect(compiled.sql.toLowerCase()).toContain('json_agg');
			// And: The "published" filter should appear in both EXISTS and json_agg
			const publishedMatches = compiled.sql.match(/published/gi);
			expect(publishedMatches?.length).toBeGreaterThanOrEqual(2);

			// Execute and verify results
			const rows = await adapter.execute(compiled);

			// Should return both authors (both have published posts)
			expect(rows).toHaveLength(2);

			// Each author should only have published posts in their posts array
			for (const author of rows) {
				const posts = (author as { posts_json?: unknown[] }).posts_json ?? [];
				for (const post of posts as { published?: boolean }[]) {
					expect(post.published).toBe(true);
				}
			}
		});

		it('should filter posts by comments.author_name using EXISTS via raw Intent', async () => {
			// SPEC-002: Relation filter on posts -> comments (hasMany)
			const db = await getTestDb();
			const adapter = await getTestAdapter();

			// Build intent with relation filter for posts by comment author (QueryIntent format)
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				where: {
					kind: 'relationFilter',
					relation: 'comments',
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'author_name',
						operator: 'eq',
						value: 'Charlie',
					},
				},
			};

			// Plan and compile (with dialectCapabilities for proper strategy selection)
			const planReport = plan(intent, blogModel, { dialectCapabilities });
			const compiled = compile(planReport, blogModel, db, SCHEMA);

			// Then: Should use EXISTS for relation filter (hasMany)
			expect(compiled.sql.toLowerCase()).toContain('exists');

			// Execute
			const rows = await adapter.execute(compiled);

			// And: Should return post 1 (which has Charlie's comment)
			expect(rows).toHaveLength(1);
			expect((rows[0] as { id: number }).id).toBe(1);
		});
	});
});
