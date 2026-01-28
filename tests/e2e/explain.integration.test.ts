/**
 * EXPLAIN Integration Tests
 *
 * Validates that generated SQL can be analyzed by PostgreSQL's EXPLAIN
 * and produces valid execution plans.
 *
 * Note: PostgreSQL EXPLAIN doesn't support parameterized queries directly,
 * so we only test non-parameterized queries or verify SQL structure.
 */

import { createOrm } from '@dbsp/core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createPimdamSchema,
	dropPimdamSchema,
	getTestAdapter,
	getTestDb,
	pimdamModel,
	seedAcmeTenant,
	shouldSkipE2E,
} from './testkit/index.js';

describe.skipIf(shouldSkipE2E())('EXPLAIN Integration', () => {
	beforeAll(async () => {
		await dropPimdamSchema('acme');
		await createPimdamSchema('acme');
		await seedAcmeTenant();
	});

	afterAll(async () => {
		await dropPimdamSchema('acme');
		await closeTestDb();
	});

	/**
	 * Helper to run EXPLAIN on a SQL string (no parameters)
	 */
	const runExplain = async (sqlStr: string): Promise<string> => {
		const db = await getTestDb();
		const explainSql = `EXPLAIN (FORMAT JSON) ${sqlStr}`;

		const result = await sql
			.raw<{ 'QUERY PLAN': object[] }>(explainSql)
			.execute(db);

		return JSON.stringify(result.rows[0]['QUERY PLAN'], null, 2);
	};

	describe('Basic queries (no parameters)', () => {
		it('should produce valid EXPLAIN output for simple select', async () => {
			const _db = await getTestDb();
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const dump = orm
				.withSchema('acme')
				.select('products')
				.columns(['id', 'sku'])
				.dump();

			// This query has no parameters
			expect(dump.params).toHaveLength(0);

			const explainOutput = await runExplain(dump.sql);

			// EXPLAIN should return valid JSON with query plan
			expect(explainOutput).toBeDefined();
			expect(explainOutput.length).toBeGreaterThan(0);

			const plan = JSON.parse(explainOutput);
			expect(plan).toBeInstanceOf(Array);
			expect(plan[0]).toHaveProperty('Plan');
		});

		it('should produce valid EXPLAIN for categories query', async () => {
			const _db = await getTestDb();
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const dump = orm
				.withSchema('acme')
				.select('categories')
				.columns(['id', 'name'])
				.dump();

			expect(dump.params).toHaveLength(0);

			const explainOutput = await runExplain(dump.sql);
			const plan = JSON.parse(explainOutput);
			expect(plan[0]).toHaveProperty('Plan');
		});

		it('should produce valid EXPLAIN for assets query', async () => {
			const _db = await getTestDb();
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const dump = orm
				.withSchema('acme')
				.select('assets')
				.columns(['id', 'kind', 'mime'])
				.dump();

			expect(dump.params).toHaveLength(0);

			const explainOutput = await runExplain(dump.sql);
			const plan = JSON.parse(explainOutput);
			expect(plan[0]).toHaveProperty('Plan');
		});
	});

	describe('SQL structure validation', () => {
		it('should generate SELECT with correct schema prefix', async () => {
			const _db = await getTestDb();
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const dump = orm
				.withSchema('acme')
				.select('products')
				.columns(['id', 'sku', 'title'])
				.dump();

			// Verify schema prefix in SQL
			expect(dump.sql).toContain('"acme"');
			expect(dump.sql.toLowerCase()).toContain('select');
			expect(dump.sql.toLowerCase()).toContain('from');
		});

		it('should generate valid SQL for all entity types', async () => {
			const _db = await getTestDb();
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const entities = [
				'products',
				'categories',
				'assets',
				'productImages',
				'variants',
			] as const;

			for (const entity of entities) {
				const dump = orm
					.withSchema('acme')
					.select(entity)
					.columns(['id'])
					.dump();

				expect(dump.sql).toContain('"acme"');
				expect(dump.sql.toLowerCase()).toContain('select');
			}
		});

		it('should include parameters array even when empty', async () => {
			const _db = await getTestDb();
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const dump = orm
				.withSchema('acme')
				.select('products')
				.columns(['id'])
				.dump();

			expect(dump.params).toBeInstanceOf(Array);
		});
	});

	describe('Plan characteristics', () => {
		it('should use Seq Scan on small tables', async () => {
			const _db = await getTestDb();
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const dump = orm
				.withSchema('acme')
				.select('products')
				.columns(['id', 'sku'])
				.dump();

			const explainOutput = await runExplain(dump.sql);

			// Small tables typically use Seq Scan
			expect(explainOutput).toContain('Seq Scan');
		});

		it('should estimate reasonable row counts', async () => {
			const _db = await getTestDb();
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const dump = orm
				.withSchema('acme')
				.select('products')
				.columns(['id', 'sku'])
				.dump();

			const explainOutput = await runExplain(dump.sql);
			const plan = JSON.parse(explainOutput);

			// Plan should have row estimates
			expect(plan[0].Plan).toHaveProperty('Plan Rows');
			expect(plan[0].Plan['Plan Rows']).toBeGreaterThan(0);
		});

		it('should show correct relation name in plan', async () => {
			const _db = await getTestDb();
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const dump = orm
				.withSchema('acme')
				.select('products')
				.columns(['id'])
				.dump();

			const explainOutput = await runExplain(dump.sql);

			// Plan should reference the products table
			expect(explainOutput).toContain('products');
		});
	});

	describe('Dump metadata', () => {
		it('should include tenant in meta', async () => {
			const _db = await getTestDb();
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const dump = orm.withSchema('acme').select('products').dump();

			expect(dump.meta?.schema).toBe('acme');
		});

		it('should include compiledAt timestamp', async () => {
			const _db = await getTestDb();
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const dump = orm.withSchema('acme').select('products').dump();

			expect(dump.meta?.compiledAt).toBeInstanceOf(Date);
		});

		it('should have plan with decisions', async () => {
			const _db = await getTestDb();
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const dump = orm.withSchema('acme').select('products').dump();

			expect(dump.plan).toBeDefined();
			expect(dump.plan.decisions).toBeInstanceOf(Array);
		});
	});
});
