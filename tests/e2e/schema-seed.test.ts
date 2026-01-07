/**
 * Schema and Seed Tests
 *
 * Verifies that DDL and seed data work correctly.
 */

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createBlogSchema,
	createPimdamSchema,
	dropBlogSchema,
	dropPimdamSchema,
	getTestDb,
	seedAcmeTenant,
	seedBlogData,
	seedGlobexTenant,
	shouldSkipE2E,
} from './testkit/index.js';

describe.skipIf(shouldSkipE2E())('Schema and Seed', () => {
	beforeAll(async () => {
		// Clean up any existing schemas
		await dropPimdamSchema('acme');
		await dropPimdamSchema('globex');
		await dropBlogSchema('blog_test');
	});

	afterAll(async () => {
		await dropPimdamSchema('acme');
		await dropPimdamSchema('globex');
		await dropBlogSchema('blog_test');
		await closeTestDb();
	});

	describe('PIM/DAM Schema (Acme)', () => {
		beforeAll(async () => {
			await createPimdamSchema('acme');
			await seedAcmeTenant();
		});

		it('should have 2 categories', async () => {
			const db = await getTestDb();
			const result = await sql`SELECT COUNT(*) as count FROM acme.categories`.execute(db);
			expect(Number(result.rows[0].count)).toBe(2);
		});

		it('should have 4 products', async () => {
			const db = await getTestDb();
			const result = await sql`SELECT COUNT(*) as count FROM acme.products`.execute(db);
			expect(Number(result.rows[0].count)).toBe(4);
		});

		it('should have 6 assets', async () => {
			const db = await getTestDb();
			const result = await sql`SELECT COUNT(*) as count FROM acme.assets`.execute(db);
			expect(Number(result.rows[0].count)).toBe(6);
		});

		it('should have 5 product_images', async () => {
			const db = await getTestDb();
			const result = await sql`SELECT COUNT(*) as count FROM acme.product_images`.execute(db);
			expect(Number(result.rows[0].count)).toBe(5);
		});

		it('should have correct Q1 data (1 product with approved FR main image)', async () => {
			const db = await getTestDb();
			const result = await sql`
        SELECT p.sku
        FROM acme.products p
        WHERE EXISTS (
          SELECT 1 FROM acme.product_images pi
          WHERE pi.product_id = p.id
            AND pi.locale = 'FR'
            AND pi.is_main = true
            AND pi.status = 'approved'
        )
        ORDER BY p.id
      `.execute(db);

			expect(result.rows).toHaveLength(2); // PROD-001, PROD-002
			expect(result.rows[0]).toMatchObject({ sku: 'PROD-001' });
			expect(result.rows[1]).toMatchObject({ sku: 'PROD-002' });
		});

		it('should have correct Q2 data (1 product with both FR and EN approved)', async () => {
			const db = await getTestDb();
			const result = await sql`
        SELECT p.sku
        FROM acme.products p
        WHERE EXISTS (
          SELECT 1 FROM acme.product_images pi
          WHERE pi.product_id = p.id
            AND pi.locale = 'FR'
            AND pi.is_main = true
            AND pi.status = 'approved'
        )
        AND EXISTS (
          SELECT 1 FROM acme.product_images pi
          WHERE pi.product_id = p.id
            AND pi.locale = 'EN'
            AND pi.is_main = true
            AND pi.status = 'approved'
        )
        ORDER BY p.id
      `.execute(db);

			expect(result.rows).toHaveLength(1);
			expect(result.rows[0]).toMatchObject({ sku: 'PROD-001' });
		});
	});

	describe('PIM/DAM Schema (Globex)', () => {
		beforeAll(async () => {
			await createPimdamSchema('globex');
			await seedGlobexTenant();
		});

		it('should have 5 products', async () => {
			const db = await getTestDb();
			const result = await sql`SELECT COUNT(*) as count FROM globex.products`.execute(db);
			expect(Number(result.rows[0].count)).toBe(5);
		});

		it('should have different data than acme (3 products with approved FR)', async () => {
			const db = await getTestDb();
			const result = await sql`
        SELECT p.sku
        FROM globex.products p
        WHERE EXISTS (
          SELECT 1 FROM globex.product_images pi
          WHERE pi.product_id = p.id
            AND pi.locale = 'FR'
            AND pi.is_main = true
            AND pi.status = 'approved'
        )
        ORDER BY p.id
      `.execute(db);

			expect(result.rows).toHaveLength(3); // GLX-001, GLX-002, GLX-003
		});
	});

	describe('Blog Schema', () => {
		beforeAll(async () => {
			await createBlogSchema('blog_test');
			await seedBlogData('blog_test');
		});

		it('should have 2 authors', async () => {
			const db = await getTestDb();
			const result = await sql`SELECT COUNT(*) as count FROM blog_test.authors`.execute(db);
			expect(Number(result.rows[0].count)).toBe(2);
		});

		it('should have 5 posts', async () => {
			const db = await getTestDb();
			const result = await sql`SELECT COUNT(*) as count FROM blog_test.posts`.execute(db);
			expect(Number(result.rows[0].count)).toBe(5);
		});

		it('should have 3 published posts', async () => {
			const db = await getTestDb();
			const result = await sql`
        SELECT COUNT(*) as count FROM blog_test.posts WHERE published = true
      `.execute(db);
			expect(Number(result.rows[0].count)).toBe(3);
		});

		it('should have 10 comments', async () => {
			const db = await getTestDb();
			const result = await sql`SELECT COUNT(*) as count FROM blog_test.comments`.execute(db);
			expect(Number(result.rows[0].count)).toBe(10);
		});
	});
});
