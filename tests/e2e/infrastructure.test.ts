/**
 * Infrastructure Smoke Tests
 *
 * Verifies that the Testcontainers setup works correctly.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/db.js';
import { sql } from './testkit/sql.js';

describe('E2E Infrastructure', () => {
	beforeAll(async () => {
		// Ensure clean state
		const _db = await getTestPool();
		await dropSchema('test_infra');
	});

	afterAll(async () => {
		await dropSchema('test_infra');
		await closeTestDb();
	});

	describe('PostgreSQL Container', () => {
		it('should connect to the database', async () => {
			const pool = await getTestPool();
			const result = await sql`SELECT 1 as value`.execute(pool);

			expect(result.rows).toHaveLength(1);
			expect(result.rows[0]).toEqual({ value: 1 });
		});

		it('should report PostgreSQL version', async () => {
			const pool = await getTestPool();
			const result = await sql`SELECT version()`.execute(pool);

			expect(result.rows).toHaveLength(1);
			expect(result.rows[0]).toHaveProperty('version');
			expect((result.rows[0] as { version: string }).version).toContain(
				'PostgreSQL',
			);
		});
	});

	describe('Schema Management', () => {
		it('should create a schema', async () => {
			await createSchema('test_infra');

			const pool = await getTestPool();
			const result = await sql`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = 'test_infra'
      `.execute(pool);

			expect(result.rows).toHaveLength(1);
		});

		it('should create table in schema', async () => {
			const pool = await getTestPool();

			await sql`
        CREATE TABLE test_infra.users (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL
        )
      `.execute(pool);

			// Insert test data
			await sql`
        INSERT INTO test_infra.users (name) VALUES ('Alice'), ('Bob')
      `.execute(pool);

			// Query data
			const result = await sql`
        SELECT * FROM test_infra.users ORDER BY id
      `.execute(pool);

			expect(result.rows).toHaveLength(2);
			expect(result.rows[0]).toMatchObject({ name: 'Alice' });
			expect(result.rows[1]).toMatchObject({ name: 'Bob' });
		});

		it('should drop schema with cascade', async () => {
			await dropSchema('test_infra');

			const pool = await getTestPool();
			const result = await sql`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = 'test_infra'
      `.execute(pool);

			expect(result.rows).toHaveLength(0);
		});
	});
});
