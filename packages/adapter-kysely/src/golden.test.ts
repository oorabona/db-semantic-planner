/**
 * @module golden.test
 * Golden Tests (MVP Contract) - Q1, Q2, Q3
 *
 * These tests validate the core contract:
 * - Q1: Filter to-many → EXISTS
 * - Q2: Coverage by category → CTE + ratio (deferred - CTE not MVP)
 * - Q3: Strict mode ambiguity → AmbiguousPlanError
 */

import {
	AmbiguousPlanError,
	buildModelFromResolvedSchema,
	defineSchema,
	plan,
	type QueryIntent,
} from '@dbsp/core';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { describe, expect, it } from 'vitest';
import { compile } from './compiler.js';
import { createDump, formatDump } from './dump.js';

// ============================================================================
// Test Setup
// ============================================================================

function createTestKysely() {
	return new Kysely<Record<string, unknown>>({
		dialect: new SqliteDialect({
			database: new Database(':memory:'),
		}),
	});
}

// ============================================================================
// Q1 Schema: Products with Images
// ============================================================================

/**
 * Q1: Products with main image FR approved
 * - Products have many ProductImages
 * - Filter: images where locale='fr' AND type='main' AND approved=true
 * - Expected: EXISTS subquery
 */
const q1Schema = buildModelFromResolvedSchema(
	defineSchema(
		{
			products: {
				id: { type: 'integer', primaryKey: true },
				name: { type: 'string' },
				sku: { type: 'string' },
			},
			productImages: {
				id: { type: 'integer', primaryKey: true },
				productId: { type: 'integer' },
				locale: { type: 'string' },
				type: { type: 'string' },
				approved: { type: 'boolean' },
				url: { type: 'string' },
			},
		},
		{
			relations: {
				'products.images': { kind: 'hasMany', target: 'productImages', foreignKey: 'productId' },
				'productImages.product': { kind: 'belongsTo', target: 'products', foreignKey: 'productId' },
			},
		},
	),
);

// ============================================================================
// Q2 Schema: Categories with Products
// ============================================================================

/**
 * Q2: Coverage by category → CTE + ratio
 * - Categories have many products
 * - When same relation accessed multiple times, extract to CTE
 * - Expected: WITH clause in generated SQL
 */
const q2Schema = buildModelFromResolvedSchema(
	defineSchema(
		{
			categories: {
				id: { type: 'integer', primaryKey: true },
				name: { type: 'string' },
			},
			products: {
				id: { type: 'integer', primaryKey: true },
				categoryId: { type: 'integer' },
				active: { type: 'boolean' },
			},
		},
		{
			relations: {
				'categories.products': { kind: 'hasMany', target: 'products', foreignKey: 'categoryId' },
				'products.category': { kind: 'belongsTo', target: 'categories', foreignKey: 'categoryId' },
			},
		},
	),
);

// ============================================================================
// Q3 Schema: Users with Multiple Post Relations
// ============================================================================

/**
 * Q3: Users with ambiguous "posts" relations
 * - Users have authored posts (authoredPosts)
 * - Users have reviewed posts (reviewedPosts)
 * - Include "posts" should throw AmbiguousPlanError
 */
const q3Schema = buildModelFromResolvedSchema(
	defineSchema(
		{
			users: {
				id: { type: 'integer', primaryKey: true },
				name: { type: 'string' },
				email: { type: 'string' },
			},
			posts: {
				id: { type: 'integer', primaryKey: true },
				title: { type: 'string' },
				content: { type: 'string' },
				authorId: { type: 'integer' },
				reviewerId: { type: 'integer' },
			},
		},
		{
			relations: {
				'users.authoredPosts': { kind: 'hasMany', target: 'posts', foreignKey: 'authorId' },
				'users.reviewedPosts': { kind: 'hasMany', target: 'posts', foreignKey: 'reviewerId' },
				'posts.author': { kind: 'belongsTo', target: 'users', foreignKey: 'authorId' },
				'posts.reviewer': { kind: 'belongsTo', target: 'users', foreignKey: 'reviewerId' },
			},
		},
	),
);

// ============================================================================
// Q1: Filter to-many → EXISTS
// ============================================================================

describe('Q1: Filter to-many → EXISTS', () => {
	const kysely = createTestKysely();

	it('should generate EXISTS subquery for to-many filter', () => {
		// Products with main image FR approved
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'relationFilter',
				relation: 'images',
				mode: 'some',
				where: {
					kind: 'and',
					conditions: [
						{
							kind: 'comparison',
							field: 'locale',
							operator: 'eq',
							value: 'fr',
						},
						{
							kind: 'comparison',
							field: 'type',
							operator: 'eq',
							value: 'main',
						},
						{
							kind: 'comparison',
							field: 'approved',
							operator: 'eq',
							value: true,
						},
					],
				},
			},
		};

		const planReport = plan(intent, q1Schema);
		const compiled = compile(planReport, q1Schema, kysely);

		// Validate SQL structure
		expect(compiled.sql).toContain('exists');
		expect(compiled.sql).toContain('productImages');
		expect(compiled.sql).toContain('"products"'); // root alias (semantic)
		expect(compiled.sql).toContain('"images"'); // subquery alias (relation name)

		// Validate planner decision
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeDefined();
		expect(filterDecision?.choice).toBe('exists');
		expect(filterDecision?.context.relation).toBe('images');

		// Validate parameters (locale, type, approved)
		expect(compiled.parameters).toContain('fr');
		expect(compiled.parameters).toContain('main');
		expect(compiled.parameters).toContain(true); // boolean passed as-is, dialect handles conversion
	});

	it('should use EXISTS for hasMany cardinality (auto strategy)', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'exists',
				relation: 'images',
				where: {
					kind: 'comparison',
					field: 'approved',
					operator: 'eq',
					value: true,
				},
			},
		};

		const planReport = plan(intent, q1Schema);

		// Auto strategy should choose EXISTS for to-many
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision?.choice).toBe('exists');
		expect(filterDecision?.reasoning).toContain('cardinality');
		expect(filterDecision?.reasoning).toContain('many');
	});

	it('should generate correct JOIN correlation in EXISTS', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'exists',
				relation: 'images',
			},
		};

		const planReport = plan(intent, q1Schema);
		const compiled = compile(planReport, q1Schema, kysely);

		// EXISTS subquery should correlate on productId = products.id
		// Uses semantic alias: "images" for the relation
		expect(compiled.sql).toContain('"images"');
		expect(compiled.sql).toContain('productId');
	});

	it('should support schema prefix in EXISTS subquery', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'exists',
				relation: 'images',
			},
		};

		const planReport = plan(intent, q1Schema);
		const compiled = compile(planReport, q1Schema, kysely, 'tenant_acme');

		// Both main query and subquery should have schema prefix
		expect(compiled.sql).toContain('tenant_acme');
	});

	it('should use dump API to show full plan', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'relationFilter',
				relation: 'images',
				mode: 'some',
				where: {
					kind: 'comparison',
					field: 'locale',
					operator: 'eq',
					value: 'fr',
				},
			},
		};

		const dump = createDump(intent, q1Schema, kysely, {
			queryName: 'Q1-ProductsWithFRImage',
		});

		expect(dump.sql).toContain('exists');
		expect(dump.plan.decisions.length).toBeGreaterThan(0);
		expect(dump.meta?.queryName).toBe('Q1-ProductsWithFRImage');

		// formatDump should produce readable output
		const formatted = formatDump(dump);
		expect(formatted).toContain('Q1-ProductsWithFRImage');
		expect(formatted).toContain('filter-strategy=exists');
	});
});

// ============================================================================
// Q2: CTE Extraction → WITH Clause
// ============================================================================

describe('Q2: CTE extraction → WITH clause', () => {
	const kysely = createTestKysely();

	it('should generate WITH clause when CTE is extracted', () => {
		// Access same relation multiple times to trigger CTE extraction
		const intent: QueryIntent = {
			type: 'select',
			from: 'categories',
			select: { type: 'fields', fields: ['name'] },
			include: [
				{
					relation: 'products',
					where: {
						kind: 'comparison',
						field: 'active',
						operator: 'eq',
						value: true,
					},
				},
				{ relation: 'products' },
			],
		};

		const planReport = plan(intent, q2Schema, { enableCTEs: true });

		// Should have CTE in plan
		expect(planReport.ctes.length).toBeGreaterThanOrEqual(1);
		expect(planReport.ctes[0]?.name).toContain('products');

		// Compile should produce WITH clause
		const compiled = compile(planReport, q2Schema, kysely);

		// Validate SQL contains WITH
		expect(compiled.sql.toLowerCase()).toContain('with');
		// CTE name now includes table for uniqueness: cte_<table>_<relation>
		expect(compiled.sql.toLowerCase()).toContain('cte_categories_products');
	});

	it('should not generate WITH clause when no CTEs', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'categories',
		};

		const planReport = plan(intent, q2Schema);

		// No CTEs
		expect(planReport.ctes).toHaveLength(0);

		// Compile should not have WITH
		const compiled = compile(planReport, q2Schema, kysely);
		expect(compiled.sql.toLowerCase()).not.toContain('with');
	});

	it('should include CTE in dump output', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'categories',
			include: [{ relation: 'products' }, { relation: 'products' }],
		};

		const dump = createDump(intent, q2Schema, kysely, {
			queryName: 'Q2-CategoryCoverage',
			enableCTEs: true,
		});

		// Should have CTE decision
		const cteDecision = dump.plan.decisions.find(
			(d) => d.type === 'cte-extraction',
		);
		expect(cteDecision).toBeDefined();

		// SQL should have WITH
		expect(dump.sql.toLowerCase()).toContain('with');
	});

	it('should apply schema prefix to CTE target table', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'categories',
			include: [{ relation: 'products' }, { relation: 'products' }],
		};

		const planReport = plan(intent, q2Schema, { enableCTEs: true });
		const compiled = compile(planReport, q2Schema, kysely, 'tenant_acme');

		// CTE definition should have schema prefix
		expect(compiled.sql).toContain('tenant_acme');
	});

	it('should create cte-extraction decision', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'categories',
			include: [{ relation: 'products' }, { relation: 'products' }],
		};

		const planReport = plan(intent, q2Schema, { enableCTEs: true });

		const cteDecision = planReport.decisions.find(
			(d) => d.type === 'cte-extraction',
		);
		expect(cteDecision).toBeDefined();
		expect(cteDecision?.reasoning).toContain('accessed 2 times');
	});
});

// ============================================================================
// Q3: Strict Mode Ambiguity
// ============================================================================

describe('Q3: Strict mode ambiguity', () => {
	const kysely = createTestKysely();

	it('should throw AmbiguousPlanError when multiple relations to same target exist', () => {
		// Include "posts" when both authoredPosts and reviewedPosts exist
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: {
				kind: 'exists',
				relation: 'posts', // ambiguous - could be authoredPosts or reviewedPosts
			},
		};

		expect(() => {
			plan(intent, q3Schema);
		}).toThrow(AmbiguousPlanError);
	});

	it('should provide options array in AmbiguousPlanError', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: {
				kind: 'exists',
				relation: 'posts',
			},
		};

		try {
			plan(intent, q3Schema);
			expect.fail('Should have thrown AmbiguousPlanError');
		} catch (error) {
			expect(error).toBeInstanceOf(AmbiguousPlanError);
			const ambiguousError = error as AmbiguousPlanError;

			expect(ambiguousError.sourceTable).toBe('users');
			expect(ambiguousError.targetTable).toBe('posts');
			expect(ambiguousError.options).toContain('authoredPosts');
			expect(ambiguousError.options).toContain('reviewedPosts');
			expect(ambiguousError.options.length).toBe(2);
		}
	});

	it('should include disambiguation hint in error message', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: {
				kind: 'exists',
				relation: 'posts',
			},
		};

		try {
			plan(intent, q3Schema);
		} catch (error) {
			expect(error).toBeInstanceOf(AmbiguousPlanError);
			const message = (error as Error).message;

			// Error message should suggest using "via"
			expect(message).toContain('via');
			expect(message).toContain('authoredPosts');
			expect(message).toContain('reviewedPosts');
		}
	});

	it('should resolve ambiguity with via hint in include', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [
				{
					relation: 'posts',
					via: 'authoredPosts', // explicit disambiguation
				},
			],
		};

		// Should not throw with explicit via
		const planReport = plan(intent, q3Schema);
		expect(planReport.rootTable).toBe('users');
		expect(planReport.metadata.isAmbiguous).toBe(false);
	});

	it('should resolve ambiguity with disambiguate option', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: {
				kind: 'exists',
				relation: 'posts',
			},
		};

		// Using disambiguate option in PlanOptions
		const planReport = plan(intent, q3Schema, {
			disambiguate: { 'users.posts': 'reviewedPosts' },
		});

		expect(planReport.metadata.isAmbiguous).toBe(false);

		const compiled = compile(planReport, q3Schema, kysely);
		expect(compiled.sql).toContain('exists');
	});

	it('should work with direct relation name (not ambiguous)', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: {
				kind: 'exists',
				relation: 'authoredPosts', // direct name, not target table
			},
		};

		// Should not throw - using direct relation name
		const planReport = plan(intent, q3Schema);
		expect(planReport.rootTable).toBe('users');

		const compiled = compile(planReport, q3Schema, kysely);
		expect(compiled.sql).toContain('exists');
	});

	it('should not throw for unambiguous relations', () => {
		// posts.author is unambiguous (only one relation to users from posts)
		const intent: QueryIntent = {
			type: 'select',
			from: 'posts',
			where: {
				kind: 'exists',
				relation: 'author',
			},
		};

		const planReport = plan(intent, q3Schema);
		expect(planReport.metadata.isAmbiguous).toBe(false);
	});
});

// ============================================================================
// Integration: Complete Q1 Scenario
// ============================================================================

describe('Q1 Complete Scenario: Products with main image FR approved', () => {
	const kysely = createTestKysely();

	it('should produce correct SQL snapshot', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			select: { type: 'fields', fields: ['id', 'name', 'sku'] },
			where: {
				kind: 'relationFilter',
				relation: 'images',
				mode: 'some',
				where: {
					kind: 'and',
					conditions: [
						{
							kind: 'comparison',
							field: 'locale',
							operator: 'eq',
							value: 'fr',
						},
						{
							kind: 'comparison',
							field: 'type',
							operator: 'eq',
							value: 'main',
						},
						{
							kind: 'comparison',
							field: 'approved',
							operator: 'eq',
							value: true,
						},
					],
				},
			},
			orderBy: [{ field: 'name', direction: 'asc' }],
		};

		const dump = createDump(intent, q1Schema, kysely);

		// SQL should have this structure:
		// SELECT t0.id, t0.name, t0.sku FROM products AS t0
		// WHERE EXISTS (
		//   SELECT 1 FROM productImages AS t1
		//   WHERE t1.productId = t0.id
		//     AND t1.locale = ? AND t1.type = ? AND t1.approved = ?
		// )
		// ORDER BY t0.name ASC

		expect(dump.sql.toLowerCase()).toContain('select');
		expect(dump.sql.toLowerCase()).toContain('products');
		expect(dump.sql.toLowerCase()).toContain('exists');
		expect(dump.sql.toLowerCase()).toContain('productimages');
		expect(dump.sql.toLowerCase()).toContain('order by');

		// Parameters should be in order
		expect(dump.params).toContain('fr');
		expect(dump.params).toContain('main');
	});
});

// ============================================================================
// Integration: Complete Q3 Scenario
// ============================================================================

describe('Q3 Complete Scenario: Strict mode ambiguity detection', () => {
	it('should throw with helpful message for include ambiguity', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [
				{
					relation: 'posts', // ambiguous
				},
			],
		};

		expect(() => plan(intent, q3Schema)).toThrow(AmbiguousPlanError);
	});

	it('should provide complete error context for debugging', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: {
				kind: 'relationFilter',
				relation: 'posts',
				mode: 'some',
				where: {
					kind: 'comparison',
					field: 'title',
					operator: 'eq',
					value: 'test',
				},
			},
		};

		try {
			plan(intent, q3Schema);
		} catch (error) {
			expect(error).toBeInstanceOf(AmbiguousPlanError);
			const e = error as AmbiguousPlanError;

			// Full context available for debugging
			expect(e.sourceTable).toBe('users');
			expect(e.targetTable).toBe('posts');
			expect(e.options).toHaveLength(2);
			expect(e.name).toBe('AmbiguousPlanError');
		}
	});
});

// ============================================================================
// Q4: Filter Strategy Contract Enforcement (CORE-001)
// ============================================================================

/**
 * Q4: Verify planner filter-strategy decisions are respected by compiler
 * - belongsTo (cardinality: one) → default: 'join'
 * - hasMany (cardinality: many) → default: 'exists'
 */
describe('Q4: Filter strategy contract enforcement', () => {
	const kysely = createTestKysely();

	// Schema with both belongsTo and hasMany relations
	const filterContractSchema = buildModelFromResolvedSchema(
		defineSchema(
			{
				posts: {
					id: { type: 'integer', primaryKey: true },
					title: { type: 'string' },
					authorId: { type: 'integer' },
				},
				users: {
					id: { type: 'integer', primaryKey: true },
					name: { type: 'string' },
					role: { type: 'string' },
				},
				comments: {
					id: { type: 'integer', primaryKey: true },
					postId: { type: 'integer' },
					content: { type: 'string' },
				},
			},
			{
				relations: {
					'posts.author': { kind: 'belongsTo', target: 'users', foreignKey: 'authorId' },
					'posts.comments': { kind: 'hasMany', target: 'comments', foreignKey: 'postId' },
					'users.posts': { kind: 'hasMany', target: 'posts', foreignKey: 'authorId' },
					'comments.post': { kind: 'belongsTo', target: 'posts', foreignKey: 'postId' },
				},
			},
		),
	);

	describe('belongsTo → JOIN strategy (default)', () => {
		it('should use JOIN for belongsTo filter (posts.author)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				where: {
					kind: 'relationFilter',
					relation: 'author',
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'role',
						operator: 'eq',
						value: 'admin',
					},
				},
			};

			const planReport = plan(intent, filterContractSchema);
			const compiled = compile(planReport, filterContractSchema, kysely);

			// Verify decision is 'join'
			const filterDecision = planReport.decisions.find(
				(d) => d.type === 'filter-strategy',
			);
			expect(filterDecision).toBeDefined();
			expect(filterDecision?.choice).toBe('join');
			expect(filterDecision?.reasoning).toContain('one');

			// Verify SQL contains JOIN, not EXISTS
			expect(compiled.sql.toLowerCase()).toContain('join');
			expect(compiled.sql.toLowerCase()).not.toContain('exists');
		});

		it('should correlate JOIN correctly for belongsTo', () => {
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
						value: 'Alice',
					},
				},
			};

			const planReport = plan(intent, filterContractSchema);
			const compiled = compile(planReport, filterContractSchema, kysely);

			// Should have JOIN with correct correlation
			expect(compiled.sql).toContain('users');
			expect(compiled.sql.toLowerCase()).toContain('join');
			// authorId correlation
			expect(compiled.sql).toContain('authorId');
		});
	});

	describe('hasMany → EXISTS strategy (default)', () => {
		it('should use EXISTS for hasMany filter (posts.comments)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				where: {
					kind: 'relationFilter',
					relation: 'comments',
					mode: 'some',
					where: {
						kind: 'like',
						field: 'content',
						pattern: '%great%',
					},
				},
			};

			const planReport = plan(intent, filterContractSchema);
			const compiled = compile(planReport, filterContractSchema, kysely);

			// Verify decision is 'exists'
			const filterDecision = planReport.decisions.find(
				(d) => d.type === 'filter-strategy',
			);
			expect(filterDecision).toBeDefined();
			expect(filterDecision?.choice).toBe('exists');

			// Verify SQL contains EXISTS, not JOIN
			expect(compiled.sql.toLowerCase()).toContain('exists');
		});

		it('should generate correct EXISTS subquery for hasMany', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'exists',
					relation: 'posts',
				},
			};

			const planReport = plan(intent, filterContractSchema);
			const compiled = compile(planReport, filterContractSchema, kysely);

			// EXISTS with correlation
			expect(compiled.sql.toLowerCase()).toContain('exists');
			expect(compiled.sql).toContain('posts');
			expect(compiled.sql).toContain('authorId');
		});
	});

	describe('explicit strategy override', () => {
		// Schema with explicit strategy hints
		const overrideSchema = buildModelFromResolvedSchema(
			defineSchema(
				{
					users: {
						id: { type: 'integer', primaryKey: true },
						name: { type: 'string' },
					},
					posts: {
						id: { type: 'integer', primaryKey: true },
						userId: { type: 'integer' },
						title: { type: 'string' },
					},
				},
				{
					relations: {
						'users.posts': { kind: 'hasMany', target: 'posts', foreignKey: 'userId' },
						'posts.user': { kind: 'belongsTo', target: 'users', foreignKey: 'userId' },
					},
					hints: {
						// hasMany with explicit JOIN strategy (override default EXISTS)
						'users.posts': { defaultStrategy: 'join' },
						// belongsTo with explicit EXISTS strategy (override default JOIN)
						'posts.user': { defaultStrategy: 'exists' },
					},
				},
			),
		);

		it('should respect explicit JOIN override for hasMany', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'relationFilter',
					relation: 'posts',
					mode: 'some',
					where: {
						kind: 'like',
						field: 'title',
						pattern: '%test%',
					},
				},
			};

			const planReport = plan(intent, overrideSchema);
			const compiled = compile(planReport, overrideSchema, kysely);

			// Should use JOIN despite being hasMany (explicit override)
			const filterDecision = planReport.decisions.find(
				(d) => d.type === 'filter-strategy',
			);
			expect(filterDecision?.choice).toBe('join');
			expect(compiled.sql.toLowerCase()).toContain('join');
			expect(compiled.sql.toLowerCase()).not.toContain('exists');
		});

		it('should respect explicit EXISTS override for belongsTo', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				where: {
					kind: 'relationFilter',
					relation: 'user',
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'name',
						operator: 'eq',
						value: 'Alice',
					},
				},
			};

			const planReport = plan(intent, overrideSchema);
			const compiled = compile(planReport, overrideSchema, kysely);

			// Should use EXISTS despite being belongsTo (explicit override from schema)
			const filterDecision = planReport.decisions.find(
				(d) => d.type === 'filter-strategy',
			);
			expect(filterDecision?.choice).toBe('exists');
			expect(compiled.sql.toLowerCase()).toContain('exists');
		});
	});
});

// ============================================================================
// Q5: Include Strategy Contract Enforcement (CORE-001)
// ============================================================================

/**
 * Q5: Verify planner include-strategy decisions are respected by compiler
 * - belongsTo (cardinality: one) → default: 'join' (LEFT JOIN)
 * - hasMany (cardinality: many) → default: 'separate' (follow-up queries)
 */
describe('Q5: Include strategy contract enforcement', () => {
	const kysely = createTestKysely();

	// Schema with belongsTo and hasMany relations
	const includeContractSchema = buildModelFromResolvedSchema(
		defineSchema(
			{
				posts: {
					id: { type: 'integer', primaryKey: true },
					title: { type: 'string' },
					authorId: { type: 'integer' },
				},
				users: {
					id: { type: 'integer', primaryKey: true },
					name: { type: 'string' },
					email: { type: 'string' },
				},
				comments: {
					id: { type: 'integer', primaryKey: true },
					postId: { type: 'integer' },
					content: { type: 'string' },
				},
			},
			{
				relations: {
					'posts.author': { kind: 'belongsTo', target: 'users', foreignKey: 'authorId' },
					'posts.comments': { kind: 'hasMany', target: 'comments', foreignKey: 'postId' },
					'users.posts': { kind: 'hasMany', target: 'posts', foreignKey: 'authorId' },
					'comments.post': { kind: 'belongsTo', target: 'posts', foreignKey: 'postId' },
				},
			},
		),
	);

	describe('belongsTo → JOIN strategy (default)', () => {
		it('should use LEFT JOIN for belongsTo include', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				include: [{ relation: 'author' }],
			};

			const planReport = plan(intent, includeContractSchema);
			const compiled = compile(planReport, includeContractSchema, kysely);

			// Verify decision is 'join'
			const includeDecision = planReport.decisions.find(
				(d) =>
					d.type === 'include-strategy' && d.context?.relation === 'author',
			);
			expect(includeDecision).toBeDefined();
			expect(includeDecision?.choice).toBe('join');

			// Verify SQL contains LEFT JOIN
			expect(compiled.sql.toLowerCase()).toContain('left join');
			expect(compiled.sql).toContain('users');
		});

		it('should include aliased columns for included relation', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: { type: 'fields', fields: ['id', 'title'] },
				include: [{ relation: 'author', select: ['id', 'name'] }],
			};

			const planReport = plan(intent, includeContractSchema);
			const compiled = compile(planReport, includeContractSchema, kysely);

			// Should select aliased columns for author (format: "author.id")
			expect(compiled.sql).toContain('author.');
		});
	});

	describe('hasMany → separate strategy (explicit)', () => {
		// Note: JOIN is now the default strategy. To test SEPARATE, we explicitly request it.
		it('should NOT add JOIN for hasMany include when using separate strategy', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				include: [{ relation: 'posts' }],
			};

			const planReport = plan(intent, includeContractSchema, {
				defaultIncludeStrategy: 'separate',
			});
			const compiled = compile(planReport, includeContractSchema, kysely);

			// Verify decision is 'separate'
			const includeDecision = planReport.decisions.find(
				(d) => d.type === 'include-strategy' && d.context?.relation === 'posts',
			);
			expect(includeDecision).toBeDefined();
			expect(includeDecision?.choice).toBe('separate');

			// Main query should NOT have JOIN on posts
			expect(compiled.sql.toLowerCase()).not.toContain('join');
		});

		it('should provide metadata for follow-up queries via compileWithIncludes (separate strategy)', async () => {
			const { compileWithIncludes } = await import('./compiler.js');

			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				include: [{ relation: 'posts' }],
			};

			const planReport = plan(intent, includeContractSchema, {
				defaultIncludeStrategy: 'separate',
			});
			const result = compileWithIncludes(
				planReport,
				includeContractSchema,
				kysely,
			);

			// Should have separate include info
			expect(result.separateIncludes).toHaveLength(1);
			expect(result.separateIncludes[0]?.relationName).toBe('posts');
			expect(result.separateIncludes[0]?.targetTable).toBe('posts');
			expect(result.separateIncludes[0]?.foreignKey).toBe('authorId');
		});
	});

	describe('explicit strategy override', () => {
		// Schema with explicit include strategy hints
		const overrideSchema = buildModelFromResolvedSchema(
			defineSchema(
				{
					users: {
						id: { type: 'integer', primaryKey: true },
						name: { type: 'string' },
					},
					posts: {
						id: { type: 'integer', primaryKey: true },
						userId: { type: 'integer' },
						title: { type: 'string' },
					},
				},
				{
					relations: {
						// hasMany with explicit JOIN strategy (override default separate)
						'users.posts': { kind: 'hasMany', target: 'posts', foreignKey: 'userId', includeStrategy: 'join' },
						'posts.user': { kind: 'belongsTo', target: 'users', foreignKey: 'userId' },
					},
				},
			),
		);

		it('should respect explicit JOIN override for hasMany include', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				include: [{ relation: 'posts' }],
			};

			const planReport = plan(intent, overrideSchema);
			const compiled = compile(planReport, overrideSchema, kysely);

			// Should use JOIN despite being hasMany (explicit override)
			const includeDecision = planReport.decisions.find(
				(d) => d.type === 'include-strategy',
			);
			expect(includeDecision?.choice).toBe('join');
			expect(compiled.sql.toLowerCase()).toContain('left join');
		});
	});
});

// ============================================================================
// Q6: FK Direction Correctness (CORE-002)
// ============================================================================

/**
 * Q6: Verify FK direction is correct for different relation types
 * - belongsTo: source.foreignKey = target.primaryKey (e.g., posts.authorId = users.id)
 * - hasMany: target.foreignKey = source.primaryKey (e.g., posts.authorId = users.id)
 *
 * This test suite verifies the fix for CORE-002 where applyJoinFilters and
 * compileExists were always using the hasMany FK pattern regardless of relation type.
 */
describe('Q6: FK Direction Correctness (CORE-002)', () => {
	const kysely = createTestKysely();

	// Schema with clear FK directions for testing
	const fkDirectionSchema = buildModelFromResolvedSchema(
		defineSchema(
			{
				posts: {
					id: { type: 'integer', primaryKey: true },
					title: { type: 'string' },
					authorId: { type: 'integer' }, // FK to users.id
				},
				users: {
					id: { type: 'integer', primaryKey: true },
					name: { type: 'string' },
					role: { type: 'string' },
				},
				comments: {
					id: { type: 'integer', primaryKey: true },
					postId: { type: 'integer' }, // FK to posts.id
					content: { type: 'string' },
				},
			},
			{
				relations: {
					// belongsTo: FK is in posts table (authorId)
					'posts.author': { kind: 'belongsTo', target: 'users', foreignKey: 'authorId' },
					// hasMany: FK is in comments table (postId)
					'posts.comments': { kind: 'hasMany', target: 'comments', foreignKey: 'postId' },
					// hasMany: FK is in posts table (authorId)
					'users.posts': { kind: 'hasMany', target: 'posts', foreignKey: 'authorId' },
					// belongsTo: FK is in comments table (postId)
					'comments.post': { kind: 'belongsTo', target: 'posts', foreignKey: 'postId' },
				},
			},
		),
	);

	describe('belongsTo FK direction', () => {
		it('should use source.fk = target.pk for belongsTo JOIN (posts.author)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				where: {
					kind: 'relationFilter',
					relation: 'author',
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'role',
						operator: 'eq',
						value: 'admin',
					},
				},
			};

			const planReport = plan(intent, fkDirectionSchema);
			const compiled = compile(planReport, fkDirectionSchema, kysely);

			// CRITICAL: Verify FK direction is source.fk = target.pk
			// posts.authorId = users.id (NOT users.authorId = posts.id)
			const sqlLower = compiled.sql.toLowerCase();

			// Should contain: "t0"."authorId" = "t1"."id"
			// t0 = posts (source), t1 = users (target)
			expect(sqlLower).toContain('join');

			// Verify the JOIN uses posts.authorId (source.fk), not users.authorId
			// Uses semantic aliases: "posts" for root, "author" for relation
			expect(compiled.sql).toMatch(/"posts"\."authorId"/);

			// And target should use id (primary key)
			expect(compiled.sql).toMatch(/"author"\."id"/);

			// NEGATIVE TEST: Should NOT have author.authorId pattern
			// (which would indicate wrong FK direction - authorId is on posts, not users)
			expect(compiled.sql).not.toMatch(/"author"\."authorId"/);
		});

		it('should use source.fk = target.pk for belongsTo EXISTS (posts.author)', () => {
			// Use explicit EXISTS strategy for belongsTo
			const existsSchema = buildModelFromResolvedSchema(
				defineSchema(
					{
						posts: {
							id: { type: 'integer', primaryKey: true },
							title: { type: 'string' },
							authorId: { type: 'integer' },
						},
						users: {
							id: { type: 'integer', primaryKey: true },
							name: { type: 'string' },
							role: { type: 'string' },
						},
					},
					{
						relations: {
							'posts.author': { kind: 'belongsTo', target: 'users', foreignKey: 'authorId' },
						},
						hints: {
							'posts.author': { defaultStrategy: 'exists' },
						},
					},
				),
			);

			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				where: {
					kind: 'relationFilter',
					relation: 'author',
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'role',
						operator: 'eq',
						value: 'admin',
					},
				},
			};

			const planReport = plan(intent, existsSchema);
			const compiled = compile(planReport, existsSchema, kysely);

			// Should use EXISTS
			expect(compiled.sql.toLowerCase()).toContain('exists');

			// CRITICAL: EXISTS correlation should be source.fk = target.pk
			// posts.authorId = users.id (NOT users.authorId = posts.id)

			// The outer table (posts) should correlate via authorId
			expect(compiled.sql).toMatch(/"posts"\."authorId"/);

			// The subquery table (users, aliased as "author") should use id
			expect(compiled.sql).toMatch(/"author"\."id"/);

			// NEGATIVE TEST: Should NOT have author.authorId (authorId is on posts, not users)
			expect(compiled.sql).not.toMatch(/"author"\."authorId"/);
		});
	});

	describe('hasMany FK direction (regression)', () => {
		it('should use target.fk = source.pk for hasMany EXISTS (users.posts)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'relationFilter',
					relation: 'posts',
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'title',
						operator: 'eq',
						value: 'test',
					},
				},
			};

			const planReport = plan(intent, fkDirectionSchema);
			const compiled = compile(planReport, fkDirectionSchema, kysely);

			// hasMany defaults to EXISTS
			expect(compiled.sql.toLowerCase()).toContain('exists');

			// CRITICAL: EXISTS correlation should be target.fk = source.pk
			// posts.authorId = users.id

			// The subquery table (aliased as "posts" - relation name) should have authorId
			expect(compiled.sql).toMatch(/"posts"\."authorId"/);

			// The outer table (users) should correlate via id
			expect(compiled.sql).toMatch(/"users"\."id"/);
		});

		it('should use target.fk = source.pk for hasMany JOIN (explicit override)', () => {
			// Use explicit JOIN strategy for hasMany
			const joinSchema = buildModelFromResolvedSchema(
				defineSchema(
					{
						users: {
							id: { type: 'integer', primaryKey: true },
							name: { type: 'string' },
						},
						posts: {
							id: { type: 'integer', primaryKey: true },
							authorId: { type: 'integer' },
							title: { type: 'string' },
						},
					},
					{
						relations: {
							'users.posts': { kind: 'hasMany', target: 'posts', foreignKey: 'authorId' },
						},
						hints: {
							'users.posts': { defaultStrategy: 'join' },
						},
					},
				),
			);

			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'relationFilter',
					relation: 'posts',
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'title',
						operator: 'eq',
						value: 'test',
					},
				},
			};

			const planReport = plan(intent, joinSchema);
			const compiled = compile(planReport, joinSchema, kysely);

			// Should use JOIN
			expect(compiled.sql.toLowerCase()).toContain('join');
			expect(compiled.sql.toLowerCase()).not.toContain('exists');

			// CRITICAL: JOIN should be target.fk = source.pk
			// posts.authorId = users.id

			// Target table (aliased as "posts" - relation name) should have authorId in JOIN condition
			expect(compiled.sql).toMatch(/"posts"\."authorId"/);

			// Source table (users) should have id in JOIN condition
			expect(compiled.sql).toMatch(/"users"\."id"/);
		});
	});

	describe('include FK direction', () => {
		it('should use source.fk = target.pk for belongsTo include (posts.author)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				include: [{ relation: 'author' }],
			};

			const planReport = plan(intent, fkDirectionSchema);
			const compiled = compile(planReport, fkDirectionSchema, kysely);

			// belongsTo include uses LEFT JOIN by default
			expect(compiled.sql.toLowerCase()).toContain('left join');

			// CRITICAL: JOIN should be source.fk = target.pk
			// posts.authorId = users.id

			// Source table (posts) should have authorId
			expect(compiled.sql).toMatch(/"posts"\."authorId"/);

			// Target table (aliased as "author" - relation name) should have id
			expect(compiled.sql).toMatch(/"author"\."id"/);

			// NEGATIVE TEST: Should NOT have author.authorId (authorId is on posts, not users)
			expect(compiled.sql).not.toMatch(/"author"\."authorId"/);
		});

		it('should use target.fk = source.pk for hasMany include with JOIN override', () => {
			// Use explicit JOIN strategy for hasMany include
			const joinIncludeSchema = buildModelFromResolvedSchema(
				defineSchema(
					{
						users: {
							id: { type: 'integer', primaryKey: true },
							name: { type: 'string' },
						},
						posts: {
							id: { type: 'integer', primaryKey: true },
							authorId: { type: 'integer' },
							title: { type: 'string' },
						},
					},
					{
						relations: {
							'users.posts': { kind: 'hasMany', target: 'posts', foreignKey: 'authorId', includeStrategy: 'join' },
						},
					},
				),
			);

			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				include: [{ relation: 'posts' }],
			};

			const planReport = plan(intent, joinIncludeSchema);
			const compiled = compile(planReport, joinIncludeSchema, kysely);

			// Should use LEFT JOIN
			expect(compiled.sql.toLowerCase()).toContain('left join');

			// CRITICAL: JOIN should be target.fk = source.pk
			// posts.authorId = users.id

			// Target table (aliased as "posts" - relation name) should have authorId
			expect(compiled.sql).toMatch(/"posts"\."authorId"/);

			// Source table (users) should have id
			expect(compiled.sql).toMatch(/"users"\."id"/);
		});
	});
});

// ============================================================================
// Q7: M:N Through Table Support (CORE-002-B)
// ============================================================================

/**
 * Q7: Verify M:N relations via junction tables work correctly
 * - belongsToMany uses `through` table for two-JOIN pattern
 * - Filter generates: source → junction → target
 * - Include generates: LEFT JOIN source → junction → target
 * - EXISTS generates: EXISTS subquery with junction JOIN target
 */
describe('Q7: M:N Through Table Support (CORE-002-B)', () => {
	const kysely = createTestKysely();

	// Schema with M:N relation: posts belongsToMany tags through postTags
	const mnSchema = buildModelFromResolvedSchema(
		defineSchema(
			{
				posts: {
					id: { type: 'integer', primaryKey: true },
					title: { type: 'string' },
				},
				tags: {
					id: { type: 'integer', primaryKey: true },
					name: { type: 'string' },
				},
				postTags: {
					id: { type: 'integer', primaryKey: true },
					postId: { type: 'integer' },
					tagId: { type: 'integer' },
				},
			},
			{
				relations: {
					'posts.tags': { kind: 'manyToMany', target: 'tags', through: 'postTags', sourceFk: 'postId', targetFk: 'tagId' },
					'tags.posts': { kind: 'manyToMany', target: 'posts', through: 'postTags', sourceFk: 'tagId', targetFk: 'postId' },
				},
			},
		),
	);

	describe('M:N filter with JOIN strategy', () => {
		it('should generate two JOINs for belongsToMany filter (posts.tags)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				where: {
					kind: 'relationFilter',
					relation: 'tags',
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'name',
						operator: 'eq',
						value: 'typescript',
					},
				},
			};

			// Force JOIN strategy
			const schemaWithJoin = buildModelFromResolvedSchema(
				defineSchema(
					{
						posts: { id: { type: 'integer', primaryKey: true }, title: { type: 'string' } },
						tags: { id: { type: 'integer', primaryKey: true }, name: { type: 'string' } },
						postTags: {
							id: { type: 'integer', primaryKey: true },
							postId: { type: 'integer' },
							tagId: { type: 'integer' },
						},
					},
					{
						relations: {
							'posts.tags': { kind: 'manyToMany', target: 'tags', through: 'postTags', sourceFk: 'postId', targetFk: 'tagId' },
						},
						hints: {
							'posts.tags': { defaultStrategy: 'join' },
						},
					},
				),
			);

			const planReport = plan(intent, schemaWithJoin);
			const compiled = compile(planReport, schemaWithJoin, kysely);

			// Should have JOIN, not EXISTS
			expect(compiled.sql.toLowerCase()).toContain('join');

			// Should have two JOINs: postTags and tags
			expect(compiled.sql).toContain('postTags');
			expect(compiled.sql).toContain('tags');

			// Verify JOIN chain:
			// posts.id = postTags.postId (first JOIN)
			expect(compiled.sql).toMatch(/"posts"\."id"/);
			expect(compiled.sql).toMatch(/"postTags"\."postId"/);

			// postTags.tagId = tags.id (second JOIN)
			expect(compiled.sql).toMatch(/"postTags"\."tagId"/);
			expect(compiled.sql).toMatch(/"tags"\."id"/);
		});
	});

	describe('M:N filter with EXISTS strategy', () => {
		it('should generate EXISTS with junction JOIN for belongsToMany (posts.tags)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				where: {
					kind: 'relationFilter',
					relation: 'tags',
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'name',
						operator: 'eq',
						value: 'typescript',
					},
				},
			};

			const planReport = plan(intent, mnSchema);
			const compiled = compile(planReport, mnSchema, kysely);

			// belongsToMany defaults to EXISTS (cardinality: many)
			expect(compiled.sql.toLowerCase()).toContain('exists');

			// Should have postTags in the subquery
			expect(compiled.sql).toContain('postTags');

			// Should have inner JOIN to tags in the EXISTS subquery
			expect(compiled.sql.toLowerCase()).toContain('inner join');
			expect(compiled.sql).toContain('tags');

			// Verify correlation: postTags.postId = posts.id
			// Uses real table names as aliases: "postTags" for junction, "posts" for root
			expect(compiled.sql).toContain('"postId"');
			expect(compiled.sql).toMatch(/"posts"\."id"/);

			// Verify junction to target: postTags.tagId = tags.id
			expect(compiled.sql).toContain('"tagId"');
		});

		it('should correctly handle nested conditions on target table', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				where: {
					kind: 'relationFilter',
					relation: 'tags',
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'name',
						operator: 'eq',
						value: 'typescript',
					},
				},
			};

			const planReport = plan(intent, mnSchema);
			const compiled = compile(planReport, mnSchema, kysely);

			// The WHERE condition should be on the target table (tags), not junction
			// Alias assignment depends on state counter - just verify the pattern
			expect(compiled.sql).toContain('"name"');
			expect(compiled.parameters).toContain('typescript');
		});
	});

	describe('M:N include with JOIN strategy', () => {
		it('should generate two LEFT JOINs for belongsToMany include', () => {
			// Force JOIN strategy for include
			const schemaWithJoin = buildModelFromResolvedSchema(
				defineSchema(
					{
						posts: { id: { type: 'integer', primaryKey: true }, title: { type: 'string' } },
						tags: { id: { type: 'integer', primaryKey: true }, name: { type: 'string' } },
						postTags: {
							id: { type: 'integer', primaryKey: true },
							postId: { type: 'integer' },
							tagId: { type: 'integer' },
						},
					},
					{
						relations: {
							'posts.tags': { kind: 'manyToMany', target: 'tags', through: 'postTags', sourceFk: 'postId', targetFk: 'tagId', includeStrategy: 'join' },
						},
					},
				),
			);

			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				include: [{ relation: 'tags' }],
			};

			const planReport = plan(intent, schemaWithJoin);
			const compiled = compile(planReport, schemaWithJoin, kysely);

			// Should have LEFT JOINs
			expect(compiled.sql.toLowerCase()).toContain('left join');

			// Should have both junction and target tables
			expect(compiled.sql).toContain('postTags');
			expect(compiled.sql).toContain('tags');

			// Should have aliased columns for tags
			expect(compiled.sql).toContain('tags.id');
			expect(compiled.sql).toContain('tags.name');
		});
	});

	describe('M:N with custom FK names', () => {
		it('should use custom foreignKey and otherKey', () => {
			const customFkSchema = buildModelFromResolvedSchema(
				defineSchema(
					{
						users: { id: { type: 'integer', primaryKey: true }, name: { type: 'string' } },
						roles: { id: { type: 'integer', primaryKey: true }, roleName: { type: 'string' } },
						userRoles: {
							id: { type: 'integer', primaryKey: true },
							user_id: { type: 'integer' },
							role_id: { type: 'integer' },
						},
					},
					{
						relations: {
							'users.roles': { kind: 'manyToMany', target: 'roles', through: 'userRoles', sourceFk: 'user_id', targetFk: 'role_id' },
						},
					},
				),
			);

			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'relationFilter',
					relation: 'roles',
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'roleName',
						operator: 'eq',
						value: 'admin',
					},
				},
			};

			const planReport = plan(intent, customFkSchema);
			const compiled = compile(planReport, customFkSchema, kysely);

			// Should use custom FK names
			expect(compiled.sql).toContain('user_id');
			expect(compiled.sql).toContain('role_id');
		});
	});

	describe('M:N with schema prefix (multi-tenant)', () => {
		it('should prefix all tables including junction', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				where: {
					kind: 'relationFilter',
					relation: 'tags',
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'name',
						operator: 'eq',
						value: 'typescript',
					},
				},
			};

			const planReport = plan(intent, mnSchema);
			const compiled = compile(planReport, mnSchema, kysely, {
				schemaName: 'tenant_123',
			});

			// All tables should be prefixed
			expect(compiled.sql).toContain('tenant_123');
			expect(compiled.sql).toContain('"tenant_123"."posts"');
			expect(compiled.sql).toContain('"tenant_123"."postTags"');
			expect(compiled.sql).toContain('"tenant_123"."tags"');
		});
	});
});
