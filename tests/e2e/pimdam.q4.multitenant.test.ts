/**
 * Q4: Multi-tenant Isolation Test
 *
 * Verifies that withSchema() properly scopes queries to the correct schema
 * and that there is no data leakage between tenants.
 */

import { createOrm, eq } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createPimdamSchema,
	dropPimdamSchema,
	getTestAdapter,
	pimdamModel,
	seedAcmeTenant,
	seedGlobexTenant,
	
} from './testkit/index.js';

describe('Q4: Multi-tenant Isolation', () => {
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

	describe('Schema isolation', () => {
		it('should only return Acme products when querying Acme tenant', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const products = await orm
				.withSchema('acme')
				.select('products')
				.columns(['id', 'sku'])
				.execute();

			// Acme has 4 products: PROD-001, PROD-002, PROD-003, PROD-004
			expect(products).toHaveLength(4);
			const skus = products.map((p: { sku: string }) => p.sku);
			expect(skus.every((sku) => sku.startsWith('PROD-'))).toBe(true);
			expect(skus).not.toContain('GLX-001');
		});

		it('should only return Globex products when querying Globex tenant', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const products = await orm
				.withSchema('globex')
				.select('products')
				.columns(['id', 'sku'])
				.execute();

			// Globex has 5 products: GLX-001 through GLX-005
			expect(products).toHaveLength(5);
			const skus = products.map((p: { sku: string }) => p.sku);
			expect(skus.every((sku) => sku.startsWith('GLX-'))).toBe(true);
			expect(skus).not.toContain('PROD-001');
		});

		it('should generate SQL with correct schema prefix', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const acmeDump = orm
				.withSchema('acme')
				.select('products')
				.columns(['id', 'sku'])
				.dump();

			const globexDump = orm
				.withSchema('globex')
				.select('products')
				.columns(['id', 'sku'])
				.dump();

			// SQL should contain the correct schema
			expect(acmeDump.sql).toContain('acme');
			expect(acmeDump.sql).not.toContain('globex');

			expect(globexDump.sql).toContain('globex');
			expect(globexDump.sql).not.toContain('acme');
		});

		it('should include tenant in dump meta', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const acmeDump = orm.withSchema('acme').select('products').dump();
			const globexDump = orm.withSchema('globex').select('products').dump();

			expect(acmeDump.meta?.schema).toBe('acme');
			expect(globexDump.meta?.schema).toBe('globex');
		});
	});

	describe('Filtered queries per tenant', () => {
		it('should filter by SKU within correct tenant', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const acmeProduct = await orm
				.withSchema('acme')
				.select('products')
				.where(eq('sku', 'PROD-001'))
				.columns(['id', 'sku', 'title'])
				.execute();

			expect(acmeProduct).toHaveLength(1);
			expect(acmeProduct[0]).toMatchObject({ sku: 'PROD-001' });
		});

		it('should return empty when querying non-existent SKU in tenant', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			// GLX-001 exists in Globex but not in Acme
			const result = await orm
				.withSchema('acme')
				.select('products')
				.where(eq('sku', 'GLX-001'))
				.columns(['id', 'sku'])
				.execute();

			expect(result).toHaveLength(0);
		});

		it('should return different category counts per tenant', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const acmeCategories = await orm
				.withSchema('acme')
				.select('categories')
				.columns(['id', 'name'])
				.execute();

			const globexCategories = await orm
				.withSchema('globex')
				.select('categories')
				.columns(['id', 'name'])
				.execute();

			// Acme has 2 categories, Globex has 3
			expect(acmeCategories).toHaveLength(2);
			expect(globexCategories).toHaveLength(3);
		});
	});

	describe('Same query, different results', () => {
		it('should execute identical query structure with tenant-specific results', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			// Build identical query for both tenants
			const buildQuery = (tenant: string) =>
				orm
					.withSchema(tenant)
					.select('products')
					.where(eq('active', true))
					.columns(['id', 'sku']);

			const acmeActive = await buildQuery('acme').execute();
			const globexActive = await buildQuery('globex').execute();

			// Verify results are different
			const acmeSkus = acmeActive.map((p: { sku: string }) => p.sku);
			const globexSkus = globexActive.map((p: { sku: string }) => p.sku);

			// No overlap between tenant SKUs
			const intersection = acmeSkus.filter((sku) => globexSkus.includes(sku));
			expect(intersection).toHaveLength(0);
		});

		it('should generate SQL with same structure but different schema', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const buildQuery = (tenant: string) =>
				orm
					.withSchema(tenant)
					.select('products')
					.where(eq('active', true))
					.columns(['id', 'sku']);

			const acmeDump = buildQuery('acme').dump();
			const globexDump = buildQuery('globex').dump();

			// SQL structure should be identical except for schema name
			const normalizedAcme = acmeDump.sql.replace(/\bacme\b/g, 'SCHEMA');
			const normalizedGlobex = globexDump.sql.replace(/\bglobex\b/g, 'SCHEMA');

			expect(normalizedAcme).toBe(normalizedGlobex);
		});
	});
});
