/**
 * Q2: Products with approved images in BOTH FR and EN (CTE Extraction)
 *
 * Tests CTE extraction when the same relation is accessed multiple times.
 */

import { and, createOrm, eq, exists } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createPimdamSchema,
	dropPimdamSchema,
	getTestAdapter,
	pimdamModel,
	seedAcmeTenant,
	seedGlobexTenant,
	shouldSkipE2E,
} from './testkit/index.js';

describe.skipIf(shouldSkipE2E())(
	'Q2: Products with approved FR AND EN images (CTE)',
	() => {
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

		/**
		 * Build the Q2 query: products with approved FR main image AND approved EN main image
		 */
		const buildQ2Query = (orm: ReturnType<typeof createOrm>, tenant: string) =>
			orm
				.withSchema(tenant)
				.select('products')
				.where(
					and(
						exists('images', {
							where: and(
								eq('locale', 'FR'),
								eq('is_main', true),
								eq('status', 'approved'),
							),
						}),
						exists('images', {
							where: and(
								eq('locale', 'EN'),
								eq('is_main', true),
								eq('status', 'approved'),
							),
						}),
					),
				)
				.columns(['id', 'sku']);

		describe('dump() analysis - CTE extraction', () => {
			it('should trigger CTE extraction (images relation accessed twice)', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: pimdamModel, adapter });

				const dump = buildQ2Query(orm, 'acme').dump();

				// CTE extraction should be triggered
				expect(dump.plan.ctes).toBeDefined();
				expect(dump.plan.ctes.length).toBeGreaterThanOrEqual(1);
			});

			it('should name CTE based on relation', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: pimdamModel, adapter });

				const dump = buildQ2Query(orm, 'acme').dump();

				// CTE should be named cte_product_images or similar
				const cteNames = dump.plan.ctes.map((c) => c.name);
				expect(
					cteNames.some(
						(name) =>
							name.includes('images') || name.includes('product_images'),
					),
				).toBe(true);
			});

			it('should generate SQL with WITH clause', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: pimdamModel, adapter });

				const dump = buildQ2Query(orm, 'acme').dump();

				// SQL should contain WITH clause
				expect(dump.sql.toUpperCase()).toContain('WITH');
			});

			it('should have two EXISTS clauses in SQL', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: pimdamModel, adapter });

				const dump = buildQ2Query(orm, 'acme').dump();

				// Count EXISTS occurrences
				const existsCount = (dump.sql.toUpperCase().match(/EXISTS/g) || [])
					.length;
				expect(existsCount).toBeGreaterThanOrEqual(2);
			});

			it('should have cte-extraction decision in plan', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: pimdamModel, adapter });

				const dump = buildQ2Query(orm, 'acme').dump();

				// Should have a decision about CTE extraction
				expect(dump.plan.decisions).toContainEqual(
					expect.objectContaining({
						type: 'cte-extraction',
					}),
				);
			});
		});

		describe('execute() results', () => {
			it('should return only products with BOTH FR and EN approved main images (Acme)', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: pimdamModel, adapter });

				const products = await buildQ2Query(orm, 'acme').execute();

				// Acme: Only PROD-001 has both FR and EN approved main images
				expect(products).toHaveLength(1);
				expect(products[0]).toMatchObject({ sku: 'PROD-001' });
			});

			it('should return different results per tenant (Globex)', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: pimdamModel, adapter });

				const products = await buildQ2Query(orm, 'globex').execute();

				// Globex: Only GLX-001 has both FR and EN approved main images
				expect(products).toHaveLength(1);
				expect(products[0]).toMatchObject({ sku: 'GLX-001' });
			});

			it('should return deterministic results with multiple executions', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: pimdamModel, adapter });

				const query = buildQ2Query(orm, 'acme');

				const result1 = await query.execute();
				const result2 = await query.execute();

				expect(result1).toEqual(result2);
			});
		});
	},
);
