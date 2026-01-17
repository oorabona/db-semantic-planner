/**
 * Q6: Category Tree (Materialized Path)
 *
 * Tests hierarchical category queries using materialized path pattern.
 * Categories have a `path` column like /1/2/3/ for hierarchy traversal.
 *
 * @see E2E-002 Block 8
 *
 * ## Test Structure (GWT - Given/When/Then)
 *
 * - **Given**: Extended PIM/DAM schema with categories using materialized paths (beforeAll)
 * - **When**: Execute SQL/ORM query using LIKE on path column
 * - **Then**: Verify correct subtree traversal and hierarchy counts
 *
 * Category hierarchy:
 * - Electronics (/1/) → Phones (/1/2/) → Smartphones (/1/2/3/), Audio (/1/4/)
 * - Clothing (/5/) → T-Shirts (/5/6/)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql as kyselySql } from 'kysely';
import { createOrm, like } from '@dbsp/core';
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

const SCHEMA = 'q6_category_tree';

/**
 * Category hierarchy in test data:
 *
 * Electronics (/1/)
 *   ├── Phones (/1/2/)
 *   │   └── Smartphones (/1/2/3/)
 *   └── Audio (/1/4/)
 * Clothing (/5/)
 *   └── T-Shirts (/5/6/)
 */
describe.skipIf(shouldSkipE2E())('Q6: Category Tree (Materialized Path)', () => {
	beforeAll(async () => {
		await dropExtendedPimdamSchema(SCHEMA);
		await createExtendedPimdamSchema(SCHEMA);
		await seedExtendedPimdam(SCHEMA);
	});

	afterAll(async () => {
		await dropExtendedPimdamSchema(SCHEMA);
		await closeTestDb();
	});

	describe('Q6-01: Find all products in category subtree', () => {
		it('should find products in Electronics and all descendants', async () => {
			const db = await getTestDb();

			// Products in Electronics (/1/) and all children
			const result = await kyselySql`
				SELECT p.sku, p.title, c.name AS category_name, c.path
				FROM ${kyselySql.ref(SCHEMA)}.products p
				JOIN ${kyselySql.ref(SCHEMA)}.categories c ON c.id = p.category_id
				WHERE c.path LIKE '/1/%'
				ORDER BY p.sku
			`.execute(db);

			const products = result.rows as { sku: string; category_name: string }[];
			// Products in Smartphones (category 3, path /1/2/3/): Widget, Gadget, Gizmo, iPhone-15
			expect(products.length).toBeGreaterThanOrEqual(4);
			expect(products.some((p) => p.sku === 'WIDGET-001')).toBe(true);
			expect(products.some((p) => p.sku === 'IPHONE-15')).toBe(true);
		});

		it('should find products only in Clothing subtree', async () => {
			const db = await getTestDb();

			const result = await kyselySql`
				SELECT p.sku, c.name AS category_name
				FROM ${kyselySql.ref(SCHEMA)}.products p
				JOIN ${kyselySql.ref(SCHEMA)}.categories c ON c.id = p.category_id
				WHERE c.path LIKE '/5/%'
			`.execute(db);

			const products = result.rows as { sku: string }[];
			// Only T-Shirt is in Clothing/T-Shirts (/5/6/)
			expect(products.some((p) => p.sku === 'TSHIRT-001')).toBe(true);
			expect(products.some((p) => p.sku === 'WIDGET-001')).toBe(false);
		});
	});

	describe('Q6-02: Get category breadcrumb', () => {
		it('should get ancestors for Smartphones category', async () => {
			const db = await getTestDb();

			// Smartphones has path /1/2/3/
			// Breadcrumb should be: Electronics -> Phones -> Smartphones
			const result = await kyselySql`
				SELECT id, name, path
				FROM ${kyselySql.ref(SCHEMA)}.categories
				WHERE '/1/2/3/' LIKE path || '%'
				ORDER BY path
			`.execute(db);

			const breadcrumb = result.rows as { name: string; path: string }[];
			expect(breadcrumb).toHaveLength(3);
			expect(breadcrumb[0].name).toBe('Electronics');
			expect(breadcrumb[1].name).toBe('Phones');
			expect(breadcrumb[2].name).toBe('Smartphones');
		});

		it('should get ancestors for T-Shirts category', async () => {
			const db = await getTestDb();

			// T-Shirts has path /5/6/
			const result = await kyselySql`
				SELECT name, path
				FROM ${kyselySql.ref(SCHEMA)}.categories
				WHERE '/5/6/' LIKE path || '%'
				ORDER BY path
			`.execute(db);

			const breadcrumb = result.rows as { name: string }[];
			expect(breadcrumb).toHaveLength(2);
			expect(breadcrumb[0].name).toBe('Clothing');
			expect(breadcrumb[1].name).toBe('T-Shirts');
		});
	});

	describe('Q6-03: Count products per category with descendants', () => {
		it('should count products including descendants', async () => {
			const db = await getTestDb();

			// Count products in each category including all descendants
			const result = await kyselySql`
				SELECT
					c.id,
					c.name,
					c.path,
					(
						SELECT COUNT(*)
						FROM ${kyselySql.ref(SCHEMA)}.products p
						JOIN ${kyselySql.ref(SCHEMA)}.categories pc ON pc.id = p.category_id
						WHERE pc.path LIKE c.path || '%'
						  AND p.deleted_at IS NULL
					) AS product_count
				FROM ${kyselySql.ref(SCHEMA)}.categories c
				ORDER BY c.path
			`.execute(db);

			const counts = result.rows as {
				name: string;
				path: string;
				product_count: string;
			}[];

			// Electronics (/1/) should have all products in its subtree
			const electronics = counts.find((c) => c.name === 'Electronics');
			expect(Number(electronics?.product_count)).toBeGreaterThanOrEqual(4);

			// Smartphones (/1/2/3/) has direct products
			const smartphones = counts.find((c) => c.name === 'Smartphones');
			expect(Number(smartphones?.product_count)).toBeGreaterThanOrEqual(4);

			// Clothing (/5/) has products in T-Shirts
			const clothing = counts.find((c) => c.name === 'Clothing');
			expect(Number(clothing?.product_count)).toBeGreaterThanOrEqual(1);
		});

		it('should correctly count leaf categories', async () => {
			const db = await getTestDb();

			// Audio (/1/4/) is a leaf with no products
			const result = await kyselySql`
				SELECT
					c.name,
					COUNT(p.id) AS direct_count
				FROM ${kyselySql.ref(SCHEMA)}.categories c
				LEFT JOIN ${kyselySql.ref(SCHEMA)}.products p ON p.category_id = c.id AND p.deleted_at IS NULL
				WHERE c.name = 'Audio'
				GROUP BY c.id, c.name
			`.execute(db);

			const audio = (result.rows as { name: string; direct_count: string }[])[0];
			expect(Number(audio?.direct_count)).toBe(0);
		});
	});

	describe('ORM API: Category queries with LIKE', () => {
		it('should use LIKE for path matching', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			// Find categories in Electronics subtree
			const dump = orm
				.withSchema(SCHEMA)
				.select('categories')
				.where(like('path', '/1/%'))
				.columns(['id', 'name', 'path'])
				.dump();

			expect(dump.sql.toLowerCase()).toContain('like');
			expect(dump.params).toContain('/1/%');
		});

		it('should execute category subtree query', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			const categories = await orm
				.withSchema(SCHEMA)
				.select('categories')
				.where(like('path', '/1/%'))
				.columns(['id', 'name', 'path'])
				.execute();

			// /1/, /1/2/, /1/2/3/, /1/4/ = 4 categories
			expect((categories as unknown[]).length).toBe(4);
		});
	});

	describe('Recursive CTE alternative (for complex hierarchies)', () => {
		it('should traverse category hierarchy with recursive CTE', async () => {
			const db = await getTestDb();

			// Alternative approach using recursive CTE (useful for adjacency list without path)
			const result = await kyselySql`
				WITH RECURSIVE category_tree AS (
					-- Base case: start from Electronics
					SELECT id, name, parent_id, 0 AS depth
					FROM ${kyselySql.ref(SCHEMA)}.categories
					WHERE name = 'Electronics'

					UNION ALL

					-- Recursive case: children
					SELECT c.id, c.name, c.parent_id, ct.depth + 1
					FROM ${kyselySql.ref(SCHEMA)}.categories c
					JOIN category_tree ct ON c.parent_id = ct.id
				)
				SELECT * FROM category_tree
				ORDER BY depth, name
			`.execute(db);

			const tree = result.rows as { name: string; depth: number }[];
			expect(tree.length).toBe(4); // Electronics + Phones + Smartphones + Audio

			const root = tree.find((c) => c.depth === 0);
			expect(root?.name).toBe('Electronics');

			const level1 = tree.filter((c) => c.depth === 1);
			expect(level1.map((c) => c.name).sort()).toEqual(['Audio', 'Phones']);
		});
	});
});
