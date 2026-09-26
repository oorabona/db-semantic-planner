/** Live proof for the non-persisted, additive startup convergence entry point. */
import { randomUUID } from 'node:crypto';
import { readPgLedgerAddressChain } from '@dbsp/adapter-pgsql';
import {
	convergePg,
	PgConvergeRefusalError,
} from '@dbsp/adapter-pgsql/internal';
import { projectLedgerChain } from '@dbsp/core';
import type { LedgerAddress, ModelIR, SequenceIR, TableIR } from '@dbsp/types';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';
import { runPreflight } from './transition-reinitialize-preflight-testkit.js';

const schema = `converge_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const typesSchema = `${schema}_types`;
const typesSearchPath = `${typesSchema},public`;
const domain = 'converge_step_type';

function model(
	tables: readonly TableIR[],
	sequences: readonly SequenceIR[] = [],
): ModelIR {
	const byName = new Map(tables.map((table) => [table.name, table]));
	return {
		tables: byName,
		sequences: new Map(sequences.map((sequence) => [sequence.name, sequence])),
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
		primaryKey: 'id',
		foreignKeys: [],
		indexes: [],
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
		await createSchema(typesSchema);
		const pool = await getTestPool();
		await pool.query(`CREATE DOMAIN "${typesSchema}"."${domain}" AS integer`);
		await runPreflight([schema], { writeAdoptionFile: async () => {} });
	});

	afterAll(async () => {
		try {
			await dropSchema(schema);
		} finally {
			try {
				await dropSchema(typesSchema);
			} finally {
				await closeTestDb();
			}
		}
	});

	it('creates a declared table and nullable column with a managed table terminal', async () => {
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
		await expect(managed(root)).resolves.toBe(true);
		await expect(
			pool.query(
				`SELECT 1 FROM "${schema}".dbsp_ledger_event WHERE address_kind = 'column' AND address_parent @> jsonb_build_object('kind', 'table', 'name', 'first_fixture')`,
			),
		).resolves.toMatchObject({ rows: [] });
	});

	it('creates a domain column after validating the ledger on the step session', async () => {
		const dedicatedPool = new pg.Pool({
			connectionString: process.env.DATABASE_URL!,
			options: `-c search_path=${typesSearchPath}`,
		});
		try {
			expect(
				(await dedicatedPool.query<{ search_path: string }>('SHOW search_path'))
					.rows[0]?.search_path,
			).toBe(typesSearchPath);
			const desired = model([
				{
					...table('domain_fixture', false),
					columns: [
						{ name: 'id', type: 'integer', nullable: false },
						{
							name: 'value',
							type: 'integer',
							nullable: true,
							originalDbType: domain,
						},
					],
				},
			]);

			await expect(
				convergePg(dedicatedPool, desired, { schema }),
			).resolves.toMatchObject({ kind: 'applied' });
			await expect(
				dedicatedPool.query(
					'SELECT attribute.atttypid = domain_type.oid AS uses_domain FROM pg_catalog.pg_attribute attribute JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid JOIN pg_catalog.pg_namespace relation_namespace ON relation_namespace.oid = relation.relnamespace JOIN pg_catalog.pg_type domain_type ON domain_type.typname = $4 JOIN pg_catalog.pg_namespace domain_namespace ON domain_namespace.oid = domain_type.typnamespace AND domain_namespace.nspname = $5 WHERE relation_namespace.nspname = $1 AND relation.relname = $2 AND attribute.attname = $3 AND NOT attribute.attisdropped',
					[schema, 'domain_fixture', 'value', domain, typesSchema],
				),
			).resolves.toMatchObject({ rows: [{ uses_domain: true }] });
		} finally {
			await dedicatedPool.end();
		}
	});

	it('creates a fresh declaration with indexes, CHECKs, FKs, and a sequence', async () => {
		const pool = await getTestPool();
		const databaseId = await database();
		const desired = model(
			[
				{
					...table('fresh_users', false),
					columns: [
						{
							name: 'id',
							type: 'integer',
							nullable: false,
							default: {
								sql: `nextval('${schema}.fresh_sequence'::regclass)`,
							},
						},
						{ name: 'external_id', type: 'integer', nullable: false },
						{
							name: 'profile',
							type: 'string',
							nullable: true,
							originalDbType: 'jsonb',
						},
					],
					indexes: [
						{
							name: 'fresh_users_external_id_unique',
							columns: ['external_id'],
							unique: true,
						},
						{
							name: 'fresh_users_profile_gin',
							columns: ['profile'],
							method: 'gin',
						},
					],
					checkConstraints: [
						{ name: 'fresh_users_id_check', expression: 'id > 0' },
					],
				},
				{
					...table('fresh_posts', false),
					columns: [
						{ name: 'id', type: 'integer', nullable: false },
						{ name: 'user_id', type: 'integer', nullable: false },
					],
					foreignKeys: [
						{
							columns: ['user_id'],
							references: { table: 'fresh_users', columns: ['external_id'] },
						},
					],
					indexes: [
						{ name: 'fresh_posts_user_id_index', columns: ['user_id'] },
					],
					checkConstraints: [
						{ name: 'fresh_posts_id_check', expression: 'id > 0' },
					],
				},
			],
			[{ name: 'fresh_sequence' }],
		);

		await expect(convergePg(pool, desired, { schema })).resolves.toMatchObject({
			kind: 'applied',
		});
		await expect(convergePg(pool, desired, { schema })).resolves.toEqual({
			kind: 'no-drift',
			applied: [],
		});
		const users = address(databaseId, 'table', 'fresh_users');
		const posts = address(databaseId, 'table', 'fresh_posts');
		await expect(
			managed(
				address(databaseId, 'index', 'fresh_users_external_id_unique', users),
			),
		).resolves.toBe(true);
		await expect(
			managed(address(databaseId, 'constraint', 'fresh_users_id_check', users)),
		).resolves.toBe(true);
		await expect(
			managed(
				address(databaseId, 'constraint', 'fk_fresh_posts_user_id', posts),
			),
		).resolves.toBe(true);
		await expect(
			managed(address(databaseId, 'sequence', 'fresh_sequence')),
		).resolves.toBe(true);
	});

	it.each([
		[
			'partial unique index',
			[
				{
					name: 'partial_unique_parent_external_id',
					columns: ['external_id'],
					unique: true,
					where: 'external_id IS NOT NULL',
				},
			],
		],
		['no unique key', []],
	] as const)(
		'refuses a fresh FK to columns with a %s before creating either table',
		async (_reason, parentIndexes) => {
			const pool = await getTestPool();
			const desired = model([
				{
					...table('partial_unique_parent', false),
					columns: [
						{ name: 'id', type: 'integer', nullable: false },
						{ name: 'external_id', type: 'integer', nullable: false },
					],
					indexes: parentIndexes,
				},
				{
					...table('partial_unique_child', false),
					columns: [
						{ name: 'id', type: 'integer', nullable: false },
						{ name: 'parent_external_id', type: 'integer', nullable: false },
					],
					foreignKeys: [
						{
							columns: ['parent_external_id'],
							references: {
								table: 'partial_unique_parent',
								columns: ['external_id'],
							},
						},
					],
					indexes: [
						{
							name: 'partial_unique_child_parent_external_id_index',
							columns: ['parent_external_id'],
						},
					],
				},
			]);

			await expect(convergePg(pool, desired, { schema })).rejects.toMatchObject(
				{
					refusal: 'unsupported-change',
					detail: expect.stringContaining('partial_unique_parent(external_id)'),
				},
			);
			for (const tableName of ['partial_unique_parent', 'partial_unique_child'])
				await expect(
					pool.query('SELECT pg_catalog.to_regclass($1) AS relation', [
						`${schema}.${tableName}`,
					]),
				).resolves.toMatchObject({ rows: [{ relation: null }] });
		},
	);

	it('ignores undeclared live sequences', async () => {
		const pool = await getTestPool();
		await pool.query(`CREATE SEQUENCE "${schema}"."undeclared_sequence"`);

		await expect(convergePg(pool, model([]), { schema })).resolves.toEqual({
			kind: 'no-drift',
			applied: [],
		});
		await expect(
			pool.query('SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists', [
				`${schema}.undeclared_sequence`,
			]),
		).resolves.toMatchObject({ rows: [{ exists: true }] });
	});

	it('creates cyclic foreign keys after both fresh tables', async () => {
		const databaseId = await database();
		const pool = await getTestPool();
		const desired = model([
			{
				...table('cycle_left', false),
				columns: [
					{ name: 'id', type: 'integer', nullable: false },
					{ name: 'right_id', type: 'integer', nullable: true },
				],
				foreignKeys: [
					{
						columns: ['right_id'],
						references: { table: 'cycle_right', columns: ['id'] },
					},
				],
				indexes: [{ name: 'cycle_left_right_id_index', columns: ['right_id'] }],
			},
			{
				...table('cycle_right', false),
				columns: [
					{ name: 'id', type: 'integer', nullable: false },
					{ name: 'left_id', type: 'integer', nullable: true },
				],
				foreignKeys: [
					{
						columns: ['left_id'],
						references: { table: 'cycle_left', columns: ['id'] },
					},
				],
				indexes: [{ name: 'cycle_right_left_id_index', columns: ['left_id'] }],
			},
		]);

		await expect(convergePg(pool, desired, { schema })).resolves.toMatchObject({
			kind: 'applied',
		});
		for (const [tableName, indexName] of [
			['cycle_left', 'cycle_left_right_id_index'],
			['cycle_right', 'cycle_right_left_id_index'],
		] as const) {
			await expect(
				pool.query(
					'SELECT indexname FROM pg_catalog.pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname',
					[schema, tableName],
				),
			).resolves.toMatchObject({
				rows: [{ indexname: indexName }, { indexname: `pk_${tableName}` }],
			});
			const parent = address(databaseId, 'table', tableName);
			await expect(
				managed(address(databaseId, 'index', indexName, parent)),
			).resolves.toBe(true);
		}
		for (const [tableName, foreignKeyName] of [
			['cycle_left', 'fk_cycle_left_right_id'],
			['cycle_right', 'fk_cycle_right_left_id'],
		] as const) {
			await expect(
				pool.query(
					'SELECT constraint_item.conname FROM pg_catalog.pg_constraint constraint_item JOIN pg_catalog.pg_class relation ON relation.oid = constraint_item.conrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = $2 AND constraint_item.contype = $3',
					[schema, tableName, 'f'],
				),
			).resolves.toMatchObject({ rows: [{ conname: foreignKeyName }] });
			const parent = address(databaseId, 'table', tableName);
			await expect(
				managed(address(databaseId, 'constraint', foreignKeyName, parent)),
			).resolves.toBe(true);
		}
	});

	it('refuses a fresh single-column FK without a declared index before creating either table', async () => {
		const pool = await getTestPool();
		const desired = model([
			table('fk_auto_index_refusal_parent', false),
			{
				...table('fk_auto_index_refusal_child', false),
				columns: [
					{ name: 'id', type: 'integer', nullable: false },
					{ name: 'parent_id', type: 'integer', nullable: false },
				],
				foreignKeys: [
					{
						columns: ['parent_id'],
						references: {
							table: 'fk_auto_index_refusal_parent',
							columns: ['id'],
						},
					},
				],
			},
		]);

		await expect(convergePg(pool, desired, { schema })).rejects.toMatchObject({
			refusal: 'unsupported-change',
			detail: expect.stringContaining(
				'fk_auto_index_refusal_child.parent_id (idx_fk_auto_index_refusal_child_parent_id)',
			),
		});
		for (const tableName of [
			'fk_auto_index_refusal_parent',
			'fk_auto_index_refusal_child',
		])
			await expect(
				pool.query('SELECT pg_catalog.to_regclass($1) AS relation', [
					`${schema}.${tableName}`,
				]),
			).resolves.toMatchObject({ rows: [{ relation: null }] });
	});

	it('refuses new-table children that target an existing managed table', async () => {
		const pool = await getTestPool();
		await expect(
			convergePg(pool, model([table('managed_parent', false)]), { schema }),
		).resolves.toMatchObject({ kind: 'applied' });
		const desired = model([
			{
				...table('managed_parent', false),
				indexes: [{ name: 'managed_parent_id_index', columns: ['id'] }],
				checkConstraints: [
					{ name: 'managed_parent_id_check', expression: 'id > 0' },
				],
			},
			{
				...table('new_child', false),
				columns: [
					{ name: 'id', type: 'integer', nullable: false },
					{ name: 'parent_id', type: 'integer', nullable: false },
				],
				foreignKeys: [
					{
						columns: ['parent_id'],
						references: { table: 'managed_parent', columns: ['id'] },
					},
				],
				indexes: [
					{ name: 'new_child_parent_id_index', columns: ['parent_id'] },
				],
				checkConstraints: [
					{ name: 'new_child_id_check', expression: 'id > 0' },
				],
			},
		]);
		await expect(convergePg(pool, desired, { schema })).rejects.toMatchObject({
			refusal: 'unsupported-change',
		});
		await expect(
			pool.query('SELECT pg_catalog.to_regclass($1) AS relation', [
				`${schema}.new_child`,
			]),
		).resolves.toMatchObject({ rows: [{ relation: null }] });
	});

	it('refuses a declared unmanaged sequence', async () => {
		const pool = await getTestPool();
		await pool.query(`CREATE SEQUENCE "${schema}"."unmanaged_sequence"`);
		await expect(
			convergePg(pool, model([], [{ name: 'unmanaged_sequence' }]), { schema }),
		).rejects.toMatchObject({ refusal: 'unmanaged-object' });
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

	it('refuses an absent schema ledger without creating relations', async () => {
		const absentLedgerSchema = `converge_absent_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
		const pool = await getTestPool();
		await createSchema(absentLedgerSchema);
		try {
			const relationCount = async () =>
				Number(
					(
						await pool.query(
							'SELECT count(*)::text AS count FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1',
							[absentLedgerSchema],
						)
					).rows[0]?.count,
				);
			const before = await relationCount();

			await expect(
				convergePg(pool, model([]), { schema: absentLedgerSchema }),
			).rejects.toMatchObject({
				refusal: 'ledger-absent',
			});
			expect(await relationCount()).toBe(before);
		} finally {
			await dropSchema(absentLedgerSchema);
		}
	});
});
