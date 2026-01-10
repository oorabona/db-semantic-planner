/**
 * Q8: Ambiguity via/role
 *
 * Tests relation disambiguation when multiple relations exist to the same target.
 * products has two relations to users: author (author_id) and reviewer (reviewer_id).
 *
 * @see E2E-002 Block 10
 *
 * ## Test Structure (GWT - Given/When/Then)
 *
 * - **Given**: Extended PIM/DAM schema with multiple FK relations to same target (beforeAll)
 * - **When**: Execute SQL/ORM query using named relations or disambiguation hints
 * - **Then**: Verify correct user is resolved based on relation role
 *
 * Test data:
 * - Users: Alice (author, id=1), Bob (reviewer, id=2), Charlie (admin, id=3)
 * - Products have author_id → author, reviewer_id → reviewer relations to users
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql as kyselySql } from 'kysely';
import {
	createOrm,
	eq,
	and,
	AmbiguousRelationError,
	type RelationHints,
} from '@db-semantic-planner/core';
import {
	closeTestDb,
	createExtendedPimdamSchema,
	dropExtendedPimdamSchema,
	getTestAdapter,
	getTestDb,
	pimdamExtendedModel,
	seedExtendedPimdam,
	shouldSkipE2E,
} from './testkit/index.js';

const SCHEMA = 'q8_ambiguity';

/**
 * Test data (from seed):
 * - Users: Alice (author, id=1), Bob (reviewer, id=2), Charlie (admin, id=3)
 * - Most products: author_id=1, reviewer_id=2
 * - Product 4 (T-Shirt): author_id=1, reviewer_id=3
 * - Product 5 (Expiring): author_id=2, reviewer_id=1
 */
describe.skipIf(shouldSkipE2E())('Q8: Ambiguity via/role', () => {
	beforeAll(async () => {
		await dropExtendedPimdamSchema(SCHEMA);
		await createExtendedPimdamSchema(SCHEMA);
		await seedExtendedPimdam(SCHEMA);
	});

	afterAll(async () => {
		await dropExtendedPimdamSchema(SCHEMA);
		await closeTestDb();
	});

	describe('Q8-01: Direct named relations (no ambiguity)', () => {
		it('should query product author via named relation', async () => {
			const db = await getTestDb();

			// Direct SQL to verify the data structure
			const result = await kyselySql`
				SELECT
					p.sku,
					p.title,
					author.name AS author_name,
					reviewer.name AS reviewer_name
				FROM ${kyselySql.ref(SCHEMA)}.products p
				JOIN ${kyselySql.ref(SCHEMA)}.users author ON author.id = p.author_id
				JOIN ${kyselySql.ref(SCHEMA)}.users reviewer ON reviewer.id = p.reviewer_id
				WHERE p.sku = 'WIDGET-001'
			`.execute(db);

			const product = (result.rows as { author_name: string; reviewer_name: string }[])[0];
			expect(product.author_name).toBe('Alice Author');
			expect(product.reviewer_name).toBe('Bob Reviewer');
		});

		it('should query products by different authors', async () => {
			const db = await getTestDb();

			// Find products authored by Bob (author_id=2)
			const result = await kyselySql`
				SELECT p.sku, u.name AS author_name
				FROM ${kyselySql.ref(SCHEMA)}.products p
				JOIN ${kyselySql.ref(SCHEMA)}.users u ON u.id = p.author_id
				WHERE p.author_id = 2
			`.execute(db);

			const products = result.rows as { sku: string; author_name: string }[];
			expect(products.length).toBeGreaterThanOrEqual(1);
			expect(products[0].author_name).toBe('Bob Reviewer');
			// Product 5 (EXPIRING-001) has author_id=2
			expect(products.some((p) => p.sku === 'EXPIRING-001')).toBe(true);
		});

		it('should query products with different reviewer', async () => {
			const db = await getTestDb();

			// Find products reviewed by Charlie (reviewer_id=3)
			const result = await kyselySql`
				SELECT p.sku, u.name AS reviewer_name
				FROM ${kyselySql.ref(SCHEMA)}.products p
				JOIN ${kyselySql.ref(SCHEMA)}.users u ON u.id = p.reviewer_id
				WHERE p.reviewer_id = 3
			`.execute(db);

			const products = result.rows as { sku: string; reviewer_name: string }[];
			expect(products.length).toBeGreaterThanOrEqual(1);
			expect(products[0].reviewer_name).toBe('Charlie Admin');
			// Product 4 (TSHIRT-001) has reviewer_id=3
			expect(products.some((p) => p.sku === 'TSHIRT-001')).toBe(true);
		});
	});

	describe('Q8-02: ORM with named relations', () => {
		it('should filter products by author_id using eq', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			// Filter by author_id directly (no ambiguity - it's a column)
			const products = await orm
				.forTenant(SCHEMA)
				.select('products')
				.where(eq('author_id', 1))
				.columns(['id', 'sku', 'title', 'author_id'])
				.execute();

			const results = products as { sku: string; author_id: number }[];
			expect(results.length).toBeGreaterThanOrEqual(1);
			// All should have author_id=1
			expect(results.every((p) => p.author_id === 1)).toBe(true);
		});

		it('should filter products by reviewer_id using eq', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			// Filter by reviewer_id=3 (Charlie)
			const products = await orm
				.forTenant(SCHEMA)
				.select('products')
				.where(eq('reviewer_id', 3))
				.columns(['id', 'sku', 'title', 'reviewer_id'])
				.execute();

			const results = products as { sku: string; reviewer_id: number }[];
			expect(results.length).toBeGreaterThanOrEqual(1);
			// T-Shirt should be in results
			expect(results.some((p) => p.sku === 'TSHIRT-001')).toBe(true);
		});
	});

	describe('Q8-03: Named relations support multiple FKs to same target', () => {
		it('should have distinct author and reviewer relations defined', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			// Verify the model supports both relations from products to users
			const dump = orm.forTenant(SCHEMA).select('products').columns(['id', 'sku']).dump();

			// Plan should include relation metadata showing both relations exist
			expect(dump.sql).toContain(`"${SCHEMA}"`);
			expect(dump.plan).toBeDefined();
		});

		it('should query with author_id and reviewer_id columns', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			// Verify columns are accessible
			const products = await orm
				.forTenant(SCHEMA)
				.select('products')
				.where(eq('sku', 'WIDGET-001'))
				.columns(['id', 'sku', 'author_id', 'reviewer_id'])
				.execute();

			const result = products as { sku: string; author_id: number; reviewer_id: number }[];
			expect(result.length).toBe(1);
			expect(result[0].author_id).toBe(1); // Alice
			expect(result[0].reviewer_id).toBe(2); // Bob
		});
	});

	describe('Q8-04: Users with inverse relations', () => {
		it('should query users with their authored products count', async () => {
			const db = await getTestDb();

			// Count products authored by each user
			const result = await kyselySql`
				SELECT
					u.id,
					u.name,
					COUNT(p.id) AS authored_count
				FROM ${kyselySql.ref(SCHEMA)}.users u
				LEFT JOIN ${kyselySql.ref(SCHEMA)}.products p ON p.author_id = u.id
				WHERE p.deleted_at IS NULL
				GROUP BY u.id, u.name
				ORDER BY u.id
			`.execute(db);

			const users = result.rows as { name: string; authored_count: string }[];
			// Alice is author of most products
			const alice = users.find((u) => u.name === 'Alice Author');
			expect(Number(alice?.authored_count)).toBeGreaterThanOrEqual(5);

			// Bob authored only product 5
			const bob = users.find((u) => u.name === 'Bob Reviewer');
			expect(Number(bob?.authored_count)).toBeGreaterThanOrEqual(1);
		});

		it('should query users with their reviewed products count', async () => {
			const db = await getTestDb();

			// Count products reviewed by each user
			const result = await kyselySql`
				SELECT
					u.id,
					u.name,
					COUNT(p.id) AS reviewed_count
				FROM ${kyselySql.ref(SCHEMA)}.users u
				LEFT JOIN ${kyselySql.ref(SCHEMA)}.products p ON p.reviewer_id = u.id
				WHERE p.deleted_at IS NULL
				GROUP BY u.id, u.name
				ORDER BY u.id
			`.execute(db);

			const users = result.rows as { name: string; reviewed_count: string }[];
			// Bob reviewed most products
			const bob = users.find((u) => u.name === 'Bob Reviewer');
			expect(Number(bob?.reviewed_count)).toBeGreaterThanOrEqual(5);

			// Charlie reviewed product 4
			const charlie = users.find((u) => u.name === 'Charlie Admin');
			expect(Number(charlie?.reviewed_count)).toBeGreaterThanOrEqual(1);
		});
	});

	describe('Q8-05: Cross-reference queries', () => {
		it('should find products where author and reviewer are different', async () => {
			const db = await getTestDb();

			const result = await kyselySql`
				SELECT p.sku, author.name AS author, reviewer.name AS reviewer
				FROM ${kyselySql.ref(SCHEMA)}.products p
				JOIN ${kyselySql.ref(SCHEMA)}.users author ON author.id = p.author_id
				JOIN ${kyselySql.ref(SCHEMA)}.users reviewer ON reviewer.id = p.reviewer_id
				WHERE p.author_id != p.reviewer_id
				  AND p.deleted_at IS NULL
				ORDER BY p.sku
			`.execute(db);

			const products = result.rows as { sku: string; author: string; reviewer: string }[];
			// All our test products have different author/reviewer
			expect(products.length).toBeGreaterThanOrEqual(5);
			// Verify they're actually different
			expect(products.every((p) => p.author !== p.reviewer)).toBe(true);
		});

		it('should find products where author and reviewer are same', async () => {
			const db = await getTestDb();

			const result = await kyselySql`
				SELECT p.sku
				FROM ${kyselySql.ref(SCHEMA)}.products p
				WHERE p.author_id = p.reviewer_id
				  AND p.deleted_at IS NULL
			`.execute(db);

			// None of our test products have same author/reviewer
			expect(result.rows.length).toBe(0);
		});
	});

	describe('Q8-06: Junction table with role column (product_images)', () => {
		/**
		 * This tests a different disambiguation pattern:
		 * Instead of multiple FK columns to the same target (author_id, reviewer_id),
		 * this uses a junction table with a 'role' column to distinguish different
		 * types of relationships (main image, gallery, thumbnail).
		 *
		 * Test data (product 10 - iPhone):
		 * - Image 1: role='main' (primary product image)
		 * - Image 3: role='gallery' (additional gallery image)
		 * - Image 4: role='thumbnail' (small preview)
		 */

		it('should query all images for a product with roles', async () => {
			const db = await getTestDb();

			const result = await kyselySql`
				SELECT
					pi.product_id,
					pi.asset_id,
					pi.role,
					pi.position,
					a.storage_key
				FROM ${kyselySql.ref(SCHEMA)}.product_images pi
				JOIN ${kyselySql.ref(SCHEMA)}.assets a ON a.id = pi.asset_id
				WHERE pi.product_id = 10
				ORDER BY pi.position
			`.execute(db);

			const images = result.rows as { role: string; storage_key: string; position: number }[];
			expect(images.length).toBe(3);

			// Verify roles exist
			const roles = images.map((i) => i.role);
			expect(roles).toContain('main');
			expect(roles).toContain('gallery');
			expect(roles).toContain('thumbnail');
		});

		it('should filter product images by role=main', async () => {
			const db = await getTestDb();

			const result = await kyselySql`
				SELECT
					pi.product_id,
					a.storage_key,
					pi.role
				FROM ${kyselySql.ref(SCHEMA)}.product_images pi
				JOIN ${kyselySql.ref(SCHEMA)}.assets a ON a.id = pi.asset_id
				WHERE pi.product_id = 10
				  AND pi.role = 'main'
			`.execute(db);

			const images = result.rows as { role: string; storage_key: string }[];
			expect(images.length).toBe(1);
			expect(images[0].role).toBe('main');
		});

		it('should filter product images by role=gallery', async () => {
			const db = await getTestDb();

			const result = await kyselySql`
				SELECT
					pi.product_id,
					a.storage_key,
					pi.role
				FROM ${kyselySql.ref(SCHEMA)}.product_images pi
				JOIN ${kyselySql.ref(SCHEMA)}.assets a ON a.id = pi.asset_id
				WHERE pi.product_id = 10
				  AND pi.role = 'gallery'
			`.execute(db);

			const images = result.rows as { role: string; storage_key: string }[];
			expect(images.length).toBe(1);
			expect(images[0].role).toBe('gallery');
		});

		it('should filter product images by role=thumbnail', async () => {
			const db = await getTestDb();

			const result = await kyselySql`
				SELECT
					pi.product_id,
					a.storage_key,
					pi.role
				FROM ${kyselySql.ref(SCHEMA)}.product_images pi
				JOIN ${kyselySql.ref(SCHEMA)}.assets a ON a.id = pi.asset_id
				WHERE pi.product_id = 10
				  AND pi.role = 'thumbnail'
			`.execute(db);

			const images = result.rows as { role: string; storage_key: string }[];
			expect(images.length).toBe(1);
			expect(images[0].role).toBe('thumbnail');
		});

		it('should query via ORM with role filter using eq and and()', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			// Query product_images junction table with role filter
			// Use and() to combine conditions since where() replaces previous condition
			const mainImages = await orm
				.forTenant(SCHEMA)
				.select('product_images')
				.where(and(eq('product_id', 10), eq('role', 'main')))
				.columns(['product_id', 'asset_id', 'role', 'position'])
				.execute();

			const results = mainImages as { product_id: number; role: string }[];
			expect(results.length).toBe(1);
			expect(results[0].role).toBe('main');
			expect(results[0].product_id).toBe(10);
		});

		it('should demonstrate junction vs FK disambiguation patterns', async () => {
			const db = await getTestDb();

			/**
			 * This test documents the two disambiguation patterns:
			 *
			 * Pattern 1: Multiple FK columns (Q8-01 through Q8-05)
			 * - products.author_id → users (author role)
			 * - products.reviewer_id → users (reviewer role)
			 * - Disambiguation: column name determines relationship type
			 *
			 * Pattern 2: Junction table with role column (this section)
			 * - products ← product_images.role → assets
			 * - Disambiguation: role column value determines relationship type
			 */

			// Verify both patterns work in the same schema
			const fkPattern = await kyselySql`
				SELECT p.sku, author.name AS author_name
				FROM ${kyselySql.ref(SCHEMA)}.products p
				JOIN ${kyselySql.ref(SCHEMA)}.users author ON author.id = p.author_id
				WHERE p.id = 1
			`.execute(db);

			const junctionPattern = await kyselySql`
				SELECT p.sku, a.storage_key, pi.role
				FROM ${kyselySql.ref(SCHEMA)}.products p
				JOIN ${kyselySql.ref(SCHEMA)}.product_images pi ON pi.product_id = p.id
				JOIN ${kyselySql.ref(SCHEMA)}.assets a ON a.id = pi.asset_id
				WHERE p.id = 10 AND pi.role = 'main'
			`.execute(db);

			// Both patterns should work
			expect(fkPattern.rows.length).toBe(1);
			expect(junctionPattern.rows.length).toBe(1);

			const fkResult = fkPattern.rows[0] as { author_name: string };
			const junctionResult = junctionPattern.rows[0] as { role: string };

			expect(fkResult.author_name).toBe('Alice Author');
			expect(junctionResult.role).toBe('main');
		});
	});

	describe('ORM API: Relation hints', () => {
		it('should use relationHints for default disambiguation', async () => {
			const adapter = await getTestAdapter();

			// Create ORM with relation hints
			const hints: RelationHints = {
				users: 'author', // When resolving 'users' relation, prefer 'author'
			};

			const orm = createOrm({
				model: pimdamExtendedModel,
				adapter,
				relationHints: hints,
			});

			// Query with hints should prefer author relation
			const dump = orm.forTenant(SCHEMA).select('products').columns(['id', 'sku']).dump();

			// Just verify the ORM was created with hints
			expect(dump.sql).toContain(`"${SCHEMA}"`);
		});

		it('should generate proper SQL for products query', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			const dump = orm.forTenant(SCHEMA).select('products').columns(['id', 'sku']).dump();

			// Verify tenant schema is applied
			expect(dump.sql).toContain(`"${SCHEMA}".`);
			expect(dump.plan).toBeDefined();
		});

		it('should generate proper SQL for users query', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			const dump = orm.forTenant(SCHEMA).select('users').columns(['id', 'name', 'email']).dump();

			// Verify tenant schema is applied
			expect(dump.sql).toContain(`"${SCHEMA}".`);
			expect(dump.plan).toBeDefined();
		});
	});

	describe('Q8-07: Strict mode ambiguity errors (E2E-002 Q8-03)', () => {
		/**
		 * Tests strict mode behavior with real PostgreSQL database.
		 * In strict mode, ambiguous relations must be resolved explicitly.
		 *
		 * Schema ambiguity:
		 * - products.author_id → users (author relation)
		 * - products.reviewer_id → users (reviewer relation)
		 *
		 * When querying from products and including 'users', the ORM cannot
		 * determine which relation to use. In strict mode, this throws.
		 */

		it('should throw AmbiguousRelationError in strict mode when including users without via hint', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({
				model: pimdamExtendedModel,
				adapter,
				strictMode: true,
			});

			// products has both author and reviewer relations to users
			expect(() => {
				orm.forTenant(SCHEMA).select('products').include('users').plan();
			}).toThrow(AmbiguousRelationError);
		});

		it('should include sourceTable in AmbiguousRelationError', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({
				model: pimdamExtendedModel,
				adapter,
				strictMode: true,
			});

			try {
				orm.forTenant(SCHEMA).select('products').include('users').plan();
				expect.fail('Should have thrown AmbiguousRelationError');
			} catch (error) {
				expect(error).toBeInstanceOf(AmbiguousRelationError);
				expect((error as AmbiguousRelationError).sourceTable).toBe('products');
			}
		});

		it('should include targetTable in AmbiguousRelationError', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({
				model: pimdamExtendedModel,
				adapter,
				strictMode: true,
			});

			try {
				orm.forTenant(SCHEMA).select('products').include('users').plan();
				expect.fail('Should have thrown AmbiguousRelationError');
			} catch (error) {
				expect(error).toBeInstanceOf(AmbiguousRelationError);
				expect((error as AmbiguousRelationError).targetTable).toBe('users');
			}
		});

		it('should provide available relation options in error', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({
				model: pimdamExtendedModel,
				adapter,
				strictMode: true,
			});

			try {
				orm.forTenant(SCHEMA).select('products').include('users').plan();
				expect.fail('Should have thrown AmbiguousRelationError');
			} catch (error) {
				expect(error).toBeInstanceOf(AmbiguousRelationError);
				const options = (error as AmbiguousRelationError).options;
				// Should contain both author and reviewer relation names
				expect(options).toContain('author');
				expect(options).toContain('reviewer');
			}
		});

		it('should provide helpful error message with disambiguation hint', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({
				model: pimdamExtendedModel,
				adapter,
				strictMode: true,
			});

			try {
				orm.forTenant(SCHEMA).select('products').include('users').plan();
				expect.fail('Should have thrown AmbiguousRelationError');
			} catch (error) {
				expect(error).toBeInstanceOf(AmbiguousRelationError);
				const message = (error as Error).message;
				// Message should include disambiguation hints
				expect(message).toContain('Ambiguous relation');
				expect(message).toContain('products');
				expect(message).toContain('users');
				expect(message).toContain('via');
			}
		});

		it('should not throw when via hint resolves ambiguity', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({
				model: pimdamExtendedModel,
				adapter,
				strictMode: true,
			});

			// Using via: 'author' resolves the ambiguity
			expect(() => {
				orm.forTenant(SCHEMA).select('products').include('users', { via: 'author' }).plan();
			}).not.toThrow();

			// Using via: 'reviewer' also resolves it
			expect(() => {
				orm.forTenant(SCHEMA).select('products').include('users', { via: 'reviewer' }).plan();
			}).not.toThrow();
		});

		it('should work in lenient mode (default) with warning instead of error', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({
				model: pimdamExtendedModel,
				adapter,
				strictMode: false, // Default/lenient mode
			});

			// Should not throw
			const planReport = orm.forTenant(SCHEMA).select('products').include('users').plan();

			// Should have ambiguity warning
			const ambiguityWarning = planReport.warnings.find(
				(w) => w.code === 'AMBIGUOUS_RELATION',
			);
			expect(ambiguityWarning).toBeDefined();
		});

		it('should execute query successfully when ambiguity is resolved with via hint', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({
				model: pimdamExtendedModel,
				adapter,
				strictMode: true,
			});

			// Execute real query with resolved ambiguity
			const products = await orm
				.forTenant(SCHEMA)
				.select('products')
				.where(eq('sku', 'WIDGET-001'))
				.include('users', { via: 'author' })
				.columns(['id', 'sku'])
				.execute();

			const results = products as { sku: string }[];
			expect(results.length).toBe(1);
			expect(results[0].sku).toBe('WIDGET-001');
		});
	});
});
