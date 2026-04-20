/**
 * S-2: originalDbType + CAST round-trip (E2E with real PostgreSQL)
 * S-3: SET DEFAULT FK round-trip (E2E with real PostgreSQL)
 *
 * These tests prove that the mock-based coverage in param-type-cast.test.ts and
 * the introspection unit tests actually match real PostgreSQL behaviour:
 *
 * S-2: introspect() sets originalDbType from udt_name ('int4' for integer columns),
 *      and the compiler emits CAST($1 AS int4) when querying nullable integer columns.
 *
 * S-3: introspect() correctly maps PostgreSQL's "SET DEFAULT" delete_rule to the
 *      OnDeleteAction 'SET DEFAULT' — proving mapDeleteRule() is not mock-only.
 *
 * Regression gate for S-2:
 *   Comment out the `originalDbType: col.udt_name` line in buildTableIR → this test
 *   fails because the column loses its originalDbType → no CAST in SQL.
 *   Restore → test passes.
 */

import {
	createPgsqlAdapter,
	createPgsqlCompileOnlyAdapter,
	introspect,
} from '@dbsp/adapter-pgsql';
import { createOrm, eq } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, dropSchema, getTestPool } from './testkit/index.js';

// ─── S-2 schema ───────────────────────────────────────────────────────────────

const S2_SCHEMA = 'originaldbtype_cast_test';

const S2_DDL = `
CREATE TABLE items (
  id     serial PRIMARY KEY,
  fk_id  integer NULL
);
`;

// ─── S-3 schema ───────────────────────────────────────────────────────────────

const S3_SCHEMA = 'set_default_fk_test';

const S3_DDL = `
CREATE TABLE parent (
  id integer PRIMARY KEY
);
CREATE TABLE child (
  id        integer PRIMARY KEY,
  parent_id integer NOT NULL DEFAULT 0
    REFERENCES parent(id) ON DELETE SET DEFAULT
);
`;

// ─── helpers ──────────────────────────────────────────────────────────────────

async function execDDL(schema: string, ddl: string): Promise<void> {
	const pool = await getTestPool();
	await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
	await pool.query(`SET search_path TO "${schema}"`);
	try {
		for (const stmt of ddl
			.split(';')
			.map((s) => s.trim())
			.filter(Boolean)) {
			await pool.query(stmt);
		}
	} finally {
		// L-1: always reset search_path even if a DDL statement throws,
		// so subsequent tests run in the expected `public` schema context.
		await pool.query(`SET search_path TO public`);
	}
}

// ==============================================================================
// S-2: originalDbType round-trip
// ==============================================================================

describe('S-2: originalDbType + CAST round-trip (real PostgreSQL)', () => {
	beforeAll(async () => {
		await dropSchema(S2_SCHEMA);
		await execDDL(S2_SCHEMA, S2_DDL);
	});

	afterAll(async () => {
		await dropSchema(S2_SCHEMA);
	});

	it('introspect sets originalDbType = "int4" for an integer column', async () => {
		const pool = await getTestPool();
		const model = await introspect(pool, { schema: S2_SCHEMA });

		const col = model.tables
			.get('items')
			?.columns.find((c) => c.name === 'fk_id');

		expect(col).toBeDefined();
		// PostgreSQL returns udt_name = 'int4' for INTEGER columns.
		// buildTableIR sets originalDbType: col.udt_name — so this must be 'int4'.
		// If originalDbType is missing or differs, S-2 is broken at the introspection layer.
		expect(col?.originalDbType).toBe('int4');
		// Negative guards: PG returns lowercase 'int4', not 'integer' or 'INT4'.
		expect(col?.originalDbType).not.toBe('integer');
		expect(col?.originalDbType).not.toBe('INT4');
		expect(col?.originalDbType).not.toBe('INTEGER');
	});

	it('compiled SQL contains CAST($1 AS int4) for nullable integer WHERE clause', async () => {
		const pool = await getTestPool();
		const model = await introspect(pool, { schema: S2_SCHEMA });

		// Use compile-only adapter to inspect SQL without executing against DB.
		// Pass model (IntrospectedModelIR extends ModelIR) directly — no schema() wrapper needed.
		const adapter = createPgsqlCompileOnlyAdapter();
		const orm = createOrm({ model, adapter });

		const dump = orm
			.withSchema(S2_SCHEMA)
			.select('items')
			.where(eq('fk_id', 42))
			.dump();

		// The key assertion: originalDbType 'int4' propagated through to the
		// WHERE compilation, producing an explicit CAST to avoid pg type ambiguity.
		// If originalDbType was not set by introspection, this becomes plain $1.
		expect(dump.sql).toContain('CAST($1 AS int4)');
		expect(dump.params).toEqual([42]);
	});

	it('regression gate: without originalDbType the CAST is absent (validates gate)', async () => {
		// Simulate a manually-constructed schema without originalDbType (e.g. code-first schema).
		// This proves that the CAST above comes from introspection, not some global default.
		const { schema: schemaFn } = await import('@dbsp/core');
		const manualSchema = schemaFn({
			items: {
				id: { type: 'integer', primaryKey: true },
				fk_id: { type: 'integer', nullable: true },
			},
		});

		const adapter = createPgsqlCompileOnlyAdapter();
		const orm = createOrm({ schema: manualSchema, adapter });

		const dump = orm.select('items').where(eq('fk_id', 42)).dump();

		// Manual schema has no originalDbType → no CAST emitted.
		expect(dump.sql).not.toContain('CAST($1');
		expect(dump.params).toEqual([42]);
	});

	it('round-trip: execute query against real DB using introspected schema', async () => {
		// Seed one row so the query executes successfully.
		const pool = await getTestPool();
		await pool.query(`SET search_path TO "${S2_SCHEMA}"`);
		await pool.query(
			`INSERT INTO items (fk_id) VALUES (1) ON CONFLICT DO NOTHING`,
		);
		await pool.query(`SET search_path TO public`);

		const model = await introspect(pool, { schema: S2_SCHEMA });
		const adapter = createPgsqlAdapter(pool);
		// Pass model (IntrospectedModelIR extends ModelIR) directly.
		const orm = createOrm({ model, adapter });

		// The query uses CAST($1 AS int4) in WHERE — must succeed against real PG.
		const rows = await orm
			.withSchema(S2_SCHEMA)
			.select('items')
			.where(eq('fk_id', 1))
			.all();

		expect(Array.isArray(rows)).toBe(true);
	});
});

// ==============================================================================
// S-3: SET DEFAULT FK round-trip
// ==============================================================================

describe('S-3: SET DEFAULT FK round-trip (real PostgreSQL)', () => {
	beforeAll(async () => {
		await dropSchema(S3_SCHEMA);
		await execDDL(S3_SCHEMA, S3_DDL);
	});

	afterAll(async () => {
		await dropSchema(S3_SCHEMA);
		await closeTestDb();
	});

	it('introspect maps ON DELETE SET DEFAULT to onDelete === "SET DEFAULT"', async () => {
		const pool = await getTestPool();
		const model = await introspect(pool, { schema: S3_SCHEMA });

		const childTable = model.tables.get('child');
		expect(childTable).toBeDefined();
		expect(childTable!.foreignKeys).toHaveLength(1);

		const fk = childTable!.foreignKeys[0]!;

		// PostgreSQL information_schema.referential_constraints returns the
		// delete_rule in UPPER CASE with a space: "SET DEFAULT" (not "SET_DEFAULT").
		// If PG returns a different format than expected, this test will surface it
		// so mapDeleteRule() can be corrected — the mock-only test masked this.
		expect(fk.onDelete).toBe('SET DEFAULT');
	});

	it('mapDeleteRule handles the exact PG format "SET DEFAULT" (not lowercase or underscored)', async () => {
		// Secondary assertion: verify the exact case+spacing the introspector
		// produces matches what PG actually sends. Any mismatch → bug in mapDeleteRule.
		const pool = await getTestPool();
		const model = await introspect(pool, { schema: S3_SCHEMA });

		const fk = model.tables.get('child')!.foreignKeys[0]!;

		// These negative assertions document what PG does NOT return,
		// preventing silent regressions if someone changes the mapper.
		expect(fk.onDelete).not.toBe('set default');
		expect(fk.onDelete).not.toBe('SET_DEFAULT');
		expect(fk.onDelete).not.toBe('setDefault');
	});
});
