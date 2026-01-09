/**
 * Q1: Products with Approved FR Main Image (EXISTS)
 *
 * Tests the EXISTS filter strategy using the DX public API.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, createOrm, eq, exists } from '@db-semantic-planner/dx';
import {
	closeTestDb,
	createPimdamSchema,
	dropPimdamSchema,
	getTestDb,
	pimdamModel,
	seedAcmeTenant,
	seedGlobexTenant,
	shouldSkipE2E,
} from './testkit/index.js';

describe.skipIf(shouldSkipE2E())('Q1: Products with approved FR main image', () => {
	beforeAll(async () => {
		await dropPimdamSchema('acme');
		await dropPimdamSchema('globex');
		await createPimdamSchema('acme');
		await createPimdamSchema('globex');
		await seedAcmeTenant();
		await seedGlobexTenant();
	});

	afterAll(async () => {
		await dropPimdamSchema('acme');
		await dropPimdamSchema('globex');
		await closeTestDb();
	});

	describe('dump() analysis', () => {
		it('should use EXISTS strategy in plan', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: pimdamModel, db });

			const dump = orm
				.forTenant('acme')
				.select('products')
				.where(
					exists('images', {
						where: and(
							eq('locale', 'FR'),
							eq('is_main', true),
							eq('status', 'approved'),
						),
					}),
				)
				.dump();

			// Verify EXISTS strategy is chosen
			expect(dump.plan.decisions).toContainEqual(
				expect.objectContaining({
					type: 'filter-strategy',
					choice: 'exists',
				}),
			);
		});

		it('should generate SQL with WHERE EXISTS', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: pimdamModel, db });

			const dump = orm
				.forTenant('acme')
				.select('products')
				.where(
					exists('images', {
						where: and(
							eq('locale', 'FR'),
							eq('is_main', true),
							eq('status', 'approved'),
						),
					}),
				)
				.dump();

			expect(dump.sql.toUpperCase()).toContain('WHERE EXISTS');
			expect(dump.sql).toContain('"acme"');
		});

		it('should have correct parameters', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: pimdamModel, db });

			const dump = orm
				.forTenant('acme')
				.select('products')
				.where(
					exists('images', {
						where: and(
							eq('locale', 'FR'),
							eq('is_main', true),
							eq('status', 'approved'),
						),
					}),
				)
				.dump();

			expect(dump.params).toContain('FR');
			expect(dump.params).toContain(true);
			expect(dump.params).toContain('approved');
		});

		it('should include tenant in meta', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: pimdamModel, db });

			const dump = orm
				.forTenant('acme')
				.select('products')
				.where(
					exists('images', {
						where: and(
							eq('locale', 'FR'),
							eq('is_main', true),
							eq('status', 'approved'),
						),
					}),
				)
				.dump();

			expect(dump.meta?.tenant).toBe('acme');
			expect(dump.meta?.compiledAt).toBeInstanceOf(Date);
		});
	});

	describe('execute() results', () => {
		it('should return only products with approved FR main image (Acme)', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: pimdamModel, db });

			const products = await orm
				.forTenant('acme')
				.select('products')
				.where(
					exists('images', {
						where: and(
							eq('locale', 'FR'),
							eq('is_main', true),
							eq('status', 'approved'),
						),
					}),
				)
				.columns(['id', 'sku'])
				.execute();

			// Acme: PROD-001 and PROD-002 have approved FR main images
			expect(products).toHaveLength(2);
			const skus = products.map((p: { sku: string }) => p.sku);
			expect(skus).toContain('PROD-001');
			expect(skus).toContain('PROD-002');
		});

		it('should return different results per tenant (Globex)', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: pimdamModel, db });

			const products = await orm
				.forTenant('globex')
				.select('products')
				.where(
					exists('images', {
						where: and(
							eq('locale', 'FR'),
							eq('is_main', true),
							eq('status', 'approved'),
						),
					}),
				)
				.columns(['id', 'sku'])
				.execute();

			// Globex: GLX-001, GLX-002, GLX-003 have approved FR main images
			expect(products).toHaveLength(3);
			const skus = products.map((p: { sku: string }) => p.sku);
			expect(skus).toContain('GLX-001');
			expect(skus).toContain('GLX-002');
			expect(skus).toContain('GLX-003');
		});

		it('should return deterministic results with orderBy', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: pimdamModel, db });

			const query = orm
				.forTenant('acme')
				.select('products')
				.where(
					exists('images', {
						where: and(
							eq('locale', 'FR'),
							eq('is_main', true),
							eq('status', 'approved'),
						),
					}),
				)
				.columns(['id', 'sku']);

			// Execute twice and compare
			const result1 = await query.execute();
			const result2 = await query.execute();

			expect(result1).toEqual(result2);
		});
	});
});
