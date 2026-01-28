/**
 * Q1: Products with Approved FR Main Image (EXISTS)
 *
 * Tests the EXISTS filter strategy using the DX public API.
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
	'Q1: Products with approved FR main image',
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

		describe('dump() analysis', () => {
			it('should use EXISTS strategy in plan', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: pimdamModel, adapter });

				const dump = orm
					.withSchema('acme')
					.select('products')
					.where(
						exists('productImages', {
							where: and(
								eq('locale', 'FR'),
								eq('isMain', true),
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
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: pimdamModel, adapter });

				const dump = orm
					.withSchema('acme')
					.select('products')
					.where(
						exists('productImages', {
							where: and(
								eq('locale', 'FR'),
								eq('isMain', true),
								eq('status', 'approved'),
							),
						}),
					)
					.dump();

				expect(dump.sql.toUpperCase()).toContain('WHERE EXISTS');
				expect(dump.sql).toContain('"acme"');
			});

			it('should have correct parameters', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: pimdamModel, adapter });

				const dump = orm
					.withSchema('acme')
					.select('products')
					.where(
						exists('productImages', {
							where: and(
								eq('locale', 'FR'),
								eq('isMain', true),
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
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: pimdamModel, adapter });

				const dump = orm
					.withSchema('acme')
					.select('products')
					.where(
						exists('productImages', {
							where: and(
								eq('locale', 'FR'),
								eq('isMain', true),
								eq('status', 'approved'),
							),
						}),
					)
					.dump();

				expect(dump.meta?.schema).toBe('acme');
				expect(dump.meta?.compiledAt).toBeInstanceOf(Date);
			});
		});

		describe('execute() results', () => {
			it('should return only products with approved FR main image (Acme)', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: pimdamModel, adapter });

				const products = await orm
					.withSchema('acme')
					.select('products')
					.where(
						exists('productImages', {
							where: and(
								eq('locale', 'FR'),
								eq('isMain', true),
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
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: pimdamModel, adapter });

				const products = await orm
					.withSchema('globex')
					.select('products')
					.where(
						exists('productImages', {
							where: and(
								eq('locale', 'FR'),
								eq('isMain', true),
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
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: pimdamModel, adapter });

				const query = orm
					.withSchema('acme')
					.select('products')
					.where(
						exists('productImages', {
							where: and(
								eq('locale', 'FR'),
								eq('isMain', true),
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

		// ============================================================================
		// Filter Strategy Contract Tests (CORE-001)
		// ============================================================================

		describe('Filter strategy contract (CORE-001)', () => {
			describe('belongsTo → JOIN strategy (default)', () => {
				it('should use JOIN strategy for belongsTo filter (products.category)', async () => {
					const adapter = await getTestAdapter();
					const orm = createOrm({ model: pimdamModel, adapter });

					const dump = orm
						.withSchema('acme')
						.select('products')
						.where(
							exists('category', {
								where: eq('name', 'Electronics'),
							}),
						)
						.dump();

					// Verify JOIN strategy is chosen for belongsTo
					const filterDecision = dump.plan.decisions.find(
						(d) => d.type === 'filter-strategy',
					);
					expect(filterDecision).toBeDefined();
					expect(filterDecision?.choice).toBe('join');

					// Verify SQL uses JOIN not EXISTS
					expect(dump.sql.toLowerCase()).toContain('join');
					expect(dump.sql.toLowerCase()).not.toContain('exists');
				});

				it('should return correct results with JOIN filter on category', async () => {
					const adapter = await getTestAdapter();
					const orm = createOrm({ model: pimdamModel, adapter });

					const products = await orm
						.withSchema('acme')
						.select('products')
						.where(
							exists('category', {
								where: eq('name', 'Electronics'),
							}),
						)
						.columns(['id', 'sku'])
						.execute();

					// Should return products in Electronics category
					expect(products.length).toBeGreaterThanOrEqual(1);
				});
			});

			describe('hasMany → EXISTS strategy (default)', () => {
				it('should use EXISTS strategy for hasMany filter (products.images)', async () => {
					const adapter = await getTestAdapter();
					const orm = createOrm({ model: pimdamModel, adapter });

					const dump = orm
						.withSchema('acme')
						.select('products')
						.where(exists('productImages'))
						.dump();

					// Verify EXISTS strategy is chosen for hasMany
					const filterDecision = dump.plan.decisions.find(
						(d) => d.type === 'filter-strategy',
					);
					expect(filterDecision).toBeDefined();
					expect(filterDecision?.choice).toBe('exists');

					// Verify SQL uses EXISTS
					expect(dump.sql.toLowerCase()).toContain('exists');
				});
			});
		});
	},
);
