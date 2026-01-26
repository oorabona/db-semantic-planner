/**
 * E2E-004: Strategy Matrix - Include Strategy Auto Mode
 *
 * Tests that the planner selects optimal include strategy based on:
 * - Relation cardinality (to-one vs to-many)
 * - Dialect capabilities (json_agg, lateral, CTE)
 * - Explicit overrides (relation hints, planner options)
 *
 * Uses PostgreSQL which supports all features:
 * - supportsRecursiveCTE: true
 * - supportsLateralJoin: true
 * - supportsJsonAgg: true
 */

import type { PlanReport } from '@dbsp/core';
import {
	createOrm,
	eq,
	exists,
	fk,
	POSTGRESQL_CAPABILITIES,
	schema,
} from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * PostgreSQL dialect capabilities for auto strategy selection.
 */
const dialectCapabilities = POSTGRESQL_CAPABILITIES;

import {
	blogModel,
	closeTestDb,
	createBlogSchema,
	dropBlogSchema,
	getTestAdapter,
	seedBlogData,
	shouldSkipE2E,
} from './testkit/index.js';

/**
 * Helper to extract include-strategy decision from plan report.
 */
function getIncludeStrategyDecision(report: PlanReport, relationName: string) {
	return report.decisions.find(
		(d) =>
			d.type === 'include-strategy' && d.context?.relation === relationName,
	);
}

describe.skipIf(shouldSkipE2E())('E2E-004: Strategy Matrix', () => {
	const SCHEMA = 'strategy_matrix_e2e';

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
	// Section A: To-One Relations (json_agg by default, like all relations)
	// =========================================================================
	describe('Section A: To-One Relations (json_agg by default)', () => {
		describe('E2E-004-A1: belongsTo uses json_agg strategy', () => {
			it('should auto-select json_agg for belongsTo relation', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({
					model: blogModel,
					adapter,
					dialectCapabilities,
				});

				// When: posts include author (belongsTo)
				const query = orm
					.withSchema(SCHEMA)
					.select('posts')
					.include('author')
					.columns(['id', 'title']);

				const dump = query.dump();

				// Then: planner decides strategy: 'json_agg' (same as all relations)
				const decision = getIncludeStrategyDecision(dump.plan, 'author');
				expect(decision).toBeDefined();
				expect(decision?.choice).toBe('json_agg');

				// And: SQL contains json_agg subquery pattern
				expect(dump.sql.toLowerCase()).toContain('json_agg');
			});

			it('should return correct author object for each post', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({
					model: blogModel,
					adapter,
					dialectCapabilities,
				});

				const posts = (await orm
					.withSchema(SCHEMA)
					.select('posts')
					.include('author')
					.columns(['id', 'title'])
					.execute()) as any[];

				// All posts should have author object (unwrapped from array for to-one)
				expect(posts.length).toBeGreaterThan(0);
				for (const post of posts) {
					expect(post.author).toBeDefined();
					expect(post.author.name).toBeDefined();
				}
			});
		});

		describe('E2E-004-A2: hasOne uses json_agg strategy', () => {
			it('should auto-select json_agg for hasOne relation', async () => {
				// ARCH-005: Create schema with hasOne relationship using schema() + fk()
				// unique: true on FK creates 1:1 (hasOne on inverse)
				const schemaWithProfile = schema({
					users: {
						id: { type: 'integer', primaryKey: true },
						name: 'string',
					},
					profiles: {
						id: { type: 'integer', primaryKey: true },
						// unique: true makes this 1:1 (hasOne relationship)
						userId: fk('users', { unique: true }),
						bio: 'string',
					},
				});

				const adapter = await getTestAdapter();
				const orm = createOrm({
					schema: schemaWithProfile,
					adapter,
					dialectCapabilities,
				});

				// When: users include profile (hasOne via userId_profile relation)
				// ARCH-005: relation name is userId_profile (auto-inferred from unique FK)
				const query = orm.select('users').include('userId_profile');

				const dump = query.dump();

				// Then: planner decides strategy: 'json_agg' (same as all relations)
				// ARCH-005: relation name is now userId_profile
				const decision = getIncludeStrategyDecision(
					dump.plan,
					'userId_profile',
				);
				expect(decision).toBeDefined();
				expect(decision?.choice).toBe('json_agg');

				// And: SQL contains json_agg
				expect(dump.sql.toLowerCase()).toContain('json_agg');
			});
		});
	});

	// =========================================================================
	// Section B: To-Many with json_agg (PostgreSQL)
	// =========================================================================
	describe('Section B: To-Many with json_agg', () => {
		describe('E2E-004-B1: hasMany auto-selects json_agg on PostgreSQL', () => {
			it('should auto-select json_agg for hasMany relation', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({
					model: blogModel,
					adapter,
					dialectCapabilities,
				});

				// When: authors include posts (hasMany) with PostgreSQL
				const query = orm
					.withSchema(SCHEMA)
					.select('authors')
					.include('posts')
					.columns(['id', 'name']);

				const dump = query.dump();

				// Then: planner decides strategy: 'json_agg'
				const decision = getIncludeStrategyDecision(dump.plan, 'posts');
				expect(decision).toBeDefined();
				expect(decision?.choice).toBe('json_agg');

				// And: SQL contains json_agg
				expect(dump.sql.toLowerCase()).toMatch(/json_agg|coalesce/);
			});

			it('should return authors with posts array (no row explosion)', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({
					model: blogModel,
					adapter,
					dialectCapabilities,
				});

				const authors = (await orm
					.withSchema(SCHEMA)
					.select('authors')
					.include('posts')
					.columns(['id', 'name'])
					.execute()) as any[];

				// Should have exactly 2 authors (Alice and Bob from seed)
				expect(authors).toHaveLength(2);

				// Each author should have posts array
				for (const author of authors) {
					expect(Array.isArray(author.posts)).toBe(true);
				}

				// Total posts across authors should match seed data (5 posts)
				const totalPosts = authors.reduce(
					(sum: number, a: { posts: unknown[] }) => sum + a.posts.length,
					0,
				);
				expect(totalPosts).toBe(5);
			});
		});

		describe('E2E-004-B2: Nested hasMany relations', () => {
			it('should use json_agg for nested to-many includes', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({
					model: blogModel,
					adapter,
					dialectCapabilities,
				});

				// When: posts include comments (hasMany)
				const query = orm
					.withSchema(SCHEMA)
					.select('posts')
					.include('comments')
					.columns(['id', 'title']);

				const dump = query.dump();

				// Then: strategy is json_agg
				const decision = getIncludeStrategyDecision(dump.plan, 'comments');
				expect(decision).toBeDefined();
				expect(decision?.choice).toBe('json_agg');
			});
		});
	});

	// =========================================================================
	// Section F: Explicit Overrides
	// =========================================================================
	describe('Section F: Explicit Overrides', () => {
		describe('E2E-004-F1: relation hint overrides auto', () => {
			it('should use JOIN when schema hint specifies it', async () => {
				// Create schema with relations
				const schemaWithJoinHint = schema({
					users: {
						id: { type: 'integer', primaryKey: true },
						name: 'string',
					},
					posts: {
						id: { type: 'integer', primaryKey: true },
						userId: fk('users'),
						title: 'string',
					},
				});

				// ARCH-005: Set includeStrategy directly on the relation in ModelIR
				// Relations are stored at model.relations keyed by "source.relationName"
				const model = schemaWithJoinHint.model;
				const usersPostsRel = model.relations.get('users.userId_posts');
				if (usersPostsRel) {
					(usersPostsRel as { includeStrategy?: string }).includeStrategy =
						'join';
				}

				const adapter = await getTestAdapter();
				const orm = createOrm({
					model,
					adapter,
					dialectCapabilities,
				});

				// ARCH-005: relation name is now userId_posts (auto-inferred inverse)
				const query = orm.select('users').include('userId_posts');
				const dump = query.dump();

				// Then: uses JOIN (not json_agg) due to explicit hint
				const decision = getIncludeStrategyDecision(dump.plan, 'userId_posts');
				expect(decision).toBeDefined();
				expect(decision?.choice).toBe('join');

				// SQL uses LEFT JOIN, not json_agg
				expect(dump.sql.toLowerCase()).toContain('left join');
				expect(dump.sql.toLowerCase()).not.toMatch(/json_agg/);
			});
		});

		describe('E2E-004-F2: planner option overrides auto', () => {
			it('should use separate when defaultIncludeStrategy specified', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({
					model: blogModel,
					adapter,
					defaultIncludeStrategy: 'separate',
				});

				const query = orm.withSchema(SCHEMA).select('authors').include('posts');
				const dump = query.dump();

				// Then: uses separate (not json_agg) due to planner option
				const decision = getIncludeStrategyDecision(dump.plan, 'posts');
				expect(decision).toBeDefined();
				expect(decision?.choice).toBe('separate');
			});
		});
	});

	// =========================================================================
	// Section G: Filter Strategies (EXISTS vs JOIN)
	// =========================================================================
	describe('Section G: Filter Strategies', () => {
		describe('E2E-004-G1: to-many filter uses EXISTS', () => {
			it('should use EXISTS for hasMany filter', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({
					model: blogModel,
					adapter,
					dialectCapabilities,
				});

				// When: filter authors by having published posts
				const query = orm
					.withSchema(SCHEMA)
					.select('authors')
					.where(exists('posts', { where: eq('published', true) }))
					.columns(['id', 'name']);

				const dump = query.dump();

				// Then: SQL contains EXISTS (not JOIN for filter)
				expect(dump.sql.toUpperCase()).toContain('EXISTS');
				expect(dump.sql.toUpperCase()).toContain('SELECT 1');
			});

			it('should return correct filtered results without duplicates', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({
					model: blogModel,
					adapter,
					dialectCapabilities,
				});

				const authorsWithPublished = (await orm
					.withSchema(SCHEMA)
					.select('authors')
					.where(exists('posts', { where: eq('published', true) }))
					.columns(['id', 'name'])
					.execute()) as any[];

				// Both Alice and Bob have published posts (from seed)
				expect(authorsWithPublished).toHaveLength(2);

				// No duplicates - each author appears once
				const ids = authorsWithPublished.map((a: { id: number }) => a.id);
				const uniqueIds = [...new Set(ids)];
				expect(uniqueIds.length).toBe(ids.length);
			});
		});

		describe('E2E-004-G2: to-one filter uses JOIN', () => {
			// TODO: Qualified path filtering (eq('author.name', 'value')) is not yet implemented.
			// This would require the planner to recognize relation path syntax and generate
			// appropriate JOINs for to-one relations when filtering.
			// For now, use exists() for relation filtering.
			it.todo(
				'should use JOIN for belongsTo filter with qualified path syntax',
			);
		});

		describe('E2E-004-G3: multi-level relation filter', () => {
			it('should find posts with comments using EXISTS', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({
					model: blogModel,
					adapter,
					dialectCapabilities,
				});

				const query = orm
					.withSchema(SCHEMA)
					.select('posts')
					.where(exists('comments'))
					.columns(['id', 'title']);

				const dump = query.dump();

				// Then: EXISTS subquery for to-many filter
				expect(dump.sql.toUpperCase()).toContain('EXISTS');
			});

			it('should correctly filter posts with comments', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({
					model: blogModel,
					adapter,
					dialectCapabilities,
				});

				const postsWithComments = (await orm
					.withSchema(SCHEMA)
					.select('posts')
					.where(exists('comments'))
					.columns(['id', 'title'])
					.execute()) as any[];

				// Posts 1, 2, 3 have comments according to seed
				expect(postsWithComments.length).toBeGreaterThanOrEqual(3);
			});
		});
	});

	// =========================================================================
	// Section H: Pagination Correctness
	// =========================================================================
	describe('Section H: Pagination Correctness', () => {
		describe('E2E-004-H1: json_agg preserves pagination', () => {
			it('should return correct number of parents with limit', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({
					model: blogModel,
					adapter,
					dialectCapabilities,
				});

				// When: limit 1 author with posts
				const authors = (await orm
					.withSchema(SCHEMA)
					.select('authors')
					.include('posts')
					.limit(1)
					.execute()) as any[];

				// Then: exactly 1 author returned
				expect(authors).toHaveLength(1);

				// And: that author has all their posts (not limited)
				expect(Array.isArray(authors[0].posts)).toBe(true);
				expect(authors[0].posts.length).toBeGreaterThan(0);
			});

			it('should work with offset for pagination', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({
					model: blogModel,
					adapter,
					dialectCapabilities,
				});

				// Get first author
				const firstPage = (await orm
					.withSchema(SCHEMA)
					.select('authors')
					.include('posts')
					.orderBy('id', 'asc')
					.limit(1)
					.execute()) as any[];

				// Get second author
				const secondPage = (await orm
					.withSchema(SCHEMA)
					.select('authors')
					.include('posts')
					.orderBy('id', 'asc')
					.limit(1)
					.offset(1)
					.execute()) as any[];

				// Different authors
				expect(firstPage[0].id).not.toBe(secondPage[0].id);

				// Both have their posts
				expect(firstPage[0].posts.length).toBeGreaterThan(0);
				expect(secondPage[0].posts.length).toBeGreaterThan(0);
			});
		});
	});
});
