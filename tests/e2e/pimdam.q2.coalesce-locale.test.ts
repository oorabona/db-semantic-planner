/**
 * Q2: Working Context with Locale Fallback (COALESCE)
 *
 * Tests the COALESCE expression API for locale-aware field selection.
 *
 * @see E2E-002 Block 6
 *
 * ## Test Structure (GWT - Given/When/Then)
 *
 * - **Given**: Extended PIM/DAM schema with products having locale-specific names (beforeAll)
 * - **When**: Execute ORM query with coalesce() expression
 * - **Then**: Verify correct fallback behavior based on NULL values
 *
 * Scenarios:
 * - Q2-01: Product name with FR->EN fallback (EN used when FR is NULL)
 * - Q2-02: Product name with FR primary (FR used when available)
 * - Q2-03: Multi-level fallback chain (FR->EN->default)
 * - Q2-04: Filter by coalesced value
 *
 * Test data:
 * - WIDGET-001: name_fr=NULL, name_en="Widget Pro" → expects "Widget Pro"
 * - GADGET-001: name_fr="Super Bidule", name_en="Super Gadget" → expects "Super Bidule"
 * - GIZMO-001: name_fr=NULL, name_en=NULL, name_default="Default Gizmo" → expects "Default Gizmo"
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coalesce, createOrm, eq, like } from '@db-semantic-planner/dx';
import {
	closeTestDb,
	createExtendedPimdamSchema,
	dropExtendedPimdamSchema,
	getTestDb,
	pimdamExtendedModel,
	seedExtendedPimdam,
	shouldSkipE2E,
} from './testkit/index.js';

describe.skipIf(shouldSkipE2E())(
	'Q2: Locale Fallback with COALESCE',
	() => {
		const TENANT = 'e2e_coalesce';

		beforeAll(async () => {
			await dropExtendedPimdamSchema(TENANT);
			await createExtendedPimdamSchema(TENANT);
			await seedExtendedPimdam(TENANT);
		});

		afterAll(async () => {
			await dropExtendedPimdamSchema(TENANT);
			await closeTestDb();
		});

		// =====================================================================
		// Scenario Q2-01: Product name with FR->EN fallback
		// =====================================================================
		describe('Scenario Q2-01: FR->EN fallback', () => {
			it('Given product "widget" with name_en "Widget Pro" and name_fr NULL', async () => {
				const db = await getTestDb();
				const orm = createOrm({ model: pimdamExtendedModel, db });

				// Query widget directly to verify seed data
				const widget = await orm
					.forTenant(TENANT)
					.query('products')
					.where(eq('sku', 'WIDGET-001'))
					.select(['sku', 'name_fr', 'name_en'])
					.findFirst();

				expect(widget).toBeDefined();
				expect(widget?.name_fr).toBeNull();
				expect(widget?.name_en).toBe('Widget Pro');
			});

			it('When I query with coalesce(name_fr, name_en) as display_name', async () => {
				const db = await getTestDb();
				const orm = createOrm({ model: pimdamExtendedModel, db });

				const result = await orm
					.forTenant(TENANT)
					.query('products')
					.where(eq('sku', 'WIDGET-001'))
					.selectWithExpressions(
						['sku'],
						[coalesce(['name_fr', 'name_en'], 'display_name')],
					)
					.findFirst();

				// Then display_name should be "Widget Pro" (English fallback)
				expect(result).toBeDefined();
				expect(result?.display_name).toBe('Widget Pro');
			});
		});

		// =====================================================================
		// Scenario Q2-02: Product name with FR primary
		// =====================================================================
		describe('Scenario Q2-02: FR primary', () => {
			it('Given product "gadget" with name_en "Super Gadget" and name_fr "Super Bidule"', async () => {
				const db = await getTestDb();
				const orm = createOrm({ model: pimdamExtendedModel, db });

				const gadget = await orm
					.forTenant(TENANT)
					.query('products')
					.where(eq('sku', 'GADGET-001'))
					.select(['sku', 'name_fr', 'name_en'])
					.findFirst();

				expect(gadget).toBeDefined();
				expect(gadget?.name_fr).toBe('Super Bidule');
				expect(gadget?.name_en).toBe('Super Gadget');
			});

			it('When I query with coalesce(name_fr, name_en) as display_name', async () => {
				const db = await getTestDb();
				const orm = createOrm({ model: pimdamExtendedModel, db });

				const result = await orm
					.forTenant(TENANT)
					.query('products')
					.where(eq('sku', 'GADGET-001'))
					.selectWithExpressions(
						['sku'],
						[coalesce(['name_fr', 'name_en'], 'display_name')],
					)
					.findFirst();

				// Then display_name should be "Super Bidule" (French primary)
				expect(result).toBeDefined();
				expect(result?.display_name).toBe('Super Bidule');
			});
		});

		// =====================================================================
		// Scenario Q2-03: Multi-level fallback chain
		// =====================================================================
		describe('Scenario Q2-03: Multi-level fallback chain', () => {
			it('Given product with name_fr NULL, name_en NULL, name_default "Default Gizmo"', async () => {
				const db = await getTestDb();
				const orm = createOrm({ model: pimdamExtendedModel, db });

				const gizmo = await orm
					.forTenant(TENANT)
					.query('products')
					.where(eq('sku', 'GIZMO-001'))
					.select(['sku', 'name_fr', 'name_en', 'name_default'])
					.findFirst();

				expect(gizmo).toBeDefined();
				expect(gizmo?.name_fr).toBeNull();
				expect(gizmo?.name_en).toBeNull();
				expect(gizmo?.name_default).toBe('Default Gizmo');
			});

			it('When I query with coalesce(name_fr, name_en, name_default) as display_name', async () => {
				const db = await getTestDb();
				const orm = createOrm({ model: pimdamExtendedModel, db });

				const result = await orm
					.forTenant(TENANT)
					.query('products')
					.where(eq('sku', 'GIZMO-001'))
					.selectWithExpressions(
						['sku'],
						[coalesce(['name_fr', 'name_en', 'name_default'], 'display_name')],
					)
					.findFirst();

				// Then display_name should be "Default Gizmo"
				expect(result).toBeDefined();
				expect(result?.display_name).toBe('Default Gizmo');
			});
		});

		// =====================================================================
		// Scenario Q2-04: Filter by coalesced value
		// =====================================================================
		describe('Scenario Q2-04: Filter by coalesced value', () => {
			it('should find products matching in either FR or EN name via LIKE', async () => {
				const db = await getTestDb();
				const orm = createOrm({ model: pimdamExtendedModel, db });

				// Find products where coalesced name contains "Bidule"
				// This should match GADGET-001 (name_fr = "Super Bidule")
				const products = await orm
					.forTenant(TENANT)
					.query('products')
					.selectWithExpressions(
						['sku'],
						[coalesce(['name_fr', 'name_en'], 'display_name')],
					)
					.findMany();

				// Filter in application code (SQL LIKE on COALESCE would require raw)
				const matching = products.filter(
					(p) =>
						typeof p.display_name === 'string' &&
						p.display_name.includes('Bidule'),
				);

				expect(matching).toHaveLength(1);
				expect(matching[0]?.sku).toBe('GADGET-001');
			});

			it('should return all products with coalesced display names', async () => {
				const db = await getTestDb();
				const orm = createOrm({ model: pimdamExtendedModel, db });

				const products = await orm
					.forTenant(TENANT)
					.query('products')
					.where(eq('active', true))
					.selectWithExpressions(
						['sku'],
						[coalesce(['name_fr', 'name_en', 'name_default'], 'display_name')],
					)
					.findMany();

				// Should have multiple products with display names
				expect(products.length).toBeGreaterThan(0);

				// Each product should have a display_name (not null due to COALESCE)
				for (const p of products) {
					expect(p.display_name).toBeDefined();
					expect(typeof p.display_name).toBe('string');
				}
			});
		});

		// =====================================================================
		// SQL Generation Tests (dump() analysis)
		// =====================================================================
		describe('SQL generation for COALESCE', () => {
			it('should generate COALESCE in SQL', async () => {
				const db = await getTestDb();
				const orm = createOrm({ model: pimdamExtendedModel, db });

				const dump = orm
					.forTenant(TENANT)
					.query('products')
					.selectWithExpressions(
						['sku'],
						[coalesce(['name_fr', 'name_en'], 'display_name')],
					)
					.dump();

				expect(dump.sql.toUpperCase()).toContain('COALESCE');
				expect(dump.sql).toContain('display_name');
			});

			it('should generate correct parameter binding', async () => {
				const db = await getTestDb();
				const orm = createOrm({ model: pimdamExtendedModel, db });

				const dump = orm
					.forTenant(TENANT)
					.query('products')
					.where(eq('sku', 'WIDGET-001'))
					.selectWithExpressions(
						['sku'],
						[coalesce(['name_fr', 'name_en'], 'display_name')],
					)
					.dump();

				// Should have parameter for sku filter
				expect(dump.params).toContain('WIDGET-001');
			});
		});
	},
);
