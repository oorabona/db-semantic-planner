/**
 * #261/#262 — introspection originalDbType fidelity (real PostgreSQL).
 *
 * Verifies against a live database (what mocked unit tests cannot):
 * 1. introspect() sources originalDbType from format_type(), preserving every
 *    typmod (temporal precision, bit length, numeric precision, vector dims).
 * 2. A WHERE cast against an introspected schema emits a truncation-safe target
 *    (varchar(120) -> CAST(... AS varchar)), not the bounded type.
 * 3. introspect -> compareSchemata is idempotent (no spurious drift).
 */

import { compareSchemata } from '@dbsp/adapter-pgsql';
import { createOrm, eq, getSchemaFromDb } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createPgsqlAdapterForSchema,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';

const SCHEMA = 'dbtype_fidelity_test';

// pgvector is present in the project's -full test image but not in a stock
// PostgreSQL image; gate the vector column so the suite still runs without it.
let hasVector = false;

describe('#261 introspection originalDbType fidelity (real PG)', () => {
	beforeAll(async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
		const pool = await getTestPool();
		try {
			await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
			hasVector = true;
		} catch {
			hasVector = false;
		}
		await pool.query(`CREATE TYPE ${SCHEMA}.mood AS ENUM ('happy', 'sad')`);
		await pool.query(
			`CREATE TABLE ${SCHEMA}.fidelity (
				id integer PRIMARY KEY,
				ts timestamptz(3),
				bits bit(8),
				vbits varbit(16),
				name varchar(120),
				amount numeric(10,2),
				code char(5),
				when_local time(3) without time zone,
				note text,
				tags integer[],
				labels text[],
				feeling ${SCHEMA}.mood
			)`,
		);
		if (hasVector) {
			await pool.query(
				`ALTER TABLE ${SCHEMA}.fidelity ADD COLUMN embedding vector(768)`,
			);
		}
	});

	afterAll(async () => {
		await dropSchema(SCHEMA);
		await closeTestDb();
	});

	it('captures faithful originalDbType via format_type', async () => {
		const adapter = await createPgsqlAdapterForSchema(SCHEMA);
		const model = await adapter.introspect({ schema: SCHEMA });
		const table = model.getTable('fidelity');
		expect(table).toBeDefined();
		const byName = new Map(
			(table?.columns ?? []).map((c) => [c.name, c.originalDbType]),
		);

		expect(byName.get('ts')).toBe('timestamp(3) with time zone');
		expect(byName.get('bits')).toBe('bit(8)');
		expect(byName.get('vbits')).toBe('bit varying(16)');
		expect(byName.get('name')).toBe('character varying(120)');
		expect(byName.get('amount')).toBe('numeric(10,2)');
		expect(byName.get('code')).toBe('character(5)');
		expect(byName.get('when_local')).toBe('time(3) without time zone');
		expect(byName.get('note')).toBe('text');
		// Array columns are sourced from format_type (finding 6): integer[], not the
		// internal _int4 udt_name.
		expect(byName.get('tags')).toBe('integer[]');
		expect(byName.get('labels')).toBe('text[]');
		// A lowercase custom (enum) type keeps its bare typname identity.
		expect(byName.get('feeling')).toBe('mood');
		if (hasVector) {
			expect(byName.get('embedding')).toBe('vector(768)');
		}
	});

	it('emits a truncation-safe CAST for a bounded introspected type in WHERE', async () => {
		const adapter = await createPgsqlAdapterForSchema(SCHEMA);
		const schema = await getSchemaFromDb(adapter, { schema: SCHEMA });
		const orm = createOrm({ schema, adapter });
		const dump = orm.select('fidelity').where(eq('name', 'x')).dump();

		// varchar(120) must cast to the unbounded base, never the length-bounded type.
		expect(dump.sql).toBe(
			`SELECT fidelity.* FROM ${SCHEMA}.fidelity WHERE fidelity.name = CAST($1 AS varchar)`,
		);
		expect(dump.params).toEqual(['x']);
	});

	it('introspect -> compareSchemata is idempotent (no spurious drift)', async () => {
		const adapter = await createPgsqlAdapterForSchema(SCHEMA);
		const a = await adapter.introspect({ schema: SCHEMA });
		const b = await adapter.introspect({ schema: SCHEMA });
		const diff = compareSchemata(a, b);
		expect(
			diff.changes.filter((c) => c.kind === 'alter_column_type'),
		).toHaveLength(0);
	});
});
