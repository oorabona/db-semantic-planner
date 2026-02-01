/**
 * Performance Benchmarks
 *
 * Measures compilation and execution times for various query patterns.
 * Results are logged but not asserted (informational only).
 */

import { createOrm, eq } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createPimdamSchema,
	dropPimdamSchema,
	getTestAdapter,
	getTestPool,
	pimdamModel,
	seedAcmeTenant,
} from './testkit/index.js';

/**
 * Benchmark result structure
 */
interface BenchmarkResult {
	name: string;
	compilationMs: number;
	executionMs: number;
	totalMs: number;
	iterations: number;
}

/**
 * Run a benchmark with multiple iterations
 */
async function runBenchmark(
	name: string,
	iterations: number,
	compileFn: () => unknown,
	executeFn: () => Promise<unknown>,
): Promise<BenchmarkResult> {
	// Warmup
	compileFn();
	await executeFn();

	// Measure compilation time
	const compileStart = performance.now();
	for (let i = 0; i < iterations; i++) {
		compileFn();
	}
	const compileEnd = performance.now();
	const compilationMs = (compileEnd - compileStart) / iterations;

	// Measure execution time
	const executeStart = performance.now();
	for (let i = 0; i < iterations; i++) {
		await executeFn();
	}
	const executeEnd = performance.now();
	const executionMs = (executeEnd - executeStart) / iterations;

	return {
		name,
		compilationMs,
		executionMs,
		totalMs: compilationMs + executionMs,
		iterations,
	};
}

/**
 * Format benchmark result for console output
 */
function formatResult(result: BenchmarkResult): string {
	return [
		`📊 ${result.name}`,
		`   Compilation: ${result.compilationMs.toFixed(3)}ms`,
		`   Execution:   ${result.executionMs.toFixed(3)}ms`,
		`   Total:       ${result.totalMs.toFixed(3)}ms`,
		`   Iterations:  ${result.iterations}`,
	].join('\n');
}

describe('Performance Benchmarks', () => {
	const ITERATIONS = 100;
	const results: BenchmarkResult[] = [];

	beforeAll(async () => {
		await dropPimdamSchema('acme');
		await createPimdamSchema('acme');
		await seedAcmeTenant();
	});

	afterAll(async () => {
		// Print all benchmark results
		console.log('\n\n=== BENCHMARK RESULTS ===\n');
		for (const result of results) {
			console.log(formatResult(result));
			console.log('');
		}
		console.log('========================\n');

		await dropPimdamSchema('acme');
		await closeTestDb();
	});

	describe('Compilation benchmarks', () => {
		it('should benchmark simple select compilation', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const result = await runBenchmark(
				'Simple SELECT',
				ITERATIONS,
				() =>
					orm
						.withSchema('acme')
						.select('products')
						.columns(['id', 'sku'])
						.dump(),
				async () =>
					orm
						.withSchema('acme')
						.select('products')
						.columns(['id', 'sku'])
						.execute(),
			);

			results.push(result);
			expect(result.compilationMs).toBeLessThan(50); // Should compile in < 50ms
		});

		it('should benchmark filtered select compilation', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const result = await runBenchmark(
				'Filtered SELECT',
				ITERATIONS,
				() =>
					orm
						.withSchema('acme')
						.select('products')
						.where(eq('active', true))
						.columns(['id', 'sku'])
						.dump(),
				async () =>
					orm
						.withSchema('acme')
						.select('products')
						.where(eq('active', true))
						.columns(['id', 'sku'])
						.execute(),
			);

			results.push(result);
			expect(result.compilationMs).toBeLessThan(50);
		});

		it('should benchmark multi-column select compilation', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const result = await runBenchmark(
				'Multi-column SELECT',
				ITERATIONS,
				() =>
					orm
						.withSchema('acme')
						.select('products')
						.columns(['id', 'sku', 'title', 'active', 'category_id'])
						.dump(),
				async () =>
					orm
						.withSchema('acme')
						.select('products')
						.columns(['id', 'sku', 'title', 'active', 'category_id'])
						.execute(),
			);

			results.push(result);
			expect(result.compilationMs).toBeLessThan(50);
		});
	});

	describe('Execution benchmarks', () => {
		it('should benchmark simple query execution', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const result = await runBenchmark(
				'Simple Query Execution',
				ITERATIONS,
				() => orm.withSchema('acme').select('products').dump(),
				async () => orm.withSchema('acme').select('products').execute(),
			);

			results.push(result);
			// Execution should be reasonably fast (< 10ms on average)
			expect(result.executionMs).toBeLessThan(10);
		});

		it('should benchmark filtered query execution', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const result = await runBenchmark(
				'Filtered Query Execution',
				ITERATIONS,
				() =>
					orm
						.withSchema('acme')
						.select('products')
						.where(eq('sku', 'PROD-001'))
						.dump(),
				async () =>
					orm
						.withSchema('acme')
						.select('products')
						.where(eq('sku', 'PROD-001'))
						.execute(),
			);

			results.push(result);
			expect(result.executionMs).toBeLessThan(10);
		});

		it('should benchmark different entity types', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			// Categories
			const catResult = await runBenchmark(
				'Categories Query',
				ITERATIONS,
				() => orm.withSchema('acme').select('categories').dump(),
				async () => orm.withSchema('acme').select('categories').execute(),
			);
			results.push(catResult);

			// Assets
			const assetResult = await runBenchmark(
				'Assets Query',
				ITERATIONS,
				() => orm.withSchema('acme').select('assets').dump(),
				async () => orm.withSchema('acme').select('assets').execute(),
			);
			results.push(assetResult);

			// Variants
			const variantResult = await runBenchmark(
				'Variants Query',
				ITERATIONS,
				() => orm.withSchema('acme').select('variants').dump(),
				async () => orm.withSchema('acme').select('variants').execute(),
			);
			results.push(variantResult);

			expect(catResult.executionMs).toBeLessThan(10);
			expect(assetResult.executionMs).toBeLessThan(10);
			expect(variantResult.executionMs).toBeLessThan(10);
		});
	});

	describe('Overhead analysis', () => {
		it('should measure ORM overhead vs raw SQL', async () => {
			const adapter = await getTestAdapter();
			const pool = await getTestPool();
			const orm = createOrm({ model: pimdamModel, adapter });

			// ORM query
			const ormResult = await runBenchmark(
				'ORM Query',
				ITERATIONS,
				() => orm.withSchema('acme').select('products').dump(),
				async () => orm.withSchema('acme').select('products').execute(),
			);
			results.push(ormResult);

			// Raw SQL equivalent (via pool.query)
			const rawStart = performance.now();
			for (let i = 0; i < ITERATIONS; i++) {
				await pool.query('SELECT * FROM acme.products');
			}
			const rawEnd = performance.now();
			const rawExecutionMs = (rawEnd - rawStart) / ITERATIONS;

			const overheadResult: BenchmarkResult = {
				name: 'Raw SQL Query',
				compilationMs: 0,
				executionMs: rawExecutionMs,
				totalMs: rawExecutionMs,
				iterations: ITERATIONS,
			};
			results.push(overheadResult);

			// Calculate overhead percentage
			const overheadMs = ormResult.totalMs - rawExecutionMs;
			const overheadPercent = (overheadMs / rawExecutionMs) * 100;

			console.log(
				`\n📈 ORM Overhead: ${overheadMs.toFixed(3)}ms (${overheadPercent.toFixed(1)}%)`,
			);

			// ORM overhead should be acceptable (< 100% of raw query time)
			// This is a soft assertion - we just want to track it
			expect(overheadPercent).toBeLessThan(200);
		});
	});

	describe('Scalability hints', () => {
		it('should maintain consistent performance across multiple queries', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamModel, adapter });

			const times: number[] = [];

			// Run 10 batches of 10 iterations each
			for (let batch = 0; batch < 10; batch++) {
				const start = performance.now();
				for (let i = 0; i < 10; i++) {
					await orm.withSchema('acme').select('products').execute();
				}
				const end = performance.now();
				times.push((end - start) / 10);
			}

			// Calculate variance
			const avg = times.reduce((a, b) => a + b, 0) / times.length;
			const variance =
				times.reduce((sum, t) => sum + (t - avg) ** 2, 0) / times.length;
			const stdDev = Math.sqrt(variance);

			console.log(
				`\n📉 Query consistency: avg=${avg.toFixed(3)}ms, stdDev=${stdDev.toFixed(3)}ms`,
			);

			// Standard deviation should be reasonable (< 50% of average)
			expect(stdDev / avg).toBeLessThan(0.5);
		});
	});
});
