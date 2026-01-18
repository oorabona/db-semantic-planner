/**
 * Infrastructure Smoke Tests
 *
 * Verifies that the Testcontainers setup works correctly.
 */

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestDb,
	shouldSkipE2E,
} from './testkit/db.js';

describe.skipIf(shouldSkipE2E())('E2E Infrastructure', () => {
	beforeAll(async () => {
		// Ensure clean state
		const _db = await getTestDb();
		await dropSchema('test_infra');
	});

	afterAll(async () => {
		await dropSchema('test_infra');
		await closeTestDb();
	});

	describe('PostgreSQL Container', () => {
		it('should connect to the database', async () => {
			const db = await getTestDb();
			const result = await sql`SELECT 1 as value`.execute(db);

			expect(result.rows).toHaveLength(1);
			expect(result.rows[0]).toEqual({ value: 1 });
		});

		it('should report PostgreSQL version', async () => {
			const db = await getTestDb();
			const result = await sql`SELECT version()`.execute(db);

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

			const db = await getTestDb();
			const result = await sql`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = 'test_infra'
      `.execute(db);

			expect(result.rows).toHaveLength(1);
		});

		it('should create table in schema', async () => {
			const db = await getTestDb();

			await sql`
        CREATE TABLE test_infra.users (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL
        )
      `.execute(db);

			// Insert test data
			await sql`
        INSERT INTO test_infra.users (name) VALUES ('Alice'), ('Bob')
      `.execute(db);

			// Query data
			const result = await sql`
        SELECT * FROM test_infra.users ORDER BY id
      `.execute(db);

			expect(result.rows).toHaveLength(2);
			expect(result.rows[0]).toMatchObject({ name: 'Alice' });
			expect(result.rows[1]).toMatchObject({ name: 'Bob' });
		});

		it('should drop schema with cascade', async () => {
			await dropSchema('test_infra');

			const db = await getTestDb();
			const result = await sql`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = 'test_infra'
      `.execute(db);

			expect(result.rows).toHaveLength(0);
		});
	});
});
