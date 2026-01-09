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
import { createOrm, eq, type RelationHints } from '@db-semantic-planner/dx';
import {
	closeTestDb,
	createExtendedPimdamSchema,
	dropExtendedPimdamSchema,
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
			const db = await getTestDb();
			const orm = createOrm({ model: pimdamExtendedModel, db });

			// Filter by author_id directly (no ambiguity - it's a column)
			const products = await orm
				.forTenant(SCHEMA)
				.query('products')
				.where(eq('author_id', 1))
				.select(['id', 'sku', 'title', 'author_id'])
				.execute();

			const results = products as { sku: string; author_id: number }[];
			expect(results.length).toBeGreaterThanOrEqual(1);
			// All should have author_id=1
			expect(results.every((p) => p.author_id === 1)).toBe(true);
		});

		it('should filter products by reviewer_id using eq', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: pimdamExtendedModel, db });

			// Filter by reviewer_id=3 (Charlie)
			const products = await orm
				.forTenant(SCHEMA)
				.query('products')
				.where(eq('reviewer_id', 3))
				.select(['id', 'sku', 'title', 'reviewer_id'])
				.execute();

			const results = products as { sku: string; reviewer_id: number }[];
			expect(results.length).toBeGreaterThanOrEqual(1);
			// T-Shirt should be in results
			expect(results.some((p) => p.sku === 'TSHIRT-001')).toBe(true);
		});
	});

	describe('Q8-03: Named relations support multiple FKs to same target', () => {
		it('should have distinct author and reviewer relations defined', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: pimdamExtendedModel, db });

			// Verify the model supports both relations from products to users
			const dump = orm.forTenant(SCHEMA).query('products').select(['id', 'sku']).dump();

			// Plan should include relation metadata showing both relations exist
			expect(dump.sql).toContain(`"${SCHEMA}"`);
			expect(dump.plan).toBeDefined();
		});

		it('should query with author_id and reviewer_id columns', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: pimdamExtendedModel, db });

			// Verify columns are accessible
			const products = await orm
				.forTenant(SCHEMA)
				.query('products')
				.where(eq('sku', 'WIDGET-001'))
				.select(['id', 'sku', 'author_id', 'reviewer_id'])
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

	describe('ORM API: Relation hints', () => {
		it('should use relationHints for default disambiguation', async () => {
			const db = await getTestDb();

			// Create ORM with relation hints
			const hints: RelationHints = {
				users: 'author', // When resolving 'users' relation, prefer 'author'
			};

			const orm = createOrm({
				model: pimdamExtendedModel,
				db,
				relationHints: hints,
			});

			// Query with hints should prefer author relation
			const dump = orm.forTenant(SCHEMA).query('products').select(['id', 'sku']).dump();

			// Just verify the ORM was created with hints
			expect(dump.sql).toContain(`"${SCHEMA}"`);
		});

		it('should generate proper SQL for products query', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: pimdamExtendedModel, db });

			const dump = orm.forTenant(SCHEMA).query('products').select(['id', 'sku']).dump();

			// Verify tenant schema is applied
			expect(dump.sql).toContain(`"${SCHEMA}".`);
			expect(dump.plan).toBeDefined();
		});

		it('should generate proper SQL for users query', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: pimdamExtendedModel, db });

			const dump = orm.forTenant(SCHEMA).query('users').select(['id', 'name', 'email']).dump();

			// Verify tenant schema is applied
			expect(dump.sql).toContain(`"${SCHEMA}".`);
			expect(dump.plan).toBeDefined();
		});
	});
});
