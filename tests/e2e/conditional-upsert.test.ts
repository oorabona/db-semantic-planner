/**
 * Issue #160 — conditional upsert end-to-end proof.
 *
 * Verifies NQL `upsert ... where` compiles to
 * ON CONFLICT DO UPDATE SET ... WHERE and PostgreSQL honors the predicate.
 */

import { isUpsertIntent, schema } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgsqlAdapter } from '../../packages/adapter-pgsql/src/pgsql-adapter.js';
import { compile } from '../../packages/nql/src/index.js';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';
import { sql } from './testkit/sql.js';

const SCHEMA = 'conditional_upsert_e2e';

const conditionalUpsertSchema = schema({
	widgets: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		sku: 'string',
		name: 'string',
		active: 'boolean',
	},
});

async function compileConditionalUpsert(nql: string) {
	const compiled = compile(nql, conditionalUpsertSchema.model);
	if (!compiled.success || !compiled.ast?.mutation) {
		throw new Error(
			`NQL mutation compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	const mutation = compiled.ast.mutation;
	if (!isUpsertIntent(mutation)) {
		throw new Error(`Expected UpsertIntent, got ${mutation.type}`);
	}

	const pool = await getTestPool();
	const adapter = createPgsqlAdapter(pool, {
		schemaName: SCHEMA,
		dbCasing: 'snake_case',
	});
	return adapter.compileUpsert(mutation, {
		model: conditionalUpsertSchema.model,
	});
}

describe('Issue #160 — conditional upsert', () => {
	beforeAll(async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);

		const pool = await getTestPool();
		const s = sql.ref(SCHEMA);

		await sql`
			CREATE TABLE ${s}.widgets (
				id SERIAL PRIMARY KEY,
				sku TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				active BOOLEAN NOT NULL DEFAULT true
			)
		`.execute(pool);

		await sql`
			INSERT INTO ${s}.widgets (sku, name, active) VALUES
				('LOCKED', 'old locked', false),
				('OPEN', 'old open', true)
		`.execute(pool);
	});

	afterAll(async () => {
		await dropSchema(SCHEMA);
		await closeTestDb();
	});

	it('updates conflicting rows only when the DO UPDATE WHERE predicate matches', async () => {
		const pool = await getTestPool();

		const locked = await compileConditionalUpsert(
			"upsert into widgets on sku set sku = 'LOCKED', name = 'new locked', active = false where active = true",
		);
		expect(locked.sql.toLowerCase()).toContain('do update set');
		expect(locked.sql.toLowerCase()).toContain('where widgets.active = $4');

		const lockedResult = await pool.query(
			locked.sql,
			locked.parameters as unknown[],
		);
		expect(lockedResult.rowCount).toBe(0);

		const open = await compileConditionalUpsert(
			"upsert into widgets on sku set sku = 'OPEN', name = 'new open', active = true where active = true",
		);
		const openResult = await pool.query(open.sql, open.parameters as unknown[]);
		expect(openResult.rowCount).toBe(1);

		const rows = await sql<{
			sku: string;
			name: string;
			active: boolean;
		}>`
			SELECT sku, name, active
			FROM ${sql.ref(SCHEMA)}.widgets
			ORDER BY sku
		`.execute(pool);

		expect(rows.rows).toEqual([
			{ sku: 'LOCKED', name: 'old locked', active: false },
			{ sku: 'OPEN', name: 'new open', active: true },
		]);
	});
});
