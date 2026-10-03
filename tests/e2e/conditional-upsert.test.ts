/**
 * Issue #160 — conditional upsert end-to-end proof.
 *
 * Verifies NQL `upsert ... where` compiles to
 * ON CONFLICT DO UPDATE SET ... WHERE and PostgreSQL honors the predicate.
 */

import { createOrm, isUpsertIntent, schema } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgAdapter } from '../../packages/adapter-pgsql/src/pgsql-adapter.js';
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
	const adapter = createPgAdapter(pool, {
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

	it('#914 inserts values() and applies SET only on conflict', async () => {
		const pool = await getTestPool();
		const adapter = createPgAdapter(pool, { schemaName: SCHEMA });
		const orm = createOrm({ schema: conditionalUpsertSchema, adapter });
		const upsert = () =>
			orm
				.upsert('widgets')
				.values({ sku: 'ISSUE_914', name: 'a', active: true })
				.onConflict(['sku'])
				.doUpdate({ name: 'b' })
				.returning(['name']);
		for (const name of ['a', 'b']) {
			expect(await upsert().execute()).toEqual([{ name }]);
			const stored = await sql<{ name: string }>`
				SELECT name FROM ${sql.ref(SCHEMA)}.widgets WHERE sku = 'ISSUE_914'
			`.execute(pool);
			expect(stored.rows).toEqual([{ name }]);
		}
	});

	it('updates conflicting rows only when the DO UPDATE WHERE predicate matches', async () => {
		const pool = await getTestPool();

		const locked = await compileConditionalUpsert(
			"upsert into widgets on sku set sku = 'LOCKED', name = 'new locked', active = false where active = true",
		);
		expect(locked.sql.toLowerCase()).toContain('do update set');
		expect(locked.sql.toLowerCase()).toContain('where widgets.active = $7');

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

	it('executes conditional upsert through orm.nql tag with bound interpolations', async () => {
		const pool = await getTestPool();
		const s = sql.ref(SCHEMA);

		await sql`
			INSERT INTO ${s}.widgets (sku, name, active) VALUES
				('TAG_LOCKED', 'tag old locked', false),
				('TAG_OPEN', 'tag old open', true)
		`.execute(pool);

		const adapter = createPgAdapter(pool, {
			schemaName: SCHEMA,
			dbCasing: 'snake_case',
		});
		const orm = createOrm({ schema: conditionalUpsertSchema, adapter });

		const locked = orm.nql<{
			sku: string;
			name: string;
			active: boolean;
		}>`upsert into widgets on sku set sku = ${'TAG_LOCKED'}, name = ${'tag new locked'}, active = ${false} where active = ${true} | select sku, name, active`;
		const lockedDump = locked.dump();
		if (!('parameters' in lockedDump)) {
			throw new Error('Expected mutation dump for NQL upsert');
		}
		expect(lockedDump).not.toHaveProperty('plan');
		expect(lockedDump.parameters).toEqual([
			'TAG_LOCKED',
			'tag new locked',
			false,
			'TAG_LOCKED',
			'tag new locked',
			false,
			true,
		]);
		expect(lockedDump.sql.toLowerCase()).toContain('do update set');
		expect(lockedDump.sql.toLowerCase()).toContain('where widgets.active = $7');

		const lockedRows = await locked.all();
		expect(lockedRows).toEqual([]);

		const openRows = await orm.nql<{
			sku: string;
			name: string;
			active: boolean;
		}>`upsert into widgets on sku set sku = ${'TAG_OPEN'}, name = ${'tag new open'}, active = ${true} where active = ${true} | select sku, name, active`.all();
		expect(openRows).toEqual([
			{ sku: 'TAG_OPEN', name: 'tag new open', active: true },
		]);

		const rows = await sql<{
			sku: string;
			name: string;
			active: boolean;
		}>`
			SELECT sku, name, active
			FROM ${sql.ref(SCHEMA)}.widgets
			WHERE sku LIKE 'TAG_%'
			ORDER BY sku
		`.execute(pool);

		expect(rows.rows).toEqual([
			{ sku: 'TAG_LOCKED', name: 'tag old locked', active: false },
			{ sku: 'TAG_OPEN', name: 'tag new open', active: true },
		]);
	});
});
