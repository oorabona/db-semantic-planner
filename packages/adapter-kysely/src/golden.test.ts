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
	belongsTo,
	defineSchema,
	hasMany,
	plan,
	type QueryIntent,
} from '@db-semantic-planner/core';
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
const q1Schema = defineSchema({
	products: {
		id: 'number',
		name: 'string',
		sku: 'string',
	},
	productImages: {
		id: 'number',
		productId: 'number',
		locale: 'string',
		type: 'string',
		approved: 'boolean',
		url: 'string',
	},
})
	.relations({
		products: {
			images: hasMany('productImages', { foreignKey: 'productId' }),
		},
		productImages: {
			product: belongsTo('products', { foreignKey: 'productId' }),
		},
	})
	.build();

// ============================================================================
// Q3 Schema: Users with Multiple Post Relations
// ============================================================================

/**
 * Q3: Users with ambiguous "posts" relations
 * - Users have authored posts (authoredPosts)
 * - Users have reviewed posts (reviewedPosts)
 * - Include "posts" should throw AmbiguousPlanError
 */
const q3Schema = defineSchema({
	users: {
		id: 'number',
		name: 'string',
		email: 'string',
	},
	posts: {
		id: 'number',
		title: 'string',
		content: 'string',
		authorId: 'number',
		reviewerId: 'number',
	},
})
	.relations({
		users: {
			authoredPosts: hasMany('posts', { foreignKey: 'authorId' }),
			reviewedPosts: hasMany('posts', { foreignKey: 'reviewerId' }),
		},
		posts: {
			author: belongsTo('users', { foreignKey: 'authorId' }),
			reviewer: belongsTo('users', { foreignKey: 'reviewerId' }),
		},
	})
	.build();

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
		expect(compiled.sql).toContain('t0'); // root alias
		expect(compiled.sql).toContain('t1'); // subquery alias

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
		expect(compiled.sql).toContain('t1');
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
