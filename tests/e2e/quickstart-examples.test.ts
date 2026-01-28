/**
 * CLI-022: QUICKSTART.md Examples Validation
 *
 * Tests that all examples in QUICKSTART.md work correctly.
 * Uses the batch mode to execute queries programmatically.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createBlogSchema,
	dropBlogSchema,
	seedBlogData,
	shouldSkipE2E,
} from './testkit/index.js';

const ROOT_DIR = resolve(import.meta.dirname, '../..');

/**
 * Execute REPL in batch mode and return results
 * Uses execFileSync to avoid shell injection vulnerabilities
 */
function runBatchQuery(
	schemaPath: string,
	query: string,
	options: { db?: string; format?: 'text' | 'json' } = {},
): { stdout: string; stderr: string; success: boolean } {
	const args = ['dbsp', 'repl', '--schema', schemaPath, '--eval', query];
	if (options.format) {
		args.push('--format', options.format);
	}
	if (options.db) {
		args.push('--db', options.db);
	}

	try {
		// Use pnpm via execFileSync to avoid shell injection
		const stdout = execFileSync('pnpm', args, {
			cwd: ROOT_DIR,
			encoding: 'utf-8',
			timeout: 30000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return { stdout, stderr: '', success: true };
	} catch (error) {
		const execError = error as { stdout?: string; stderr?: string };
		return {
			stdout: execError.stdout ?? '',
			stderr: execError.stderr ?? '',
			success: false,
		};
	}
}

describe('QUICKSTART Examples - Compile Only', () => {
	describe('Minimal Schema', () => {
		const schema = './examples/minimal.schema.ts';

		it('should list tables', () => {
			const result = runBatchQuery(schema, '.tables');
			expect(result.success).toBe(true);
			expect(result.stdout).toContain('Tables (2)');
			expect(result.stdout).toContain('users');
			expect(result.stdout).toContain('posts');
		});

		it('should show table schema', () => {
			const result = runBatchQuery(schema, '.schema users');
			expect(result.success).toBe(true);
			expect(result.stdout).toContain('Table: users');
			expect(result.stdout).toContain('id');
			expect(result.stdout).toContain('name');
			expect(result.stdout).toContain('email');
		});

		it('should compile simple select', () => {
			const result = runBatchQuery(schema, 'users');
			expect(result.success).toBe(true);
			expect(result.stdout).toContain('select');
			expect(result.stdout).toContain('"users"');
		});

		it('should compile filtered query', () => {
			const result = runBatchQuery(schema, 'users | where id = 1');
			expect(result.success).toBe(true);
			expect(result.stdout).toContain('where');
			expect(result.stdout).toContain('$1');
			expect(result.stdout).toContain('[1]');
		});

		it('should compile query with relation using json_agg (STRAT-SIMPLIFY)', () => {
			const result = runBatchQuery(schema, 'users | select *, posts.*');
			expect(result.success).toBe(true);
			// STRAT-SIMPLIFY: json_agg is default for ALL relations
			expect(result.stdout).toContain('json_agg');
			expect(result.stdout).toContain('"posts"');
		});

		it('should compile query with limit/offset', () => {
			const result = runBatchQuery(schema, 'posts | limit 10 | offset 20');
			expect(result.success).toBe(true);
			expect(result.stdout).toContain('limit');
			expect(result.stdout).toContain('offset');
		});
	});

	describe('Blog Schema', () => {
		const schema = './examples/blog.schema.ts';

		it('should list tables', () => {
			const result = runBatchQuery(schema, '.tables');
			expect(result.success).toBe(true);
			expect(result.stdout).toContain('authors');
			expect(result.stdout).toContain('posts');
			expect(result.stdout).toContain('comments');
		});

		it('should compile aggregate: count', () => {
			const result = runBatchQuery(schema, 'posts | select count(*)');
			expect(result.success).toBe(true);
			expect(result.stdout).toContain('count(*)');
		});

		it('should compile aggregate: count with alias', () => {
			const result = runBatchQuery(schema, 'posts | select count(*) as total');
			expect(result.success).toBe(true);
			expect(result.stdout).toContain('count(*)');
			expect(result.stdout).toContain('total');
		});

		it('should compile aggregate: group by', () => {
			const result = runBatchQuery(
				schema,
				'posts | group by authorId | select count(*)',
			);
			expect(result.success).toBe(true);
			expect(result.stdout).toContain('group by');
			expect(result.stdout).toContain('count(*)');
		});

		it('should compile distinct', () => {
			const result = runBatchQuery(schema, 'posts | select distinct *');
			expect(result.success).toBe(true);
			expect(result.stdout).toContain('distinct');
		});

		it('should compile posts with author relation using json_agg (STRAT-SIMPLIFY)', () => {
			const result = runBatchQuery(schema, 'posts | select *, author.*');
			expect(result.success).toBe(true);
			// STRAT-SIMPLIFY: json_agg is default for ALL relations (including belongsTo)
			expect(result.stdout).toContain('json_agg');
			expect(result.stdout).toContain('"authors"');
		});
	});

	describe('E-Commerce Schema', () => {
		const schema = './examples/ecommerce.schema.ts';

		it('should list tables', () => {
			const result = runBatchQuery(schema, '.tables');
			expect(result.success).toBe(true);
			expect(result.stdout).toContain('products');
			expect(result.stdout).toContain('categories');
			expect(result.stdout).toContain('orders');
		});

		it('should compile filtered products query', () => {
			const result = runBatchQuery(
				schema,
				'products | where active = true and stock > 0',
			);
			expect(result.success).toBe(true);
			expect(result.stdout).toContain('where');
			expect(result.stdout).toContain('"active"');
			expect(result.stdout).toContain('"stock"');
		});

		it('should compile products with variants using json_agg (STRAT-SIMPLIFY)', () => {
			const result = runBatchQuery(schema, 'products | select *, variants.*');
			expect(result.success).toBe(true);
			// STRAT-SIMPLIFY: json_agg is default for ALL relations (hasMany)
			expect(result.stdout).toContain('json_agg');
		});
	});

	describe('Scheduling Schema (Range Types)', () => {
		const schema = './examples/scheduling.schema.ts';

		it('should list tables', () => {
			const result = runBatchQuery(schema, '.tables');
			expect(result.success).toBe(true);
			expect(result.stdout).toContain('rooms');
			expect(result.stdout).toContain('roomBookings');
		});

		// Note: Range type queries require actual PostgreSQL execution
		// These tests verify the schema loads correctly
		it('should compile roomBookings query', () => {
			const result = runBatchQuery(schema, 'roomBookings');
			expect(result.success).toBe(true);
			expect(result.stdout).toContain('select');
			expect(result.stdout).toContain('"room_bookings"');
		});
	});
});

// NOTE: Assertion-based validation tests were removed (duplicate of example-assertions.test.ts
// which uses the programmatic executeBatch() API instead of spawning CLI processes).

// E2E tests with actual database execution
// These tests are skipped when DATABASE_URL is not set
describe.skipIf(shouldSkipE2E())('QUICKSTART Examples - With Database', () => {
	const SCHEMA = 'quickstart_e2e';

	beforeAll(async () => {
		// Skip setup if DATABASE_URL is not available
		if (shouldSkipE2E()) return;
		await dropBlogSchema(SCHEMA);
		await createBlogSchema(SCHEMA);
		await seedBlogData(SCHEMA);
	});

	afterAll(async () => {
		// Skip teardown if DATABASE_URL is not available
		if (shouldSkipE2E()) return;
		await dropBlogSchema(SCHEMA);
		await closeTestDb();
	});

	it('should execute query with database connection', async () => {
		const dbUrl = process.env.DATABASE_URL;
		expect(dbUrl).toBeDefined();
		if (!dbUrl) return; // TypeScript guard

		// Use testkit blog schema for execution tests
		const result = runBatchQuery('./examples/blog.schema.ts', '.tables', {
			db: dbUrl,
		});

		expect(result.success).toBe(true);
		expect(result.stdout).toContain('Tables');
	});
});
