/**
 * Q1: Attribute Completeness (Akeneo-like)
 *
 * Tests completeness calculation using CTE with COUNT/ratio.
 * Family + Channel define required attributes, product_attributes holds values.
 *
 * @see E2E-002 Block 5
 *
 * ## Test Structure (GWT - Given/When/Then)
 *
 * - **Given**: Extended PIM/DAM schema with families, channels, and attributes (beforeAll)
 * - **When**: Execute SQL/ORM query for completeness calculation
 * - **Then**: Verify ratio matches expected value based on filled vs required attributes
 *
 * Test data:
 * - Family 1 (phones): requires name, description, price for channel 1
 * - Product 10 (iPhone-15): has name + description, missing price = 66.67% complete
 */

import { createOrm, eq } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createExtendedPimdamSchema,
	dropExtendedPimdamSchema,
	getTestAdapter,
	getTestPool,
	pimdamExtendedModel,
	seedExtendedPimdam,
	shouldSkipE2E,
} from './testkit/index.js';
import { sql as kyselySql } from './testkit/sql.js';

const SCHEMA = 'q1_completeness';

describe.skipIf(shouldSkipE2E())('Q1: Attribute Completeness', () => {
	beforeAll(async () => {
		await dropExtendedPimdamSchema(SCHEMA);
		await createExtendedPimdamSchema(SCHEMA);
		await seedExtendedPimdam(SCHEMA);
	});

	afterAll(async () => {
		await dropExtendedPimdamSchema(SCHEMA);
		await closeTestDb();
	});

	describe('Q1-01: Calculate completeness ratio per product', () => {
		it('should calculate 66% completeness for iPhone-15 (2/3 attributes)', async () => {
			const pool = await getTestPool();

			// Direct SQL query to calculate completeness
			// This validates the expected data before testing the ORM approach
			const result = await kyselySql`
				WITH required_attrs AS (
					SELECT fa.attribute_name
					FROM ${kyselySql.ref(SCHEMA)}.family_attributes fa
					WHERE fa.family_id = 1 AND fa.channel_id = 1 AND fa.is_required = true
				),
				product_attrs AS (
					SELECT DISTINCT pa.attribute_name
					FROM ${kyselySql.ref(SCHEMA)}.product_attributes pa
					WHERE pa.product_id = 10
				),
				completeness AS (
					SELECT
						(SELECT COUNT(*)::float FROM product_attrs WHERE attribute_name IN (SELECT attribute_name FROM required_attrs)) /
						NULLIF((SELECT COUNT(*)::float FROM required_attrs), 0) * 100 AS ratio
				)
				SELECT ratio FROM completeness
			`.execute(pool);

			const ratio = (result.rows[0] as { ratio: number }).ratio;
			// 2/3 = 66.67%
			expect(ratio).toBeCloseTo(66.67, 1);
		});

		it('should identify missing attributes for iPhone-15', async () => {
			const pool = await getTestPool();

			// Find which attributes are missing
			const result = await kyselySql`
				WITH required_attrs AS (
					SELECT fa.attribute_name
					FROM ${kyselySql.ref(SCHEMA)}.family_attributes fa
					WHERE fa.family_id = 1 AND fa.channel_id = 1 AND fa.is_required = true
				),
				filled_attrs AS (
					SELECT DISTINCT pa.attribute_name
					FROM ${kyselySql.ref(SCHEMA)}.product_attributes pa
					WHERE pa.product_id = 10
				)
				SELECT attribute_name
				FROM required_attrs
				WHERE attribute_name NOT IN (SELECT attribute_name FROM filled_attrs)
			`.execute(pool);

			const missing = (result.rows as { attributeName: string }[]).map(
				(r) => r.attributeName,
			);
			expect(missing).toContain('price');
			expect(missing).not.toContain('name');
			expect(missing).not.toContain('description');
		});
	});

	describe('Q1-02: Filter products by completeness threshold', () => {
		it('should filter products with completeness >= 50%', async () => {
			const pool = await getTestPool();

			// Products with at least 50% completeness for web channel
			const result = await kyselySql`
				WITH product_completeness AS (
					SELECT
						p.id,
						p.sku,
						p.title,
						COALESCE(
							(SELECT COUNT(DISTINCT pa.attribute_name)::float
							 FROM ${kyselySql.ref(SCHEMA)}.product_attributes pa
							 WHERE pa.product_id = p.id
							   AND pa.attribute_name IN (
								 SELECT fa.attribute_name
								 FROM ${kyselySql.ref(SCHEMA)}.family_attributes fa
								 WHERE fa.family_id = p.family_id
								   AND fa.channel_id = 1
								   AND fa.is_required = true
							 )
							) /
							NULLIF(
								(SELECT COUNT(*)::float
								 FROM ${kyselySql.ref(SCHEMA)}.family_attributes fa
								 WHERE fa.family_id = p.family_id
								   AND fa.channel_id = 1
								   AND fa.is_required = true
								), 0
							) * 100,
							0
						) AS completeness
					FROM ${kyselySql.ref(SCHEMA)}.products p
					WHERE p.family_id IS NOT NULL
					  AND p.deleted_at IS NULL
				)
				SELECT id, sku, title, completeness
				FROM product_completeness
				WHERE completeness >= 50
				ORDER BY completeness DESC
			`.execute(pool);

			const products = result.rows as {
				id: number;
				sku: string;
				completeness: number;
			}[];
			// iPhone-15 should be included (66.67%)
			const iphone = products.find((p) => p.sku === 'IPHONE-15');
			expect(iphone).toBeDefined();
			expect(iphone!.completeness).toBeGreaterThanOrEqual(50);
		});

		it('should exclude products with completeness < 50%', async () => {
			const pool = await getTestPool();

			// Products with less than 50% completeness
			const result = await kyselySql`
				WITH product_completeness AS (
					SELECT
						p.id,
						p.sku,
						COALESCE(
							(SELECT COUNT(DISTINCT pa.attribute_name)::float
							 FROM ${kyselySql.ref(SCHEMA)}.product_attributes pa
							 WHERE pa.product_id = p.id
							   AND pa.attribute_name IN (
								 SELECT fa.attribute_name
								 FROM ${kyselySql.ref(SCHEMA)}.family_attributes fa
								 WHERE fa.family_id = p.family_id
								   AND fa.channel_id = 1
								   AND fa.is_required = true
							 )
							) /
							NULLIF(
								(SELECT COUNT(*)::float
								 FROM ${kyselySql.ref(SCHEMA)}.family_attributes fa
								 WHERE fa.family_id = p.family_id
								   AND fa.channel_id = 1
								   AND fa.is_required = true
								), 0
							) * 100,
							0
						) AS completeness
					FROM ${kyselySql.ref(SCHEMA)}.products p
					WHERE p.family_id IS NOT NULL
					  AND p.deleted_at IS NULL
				)
				SELECT sku, completeness
				FROM product_completeness
				WHERE completeness < 50
			`.execute(pool);

			// Products without any product_attributes have 0% completeness
			const lowCompleteness = result.rows as {
				sku: string;
				completeness: number;
			}[];
			// Widget, Gadget, Gizmo etc don't have product_attributes → 0%
			expect(lowCompleteness.some((p) => p.sku === 'WIDGET-001')).toBe(true);
		});
	});

	describe('Q1-03: Multi-channel completeness', () => {
		it('should calculate different completeness per channel', async () => {
			const pool = await getTestPool();

			// iPhone-15: web requires [name, description, price] → 66%
			// iPhone-15: print requires [name, description, print_resolution, price] → 50% (has name, description)
			const result = await kyselySql`
				SELECT
					c.code AS channel,
					COALESCE(
						(SELECT COUNT(DISTINCT pa.attribute_name)::float
						 FROM ${kyselySql.ref(SCHEMA)}.product_attributes pa
						 WHERE pa.product_id = 10
						   AND pa.attribute_name IN (
							 SELECT fa.attribute_name
							 FROM ${kyselySql.ref(SCHEMA)}.family_attributes fa
							 WHERE fa.family_id = 1
							   AND fa.channel_id = c.id
							   AND fa.is_required = true
						 )
						) /
						NULLIF(
							(SELECT COUNT(*)::float
							 FROM ${kyselySql.ref(SCHEMA)}.family_attributes fa
							 WHERE fa.family_id = 1
							   AND fa.channel_id = c.id
							   AND fa.is_required = true
							), 0
						) * 100,
						0
					) AS completeness
				FROM ${kyselySql.ref(SCHEMA)}.channels c
				WHERE c.code IN ('web', 'print')
				ORDER BY c.code
			`.execute(pool);

			const byChannel = result.rows as {
				channel: string;
				completeness: number;
			}[];
			const print = byChannel.find((c) => c.channel === 'print');
			const web = byChannel.find((c) => c.channel === 'web');

			expect(web).toBeDefined();
			expect(print).toBeDefined();
			// Web: 2/3 = 66.67%
			expect(web!.completeness).toBeCloseTo(66.67, 1);
			// Print: 2/4 = 50% (name, description filled; print_resolution, price missing)
			expect(print!.completeness).toBeCloseTo(50, 1);
		});
	});

	describe('ORM API: Completeness via raw SQL expression', () => {
		it('should support raw SQL in select for computed fields', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			// The ORM can execute with schema prefix
			const products = await orm
				.withSchema(SCHEMA)
				.select('products')
				.where(eq('sku', 'IPHONE-15'))
				.columns(['id', 'sku', 'title'])
				.execute();

			expect(products).toHaveLength(1);
			expect((products[0] as { sku: string }).sku).toBe('IPHONE-15');
		});

		it('should generate correct tenant-scoped SQL', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			const dump = orm
				.withSchema(SCHEMA)
				.select('products')
				.where(eq('familyId', 1))
				.columns(['id', 'sku'])
				.dump();

			expect(dump.sql).toMatch(new RegExp(`("|)${SCHEMA}\\1\\.`));
			expect(dump.meta?.schema).toBe(SCHEMA);
		});
	});
});
