/** Live proof for the non-persisted, additive startup convergence entry point. */
import { randomUUID } from 'node:crypto';
import { readPgLedgerAddressChain } from '@dbsp/adapter-pgsql';
import {
	convergePg,
	PgConvergeRefusalError,
} from '@dbsp/adapter-pgsql/internal';
import { projectLedgerChain } from '@dbsp/core';
import type { LedgerAddress, ModelIR, TableIR } from '@dbsp/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';

const schema = `converge_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

function model(tables: readonly TableIR[]): ModelIR {
	const byName = new Map(tables.map((table) => [table.name, table]));
	return {
		tables: byName,
		relations: new Map(),
		getTable: (name) => byName.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function table(name: string, includeNickname = true): TableIR {
	return {
		name,
		columns: [
			{ name: 'id', type: 'integer', nullable: false },
			...(includeNickname
				? ([
						{ name: 'nickname', type: 'string', nullable: true },
					] satisfies TableIR['columns'])
				: []),
		],
		foreignKeys: [],
		indexes: includeNickname
			? [{ name: `idx_${name}_nickname`, columns: ['nickname'] }]
			: [],
	};
}

async function database(): Promise<string> {
	const pool = await getTestPool();
	return String(
		(await pool.query('SELECT current_database() AS name')).rows[0]?.name,
	);
}

async function managed(address: LedgerAddress): Promise<boolean> {
	const pool = await getTestPool();
	const chain = await readPgLedgerAddressChain(
		pool,
		{ scope: 'schema', schema },
		address,
	);
	const state = projectLedgerChain(chain);
	return (
		state.kind === 'projected-ledger-chain' && state.stableState === 'managed'
	);
}

function address(
	databaseId: string,
	kind: LedgerAddress['kind'],
	name: string,
	parent?: LedgerAddress,
): LedgerAddress {
	return {
		scope: 'schema',
		engine: 'postgresql',
		database: databaseId,
		schema,
		kind,
		name,
		...(parent === undefined ? {} : { parent }),
	};
}

describe('convergePg', () => {
	beforeAll(async () => {
		await createSchema(schema);
	});

	afterAll(async () => {
		await dropSchema(schema);
		await closeTestDb();
	});

	it('creates a declared table, nullable column and non-unique index with managed terminals', async () => {
		const pool = await getTestPool();
		const databaseId = await database();
		const desired = model([table('first_fixture')]);
		await expect(
			pool.query(`SELECT to_regclass($1) AS relation`, [
				`${schema}.first_fixture`,
			]),
		).resolves.toMatchObject({ rows: [{ relation: null }] });

		await expect(convergePg(pool, desired, { schema })).resolves.toMatchObject({
			kind: 'applied',
		});
		const root = address(databaseId, 'table', 'first_fixture');
		await expect(
			pool.query('SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists', [
				`${schema}.first_fixture`,
			]),
		).resolves.toMatchObject({ rows: [{ exists: true }] });
		await expect(
			pool.query(
				'SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3',
				[schema, 'first_fixture', 'nickname'],
			),
		).resolves.toMatchObject({ rows: [{ is_nullable: 'YES' }] });
		await expect(
			pool.query(
				'SELECT index_definition.indisunique AS unique FROM pg_catalog.pg_index index_definition JOIN pg_catalog.pg_class index_class ON index_class.oid = index_definition.indexrelid JOIN pg_catalog.pg_class table_class ON table_class.oid = index_definition.indrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace WHERE namespace.nspname = $1 AND table_class.relname = $2 AND index_class.relname = $3',
				[schema, 'first_fixture', 'idx_first_fixture_nickname'],
			),
		).resolves.toMatchObject({ rows: [{ unique: false }] });
		await expect(managed(root)).resolves.toBe(true);
		await expect(
			managed(address(databaseId, 'index', 'idx_first_fixture_nickname', root)),
		).resolves.toBe(true);
		await expect(
			pool.query(
				`SELECT 1 FROM "${schema}".dbsp_ledger_event WHERE address_kind = 'column' AND address_parent @> jsonb_build_object('kind', 'table', 'name', 'first_fixture')`,
			),
		).resolves.toMatchObject({ rows: [] });
	});

	it('adds a nullable column to a managed table with a managed column terminal', async () => {
		const pool = await getTestPool();
		const databaseId = await database();
		await expect(
			convergePg(pool, model([table('add_column_fixture', false)]), { schema }),
		).resolves.toMatchObject({ kind: 'applied' });
		await expect(
			convergePg(pool, model([table('add_column_fixture')]), { schema }),
		).resolves.toMatchObject({ kind: 'applied' });
		await expect(
			pool.query(
				'SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3',
				[schema, 'add_column_fixture', 'nickname'],
			),
		).resolves.toMatchObject({ rows: [{ is_nullable: 'YES' }] });
		const root = address(databaseId, 'table', 'add_column_fixture');
		await expect(
			managed(address(databaseId, 'column', 'nickname', root)),
		).resolves.toBe(true);
	});

	it('leaves unobstructed declarations absent on refusal, then applies all after the obstacle is removed', async () => {
		const pool = await getTestPool();
		const databaseId = await database();
		const names = ['resume_one', 'resume_two', 'resume_three'];
		const desired = model(names.map((name) => table(name)));
		await pool.query(`CREATE TABLE "${schema}"."resume_two" ("other" integer)`);

		await expect(convergePg(pool, desired, { schema })).rejects.toBeInstanceOf(
			PgConvergeRefusalError,
		);
		for (const name of ['resume_one', 'resume_three'])
			await expect(
				pool.query('SELECT pg_catalog.to_regclass($1) AS relation', [
					`${schema}.${name}`,
				]),
			).resolves.toMatchObject({ rows: [{ relation: null }] });
		await expect(
			pool.query('SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists', [
				`${schema}.resume_two`,
			]),
		).resolves.toMatchObject({ rows: [{ exists: true }] });
		await pool.query(`DROP TABLE "${schema}"."resume_two"`);
		await expect(convergePg(pool, desired, { schema })).resolves.toMatchObject({
			kind: 'applied',
		});
		for (const name of names) {
			await expect(
				pool.query('SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists', [
					`${schema}.${name}`,
				]),
			).resolves.toMatchObject({ rows: [{ exists: true }] });
			await expect(managed(address(databaseId, 'table', name))).resolves.toBe(
				true,
			);
		}
	});
});
