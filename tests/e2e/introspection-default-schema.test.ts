/**
 * #283 — catalog reads default to the session's current_schema(), not literal
 * 'public'.
 *
 * On a connection whose search_path points at a non-public schema, the adapter's
 * catalog helpers (listIndexes / indexExists / storageSize) must inspect that
 * schema when no explicit/adapter schema is given — previously they hard-coded
 * 'public' and silently missed the objects (astix-io/astix#195).
 */

import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';

const SCHEMA = 'default_schema_test';
// An empty schema placed FIRST on the search_path. current_schema() returns this
// (the first existing schema), but `widgets` only exists in SCHEMA — so a naive
// current_schema() resolution would miss it; search_path-aware resolution (via
// to_regclass / ::regclass) finds it. This is the multi-entry-search_path edge.
const EMPTY_FIRST = 'default_schema_test_empty';

// A dedicated pool whose connections start with search_path = EMPTY_FIRST, SCHEMA.
let scopedPool: Pool;

describe('#283 catalog reads resolve the table search_path-aware (real PG)', () => {
	beforeAll(async () => {
		await dropSchema(SCHEMA);
		await dropSchema(EMPTY_FIRST);
		await createSchema(SCHEMA);
		await createSchema(EMPTY_FIRST);
		const pool = await getTestPool();
		await pool.query(
			`CREATE TABLE ${SCHEMA}.widgets (id integer PRIMARY KEY, label text)`,
		);
		await pool.query(
			`CREATE INDEX idx_widgets_label ON ${SCHEMA}.widgets (label)`,
		);

		const connectionString = process.env.DATABASE_URL;
		if (!connectionString) throw new Error('DATABASE_URL not set');
		scopedPool = new Pool({
			connectionString,
			options: `-c search_path=${EMPTY_FIRST},${SCHEMA}`,
		});
	});

	afterAll(async () => {
		await scopedPool?.end();
		await dropSchema(SCHEMA);
		await dropSchema(EMPTY_FIRST);
		await closeTestDb();
	});

	it('listIndexes finds indexes where the table resolves, not in the first (empty) search_path schema', async () => {
		// No schemaName on the adapter and no explicit schema arg → the table is
		// resolved search_path-aware (SCHEMA), even though current_schema() is
		// EMPTY_FIRST.
		const adapter = createPgsqlAdapter(scopedPool);
		const indexes = await adapter.listIndexes('widgets');
		expect(indexes.map((i) => i.name)).toContain('idx_widgets_label');
	});

	it('indexExists resolves the table search_path-aware when no schema is given', async () => {
		const adapter = createPgsqlAdapter(scopedPool);
		expect(await adapter.indexExists('idx_widgets_label', 'widgets')).toBe(
			true,
		);
	});

	it('storageSize resolves the table search_path-aware when no schema is given', async () => {
		const adapter = createPgsqlAdapter(scopedPool);
		expect(await adapter.storageSize('widgets')).toBeGreaterThan(0);
	});
});
