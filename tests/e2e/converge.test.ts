/** Live proof for the non-persisted, additive startup convergence entry point. */
import { randomUUID } from 'node:crypto';
import {
	appendIntentJournal,
	comparePgsqlDatabaseSchema,
	createPgsqlAdapter,
	createPgTransitionRunPersister,
	readPgLedgerAddressChain,
	reconcilePgTransitionRun,
} from '@dbsp/adapter-pgsql';
import {
	appendPgLedgerClaim,
	convergePg,
	PgConvergeRefusalError,
} from '@dbsp/adapter-pgsql/internal';
import {
	projectLedgerChain,
	semanticArtifactId,
	transitionPlanDigest,
} from '@dbsp/core';
import type {
	EnumIR,
	LedgerAddress,
	LedgerReservationRow,
	ModelIR,
	PhysicalOperation,
	ProvenPlanShape,
	SequenceIR,
	TableIR,
	TransitionRunMetadata,
} from '@dbsp/types';
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
	enums: readonly EnumIR[] = [],
): ModelIR {
	const byName = new Map(tables.map((table) => [table.name, table]));
	return {
		tables: byName,
		sequences: new Map(sequences.map((sequence) => [sequence.name, sequence])),
		...(enums.length === 0
			? {}
			: { enums: new Map(enums.map((enumDef) => [enumDef.name, enumDef])) }),
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

function legacyTable(name: string, adopt = true): TableIR {
	return {
		name,
		...(adopt ? { adopt: true as const } : {}),
		columns: [
			{ name: 'id', type: 'integer', nullable: false },
			{ name: 'code', type: 'integer', nullable: false },
		],
		primaryKey: 'id',
		foreignKeys: [],
		indexes: [{ name: `${name}_code_index`, columns: ['code'] }],
	};
}

function adoptedProjectTables(): readonly TableIR[] {
	return [
		{
			name: 'projects',
			adopt: true,
			columns: [{ name: 'id', type: 'integer', nullable: false }],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
		},
		{
			name: 'project_state',
			adopt: true,
			columns: [{ name: 'project_id', type: 'integer', nullable: false }],
			primaryKey: 'project_id',
			foreignKeys: [
				{
					columns: ['project_id'],
					references: { table: 'projects', columns: ['id'] },
				},
			],
			indexes: [],
		},
	];
}

function enumColumnTable(
	name: string,
	typeSchema: string,
	nullable = false,
	typeName = 'mood_819',
): TableIR {
	return {
		name,
		columns: [
			{ name: 'id', type: 'integer', nullable: false },
			{
				name: 'mood',
				type: 'string',
				nullable,
				originalDbType: typeName,
				originalDbTypeSchema: typeSchema,
				originalDbTypeSchemaScope: 'target',
			},
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
		await pool.query(
			`CREATE DOMAIN "${typesSchema}"."${domain}" AS integer CHECK (VALUE > 0)`,
		);
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

	it('adopts an exact unmanaged declared table without changing its OID', async () => {
		const pool = await getTestPool();
		const databaseId = await database();
		const name = 'legacy_items';
		await pool.query(
			`CREATE TABLE "${schema}"."${name}" ("id" integer NOT NULL PRIMARY KEY, "code" integer NOT NULL)`,
		);
		await pool.query(
			`CREATE INDEX "${name}_code_index" ON "${schema}"."${name}" ("code")`,
		);
		const oid = String(
			(
				await pool.query('SELECT $1::regclass::oid AS oid', [
					`${schema}.${name}`,
				])
			).rows[0]?.oid,
		);
		await expect(
			convergePg(pool, model([legacyTable(name, false)]), { schema }),
		).rejects.toMatchObject({
			refusal: 'unmanaged-object',
		});
		await expect(
			convergePg(pool, model([legacyTable(name)]), { schema }),
		).resolves.toMatchObject({
			kind: 'applied',
		});
		await expect(managed(address(databaseId, 'table', name))).resolves.toBe(
			true,
		);
		await expect(
			pool.query('SELECT $1::regclass::oid::text AS oid', [
				`${schema}.${name}`,
			]),
		).resolves.toMatchObject({ rows: [{ oid }] });
		await expect(
			convergePg(pool, model([legacyTable(name)]), { schema }),
		).resolves.toEqual({
			kind: 'no-drift',
			applied: [],
		});
	});

	it('adopts an advanced standalone sequence without changing its OID or value', async () => {
		const pool = await getTestPool();
		const databaseId = await database();
		const name = 'union_group_seq';
		const declared = { name, adopt: true as const };
		await pool.query(`CREATE SEQUENCE "${schema}"."${name}"`);
		await pool.query(`SELECT nextval('"${schema}"."${name}"')`);
		await pool.query(`SELECT nextval('"${schema}"."${name}"')`);
		await pool.query(`SELECT nextval('"${schema}"."${name}"')`);
		const oid = String(
			(await pool.query(`SELECT '"${schema}"."${name}"'::regclass::oid AS oid`))
				.rows[0]?.oid,
		);
		await expect(
			convergePg(pool, model([], [{ name }]), { schema }),
		).rejects.toMatchObject({
			refusal: 'unmanaged-object',
			detail: `converge refuses unmanaged live sequence ${name}`,
		});
		await expect(
			convergePg(pool, model([], [declared]), { schema }),
		).resolves.toEqual({
			kind: 'applied',
			applied: ['adopt_sequence'],
		});
		await expect(managed(address(databaseId, 'sequence', name))).resolves.toBe(
			true,
		);
		await expect(
			pool.query(`SELECT '"${schema}"."${name}"'::regclass::oid::text AS oid`),
		).resolves.toMatchObject({ rows: [{ oid }] });
		await expect(
			pool.query(`SELECT nextval('"${schema}"."${name}"')::text AS value`),
		).resolves.toMatchObject({ rows: [{ value: '4' }] });
		await expect(
			convergePg(pool, model([], [declared]), { schema }),
		).resolves.toEqual({
			kind: 'no-drift',
			applied: [],
		});
		await pool.query(`ALTER SEQUENCE "${schema}"."${name}" CACHE 2`);
		await expect(
			convergePg(pool, model([], [declared]), { schema }),
		).resolves.toEqual({
			kind: 'no-drift',
			applied: [],
		});
	});

	it('refuses sequence adoption for incompatible standalone and owned sequences', async () => {
		const pool = await getTestPool();
		const incrementName = 'sequence_adoption_increment';
		await pool.query(
			`CREATE SEQUENCE "${schema}"."${incrementName}" INCREMENT BY 2`,
		);
		await expect(
			convergePg(pool, model([], [{ name: incrementName, adopt: true }]), {
				schema,
			}),
		).rejects.toMatchObject({ refusal: 'adoption-refused' });
		await expect(
			managed(address(await database(), 'sequence', incrementName)),
		).resolves.toBe(false);

		const ownedName = 'sequence_adoption_owned';
		await pool.query(
			`CREATE TABLE "${schema}"."sequence_adoption_owner" ("id" integer); CREATE SEQUENCE "${schema}"."${ownedName}" OWNED BY "${schema}"."sequence_adoption_owner"."id"`,
		);
		await expect(
			convergePg(pool, model([], [{ name: ownedName, adopt: true }]), {
				schema,
			}),
		).rejects.toMatchObject({ refusal: 'adoption-refused' });

		await pool.query(
			`CREATE TABLE "${schema}"."sequence_adoption_identity" ("id" bigint GENERATED BY DEFAULT AS IDENTITY)`,
		);
		const identityName = String(
			(
				await pool.query(
					`SELECT pg_get_serial_sequence('"${schema}"."sequence_adoption_identity"', 'id') AS name`,
				)
			).rows[0]?.name,
		)
			.split('.')
			.at(-1)!
			.replaceAll('"', '');
		await expect(
			convergePg(pool, model([], [{ name: identityName, adopt: true }]), {
				schema,
			}),
		).rejects.toMatchObject({ refusal: 'adoption-refused' });
	});

	it('adopts a camelCase sequence at its snake_case physical name', async () => {
		const pool = await getTestPool();
		const databaseId = await database();
		const logicalName = 'camelCaseSequence';
		const physicalName = 'camel_case_sequence';
		await pool.query(`CREATE SEQUENCE "${schema}"."${physicalName}"`);
		await expect(
			convergePg(pool, model([], [{ name: logicalName, adopt: true }]), {
				schema,
				dbCasing: 'snake_case',
			}),
		).resolves.toMatchObject({ kind: 'applied', applied: ['adopt_sequence'] });
		await expect(
			managed(address(databaseId, 'sequence', physicalName)),
		).resolves.toBe(true);
		await expect(
			convergePg(pool, model([], [{ name: logicalName }]), {
				schema,
				dbCasing: 'snake_case',
			}),
		).resolves.toEqual({ kind: 'no-drift', applied: [] });
	});

	it('adopts foreign-key-linked declared tables and converges them without drift', async () => {
		const pool = await getTestPool();
		const databaseId = await database();
		await pool.query(
			`CREATE TABLE "${schema}"."projects" ("id" integer PRIMARY KEY); CREATE TABLE "${schema}"."project_state" ("project_id" integer PRIMARY KEY REFERENCES "${schema}"."projects"("id"))`,
		);
		const desired = model(adoptedProjectTables());

		await expect(convergePg(pool, desired, { schema })).resolves.toEqual({
			kind: 'applied',
			applied: ['adopt_table', 'adopt_table'],
		});
		await expect(
			managed(address(databaseId, 'table', 'projects')),
		).resolves.toBe(true);
		await expect(
			managed(address(databaseId, 'table', 'project_state')),
		).resolves.toBe(true);
		await expect(convergePg(pool, desired, { schema })).resolves.toEqual({
			kind: 'no-drift',
			applied: [],
		});
	});

	it('refuses a dropped and recreated managed declared adoption during planning', async () => {
		const pool = await getTestPool();
		const name = 'legacy_replaced_after_management';
		await pool.query(
			`CREATE TABLE "${schema}"."${name}" ("id" integer NOT NULL PRIMARY KEY, "code" integer NOT NULL)`,
		);
		await pool.query(
			`CREATE INDEX "${name}_code_index" ON "${schema}"."${name}" ("code")`,
		);
		await expect(
			convergePg(pool, model([legacyTable(name)]), { schema }),
		).resolves.toMatchObject({ kind: 'applied' });
		await pool.query(`DROP TABLE "${schema}"."${name}"`);
		await pool.query(
			`CREATE TABLE "${schema}"."${name}" ("id" integer NOT NULL PRIMARY KEY, "code" integer NOT NULL)`,
		);
		await pool.query(
			`CREATE INDEX "${name}_code_index" ON "${schema}"."${name}" ("code")`,
		);

		for (let attempt = 0; attempt < 2; attempt += 1)
			await expect(
				convergePg(pool, model([legacyTable(name)]), { schema }),
			).rejects.toMatchObject({ refusal: 'adoption-refused' });
	});

	it('refuses an absent declared adoption without recording a ledger terminal', async () => {
		const pool = await getTestPool();
		const name = 'legacy_absent';
		await expect(
			convergePg(pool, model([legacyTable(name)]), { schema }),
		).rejects.toMatchObject({
			refusal: 'adoption-refused',
		});
		await expect(
			pool.query('SELECT to_regclass($1) AS relation', [`${schema}.${name}`]),
		).resolves.toMatchObject({ rows: [{ relation: null }] });
		await expect(
			pool.query(
				`SELECT count(*)::int AS count FROM "${schema}".dbsp_ledger_event WHERE address_kind = 'table' AND address_name = $1`,
				[name],
			),
		).resolves.toMatchObject({ rows: [{ count: 0 }] });
	});

	it('refuses a declared adoption with a missing live column before DDL', async () => {
		const pool = await getTestPool();
		const name = 'legacy_missing_column';
		await pool.query(
			`CREATE TABLE "${schema}"."${name}" ("id" integer NOT NULL PRIMARY KEY)`,
		);
		await expect(
			convergePg(pool, model([legacyTable(name)]), { schema }),
		).rejects.toMatchObject({
			refusal: 'adoption-refused',
		});
		await expect(
			pool.query(
				'SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3',
				[schema, name, 'code'],
			),
		).resolves.toMatchObject({ rows: [{ count: 0 }] });
	});

	it('adopts a PostgreSQL-canonicalized bigint default', async () => {
		const pool = await getTestPool();
		const databaseId = await database();
		const name = 'legacy_default';
		await pool.query(
			`CREATE TABLE "${schema}"."${name}" ("id" integer NOT NULL PRIMARY KEY, "count" bigint NOT NULL DEFAULT 0)`,
		);
		const desired: TableIR = {
			name,
			adopt: true,
			columns: [
				{ name: 'id', type: 'integer', nullable: false },
				{
					name: 'count',
					type: 'bigint',
					nullable: false,
					default: { sql: '0' },
				},
			],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
		};
		await expect(
			convergePg(pool, model([desired]), { schema }),
		).resolves.toMatchObject({ kind: 'applied' });
		await expect(managed(address(databaseId, 'table', name))).resolves.toBe(
			true,
		);
	});

	it('masks a caller-named external index while adopting', async () => {
		const pool = await getTestPool();
		const databaseId = await database();
		const name = 'legacy_external_index';
		await pool.query(
			`CREATE TABLE "${schema}"."${name}" ("id" integer NOT NULL PRIMARY KEY, "code" integer NOT NULL)`,
		);
		await pool.query(
			`CREATE INDEX "${name}_extra_index" ON "${schema}"."${name}" ("code")`,
		);
		const desired = { ...legacyTable(name), indexes: [] };
		await expect(
			convergePg(pool, model([desired]), {
				schema,
				externalIndexes: [{ table: name, name: `${name}_extra_index` }],
			}),
		).resolves.toMatchObject({ kind: 'applied' });
		await expect(managed(address(databaseId, 'table', name))).resolves.toBe(
			true,
		);
	});

	it('uses the physical snake_case table address for adoption', async () => {
		const pool = await getTestPool();
		const databaseId = await database();
		await pool.query(
			`CREATE TABLE "${schema}"."legacy_orders" ("id" integer NOT NULL PRIMARY KEY, "code" integer NOT NULL)`,
		);
		await pool.query(
			`CREATE INDEX "legacy_orders_code_index" ON "${schema}"."legacy_orders" ("code")`,
		);
		await expect(
			convergePg(pool, model([legacyTable('legacyOrders')]), {
				schema,
				dbCasing: 'snake_case',
			}),
		).resolves.toMatchObject({ kind: 'applied' });
		await expect(
			managed(address(databaseId, 'table', 'legacy_orders')),
		).resolves.toBe(true);
	});

	it('refuses a snake_case declared adoption mismatch without a ledger row or DDL', async () => {
		const pool = await getTestPool();
		await pool.query(
			`CREATE TABLE "${schema}"."legacy_shipments" ("id" integer NOT NULL PRIMARY KEY)`,
		);
		const desired = { ...legacyTable('legacyShipments'), indexes: [] };
		await expect(
			convergePg(pool, model([desired]), {
				schema,
				dbCasing: 'snake_case',
			}),
		).rejects.toMatchObject({ refusal: 'adoption-refused' });
		await expect(
			pool.query(
				`SELECT count(*)::int AS count FROM "${schema}".dbsp_ledger_event WHERE address_kind = 'table' AND address_name = $1`,
				['legacy_shipments'],
			),
		).resolves.toMatchObject({ rows: [{ count: 0 }] });
		await expect(
			pool.query(
				'SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3',
				[schema, 'legacy_shipments', 'code'],
			),
		).resolves.toMatchObject({ rows: [{ count: 0 }] });
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

	it('rolls back a fresh table and its colliding index as one converge transaction', async () => {
		const pool = await getTestPool();
		const databaseId = await database();
		const desired = model([
			{
				name: 'atomic_parent',
				columns: [
					{ name: 'id', type: 'integer', nullable: false },
					{ name: 'code', type: 'integer', nullable: false },
				],
				primaryKey: 'id',
				foreignKeys: [],
				indexes: [{ name: 'atomic_collision', columns: ['code'] }],
			},
		]);
		const parent = address(databaseId, 'table', 'atomic_parent');
		const index = address(databaseId, 'index', 'atomic_collision', parent);
		await pool.query(
			`CREATE VIEW "${schema}"."atomic_collision" AS SELECT 1 AS one`,
		);

		await expect(convergePg(pool, desired, { schema })).rejects.toMatchObject({
			name: 'PgConvergeRefusalError',
			refusal: 'execution-refused',
			message: expect.stringContaining('already exists'),
		});
		await expect(
			pool.query('SELECT pg_catalog.to_regclass($1) AS relation', [
				`${schema}.atomic_parent`,
			]),
		).resolves.toMatchObject({ rows: [{ relation: null }] });
		await expect(managed(parent)).resolves.toBe(false);
		await expect(
			pool.query(
				`SELECT count(*)::int AS count FROM "${schema}"."dbsp_ledger_reservation" WHERE address_name = $1`,
				['atomic_parent'],
			),
		).resolves.toMatchObject({ rows: [{ count: 0 }] });

		await pool.query(`DROP VIEW "${schema}"."atomic_collision"`);
		await expect(convergePg(pool, desired, { schema })).resolves.toEqual({
			kind: 'applied',
			applied: ['create_table', 'create_index'],
		});
		await expect(
			pool.query('SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists', [
				`${schema}.atomic_parent`,
			]),
		).resolves.toMatchObject({ rows: [{ exists: true }] });
		await expect(
			pool.query('SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists', [
				`${schema}.atomic_collision`,
			]),
		).resolves.toMatchObject({ rows: [{ exists: true }] });
		await expect(managed(parent)).resolves.toBe(true);
		await expect(managed(index)).resolves.toBe(true);
	});

	it('requires reconciliation of a seeded predecessor claim before convergence', async () => {
		const pool = await getTestPool();
		const databaseId = await database();
		const runId = `converge-predecessor-${randomUUID()}`;
		const claimId = `${runId}:claim`;
		const plannedClaimKey = 'converge-predecessor:0';
		const openAddress = address(
			databaseId,
			'table',
			'predecessor_gate_fixture',
		);
		const plan = {
			observations: [],
			claims: [],
			assumptions: [],
			preconditions: [],
			segments: [],
			steps: [
				{
					address: openAddress,
					plannedClaimKeys: [plannedClaimKey],
				},
			],
			postconditions: [],
		} as unknown as ProvenPlanShape;
		const run: TransitionRunMetadata = {
			runId,
			planDigest: transitionPlanDigest(plan),
			targetContextDigest: 'converge-predecessor-e2e',
			databaseId,
			coreVersion: 'converge-predecessor-e2e',
			startedAt: new Date().toISOString(),
			replayability: 'replayable',
		};
		const operation: PhysicalOperation = {
			ref: 'postgresql:converge-predecessor-e2e',
			operationKind: {
				artifact: { id: semanticArtifactId('dbsp.e2e'), version: '1' },
				name: 'ConvergePredecessorE2e',
			},
			payload: {},
		};
		const reservation: LedgerReservationRow = {
			address: openAddress,
			claimKind: 'intent',
			executionId: runId,
			rootClaimId: claimId,
			homeLedger: { scope: 'schema', schema },
		};

		await createPgTransitionRunPersister(pool).persist(run, plan);
		await appendIntentJournal(pool, {
			runId,
			run,
			stepId: plannedClaimKey,
			operation,
			recordedAt: new Date().toISOString(),
		});
		await appendPgLedgerClaim(
			pool,
			{ scope: 'schema', schema },
			{
				eventId: claimId,
				eventKind: 'intent',
				address: openAddress,
				executionId: runId,
				rootClaimId: claimId,
				plannedClaimKey,
			},
			[reservation],
		);

		await expect(convergePg(pool, model([]), { schema })).rejects.toMatchObject(
			{
				refusal: 'recovery-required',
				runIds: [runId],
			},
		);
		await expect(reconcilePgTransitionRun(pool, runId)).resolves.toMatchObject({
			kind: 'completed',
			runId,
		});
		await expect(convergePg(pool, model([]), { schema })).resolves.toEqual({
			kind: 'no-drift',
			applied: [],
		});
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

	it('converges a declared enum column when the target schema is off search_path', async () => {
		const dedicatedPool = new pg.Pool({
			connectionString: process.env.DATABASE_URL!,
			options: '-c search_path=pg_catalog',
		});
		const name = 'mood_819_items';
		const typeName = 'mood_819_scalar';
		const desired = model(
			[enumColumnTable(name, schema, false, typeName)],
			[],
			[{ name: typeName, values: ['calm', 'busy'] }],
		);
		try {
			await dedicatedPool.query(
				`CREATE TYPE "${schema}"."${typeName}" AS ENUM ('calm', 'busy')`,
			);
			await expect(
				convergePg(dedicatedPool, desired, { schema }),
			).resolves.toMatchObject({
				kind: 'applied',
			});
			const databaseId = await database();
			const tableAddress = address(databaseId, 'table', name);
			await expect(managed(tableAddress)).resolves.toBe(true);
			await expect(
				convergePg(dedicatedPool, desired, { schema }),
			).resolves.toEqual({
				kind: 'no-drift',
				applied: [],
			});
			const { changes } = await comparePgsqlDatabaseSchema(
				createPgsqlAdapter(dedicatedPool),
				desired,
				{ schema },
			);
			expect(changes.filter((change) => change.table === name)).toEqual([]);
		} finally {
			await dedicatedPool.end();
		}
	});

	it('converges an undeclared enum column when the target schema is off search_path', async () => {
		const dedicatedPool = new pg.Pool({
			connectionString: process.env.DATABASE_URL!,
			options: '-c search_path=pg_catalog',
		});
		const name = 'undeclared_mood_819_items';
		const typeName = 'mood_819_undeclared';
		const desired = model([enumColumnTable(name, schema, false, typeName)]);
		try {
			await dedicatedPool.query(
				`CREATE TYPE "${schema}"."${typeName}" AS ENUM ('calm', 'busy')`,
			);
			await expect(
				convergePg(dedicatedPool, desired, { schema }),
			).resolves.toMatchObject({
				kind: 'applied',
			});
			await expect(
				convergePg(dedicatedPool, desired, { schema }),
			).resolves.toEqual({
				kind: 'no-drift',
				applied: [],
			});
			const { changes } = await comparePgsqlDatabaseSchema(
				createPgsqlAdapter(dedicatedPool),
				desired,
				{ schema },
			);
			expect(changes.filter((change) => change.table === name)).toEqual([]);
		} finally {
			await dedicatedPool.end();
		}
	});

	it('converges a declared enum array column when the target schema is off search_path', async () => {
		const dedicatedPool = new pg.Pool({
			connectionString: process.env.DATABASE_URL!,
			options: '-c search_path=pg_catalog',
		});
		const name = 'mood_819_array_items';
		const desired = model(
			[enumColumnTable(name, schema, false, 'mood_819[]')],
			[],
			[{ name: 'mood_819', values: ['calm', 'busy'] }],
		);
		try {
			await dedicatedPool.query(
				`CREATE TYPE "${schema}"."mood_819" AS ENUM ('calm', 'busy')`,
			);
			await expect(
				convergePg(dedicatedPool, desired, { schema }),
			).resolves.toMatchObject({ kind: 'applied' });
			await expect(
				convergePg(dedicatedPool, desired, { schema }),
			).resolves.toEqual({ kind: 'no-drift', applied: [] });
		} finally {
			await dedicatedPool.end();
		}
	});

	it('refuses adding a nullable enum column whose type names the target schema', async () => {
		const pool = await getTestPool();
		const databaseId = await database();
		const name = 'add_mood_819_items';
		const typeName = 'mood_819_nullable';
		const initial = model([
			{
				name,
				columns: [{ name: 'id', type: 'integer', nullable: false }],
				primaryKey: 'id',
				foreignKeys: [],
				indexes: [],
			},
		]);
		const desired = model([enumColumnTable(name, schema, true, typeName)]);
		await pool.query(
			`CREATE TYPE "${schema}"."${typeName}" AS ENUM ('calm', 'busy')`,
		);
		await expect(convergePg(pool, initial, { schema })).resolves.toMatchObject({
			kind: 'applied',
		});
		await expect(convergePg(pool, desired, { schema })).rejects.toMatchObject({
			refusal: 'unsupported-change',
		});
		await expect(
			pool.query(
				'SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3',
				[schema, name, 'mood'],
			),
		).resolves.toMatchObject({ rows: [{ count: 0 }] });
		const tableAddress = address(databaseId, 'table', name);
		const chain = await readPgLedgerAddressChain(
			pool,
			{ scope: 'schema', schema },
			address(databaseId, 'column', 'mood', tableAddress),
		);
		expect(chain.events).toEqual([]);
	});

	it('converges a mixed-case enum schema when it is off search_path', async () => {
		const mixedSchema = `Mixed_Case_819_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
		const name = 'mixed_mood_819_items';
		const dedicatedPool = new pg.Pool({
			connectionString: process.env.DATABASE_URL!,
			options: '-c search_path=pg_catalog',
		});
		let createdMixedSchema = false;
		const desired = model(
			[enumColumnTable(name, mixedSchema)],
			[],
			[{ name: 'mood_819', values: ['calm', 'busy'] }],
		);
		try {
			await dedicatedPool.query(`CREATE SCHEMA "${mixedSchema}"`);
			createdMixedSchema = true;
			await runPreflight([mixedSchema], { writeAdoptionFile: async () => {} });
			await dedicatedPool.query(
				`CREATE TYPE "${mixedSchema}"."mood_819" AS ENUM ('calm', 'busy')`,
			);
			await expect(
				convergePg(dedicatedPool, desired, { schema: mixedSchema }),
			).resolves.toMatchObject({ kind: 'applied' });
			await expect(
				convergePg(dedicatedPool, desired, { schema: mixedSchema }),
			).resolves.toEqual({ kind: 'no-drift', applied: [] });
			const { changes } = await comparePgsqlDatabaseSchema(
				createPgsqlAdapter(dedicatedPool),
				desired,
				{ schema: mixedSchema },
			);
			expect(changes.filter((change) => change.table === name)).toEqual([]);
		} finally {
			await dedicatedPool.end();
			if (createdMixedSchema) await dropSchema(mixedSchema);
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

	it('converges a camelCase declared sequence to its snake_case ledger address', async () => {
		const pool = await getTestPool();
		const databaseId = await database();
		const desired = model([], [{ name: 'orderNumberSeq' }]);

		await expect(
			convergePg(pool, desired, { schema, dbCasing: 'snake_case' }),
		).resolves.toMatchObject({ kind: 'applied' });
		await expect(
			convergePg(pool, desired, { schema, dbCasing: 'snake_case' }),
		).resolves.toEqual({ kind: 'no-drift', applied: [] });
		await expect(
			pool.query('SELECT pg_catalog.to_regclass($1) AS relation', [
				`${schema}.order_number_seq`,
			]),
		).resolves.toMatchObject({
			rows: [{ relation: `${schema}.order_number_seq` }],
		});
		await expect(
			managed(address(databaseId, 'sequence', 'order_number_seq')),
		).resolves.toBe(true);
	});

	it('refuses a legacy raw sequence instead of creating a second snake_case counter', async () => {
		const pool = await getTestPool();
		const desired = model([], [{ name: 'invoiceNumberSeq' }]);
		await pool.query(`CREATE SEQUENCE "${schema}"."invoiceNumberSeq"`);

		await expect(
			convergePg(pool, desired, { schema, dbCasing: 'snake_case' }),
		).rejects.toThrow(
			`ALTER SEQUENCE "${schema}"."invoiceNumberSeq" RENAME TO "invoice_number_seq"`,
		);
		await expect(
			pool.query('SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present', [
				`"${schema}"."invoiceNumberSeq"`,
			]),
		).resolves.toMatchObject({ rows: [{ present: true }] });
		await expect(
			pool.query('SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present', [
				`"${schema}"."invoice_number_seq"`,
			]),
		).resolves.toMatchObject({ rows: [{ present: false }] });
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

	it('ignores an undeclared live enum while creating a declared table', async () => {
		const pool = await getTestPool();
		const databaseId = await database();
		await pool.query(
			`CREATE TYPE "${schema}"."unrelated_mood" AS ENUM ('calm', 'busy')`,
		);

		await expect(
			convergePg(pool, model([table('enum_scope_items', false)]), { schema }),
		).resolves.toMatchObject({ kind: 'applied' });
		await expect(
			managed(address(databaseId, 'table', 'enum_scope_items')),
		).resolves.toBe(true);
		await expect(
			pool.query('SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists', [
				`${schema}.enum_scope_items`,
			]),
		).resolves.toMatchObject({ rows: [{ exists: true }] });
		await expect(
			pool.query(
				'SELECT enum.enumlabel FROM pg_catalog.pg_enum enum JOIN pg_catalog.pg_type type ON type.oid = enum.enumtypid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = type.typnamespace WHERE namespace.nspname = $1 AND type.typname = $2 ORDER BY enum.enumsortorder',
				[schema, 'unrelated_mood'],
			),
		).resolves.toMatchObject({
			rows: [{ enumlabel: 'calm' }, { enumlabel: 'busy' }],
		});
		await expect(
			convergePg(pool, model([table('enum_scope_items', false)]), { schema }),
		).resolves.toEqual({ kind: 'no-drift', applied: [] });
	});

	it('refuses declared enum label differences', async () => {
		const pool = await getTestPool();
		await pool.query(
			`CREATE TYPE "${schema}"."declared_mood" AS ENUM ('calm', 'busy')`,
		);

		await expect(
			convergePg(
				pool,
				model([], [], [{ name: 'declared_mood', values: ['calm'] }]),
				{ schema },
			),
		).rejects.toMatchObject({
			refusal: 'unsupported-change',
			detail: expect.stringContaining('drop_enum'),
		});
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

	it('leaves a caller-named external index in place and otherwise still refuses it', async () => {
		const pool = await getTestPool();
		const name = 'external_index_no_drift_fixture';
		const index = 'idx_external_index_no_drift';
		const desired = model([table(name, false)]);
		await expect(convergePg(pool, desired, { schema })).resolves.toMatchObject({
			kind: 'applied',
		});
		await pool.query(
			`CREATE INDEX "${index}" ON "${schema}"."${name}" ("id") WHERE "id" > 0`,
		);

		await expect(convergePg(pool, desired, { schema })).rejects.toMatchObject({
			refusal: 'unsupported-change',
		});
		const externalOptions = {
			schema,
			externalIndexes: [{ table: name, name: index }],
		};
		await expect(convergePg(pool, desired, externalOptions)).resolves.toEqual({
			kind: 'no-drift',
			applied: [],
		});
		await expect(
			pool.query(
				'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname = $3) AS exists',
				[schema, name, index],
			),
		).resolves.toMatchObject({ rows: [{ exists: true }] });
	});

	it('applies a declared nullable column without dropping a caller-named external index', async () => {
		const pool = await getTestPool();
		const name = 'external_index_add_column_fixture';
		const index = 'idx_external_index_add_column';
		await expect(
			convergePg(pool, model([table(name, false)]), { schema }),
		).resolves.toMatchObject({ kind: 'applied' });
		await pool.query(
			`CREATE INDEX "${index}" ON "${schema}"."${name}" ("id") WHERE "id" > 0`,
		);
		const externalOptions = {
			schema,
			externalIndexes: [{ table: name, name: index }],
		};

		await expect(
			convergePg(pool, model([table(name)]), externalOptions),
		).resolves.toEqual({ kind: 'applied', applied: ['add_column'] });
		await expect(
			pool.query(
				'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname = $3) AS exists',
				[schema, name, index],
			),
		).resolves.toMatchObject({ rows: [{ exists: true }] });
	});

	it('refuses when an undeclared index remains after masking only the caller-named one', async () => {
		const pool = await getTestPool();
		const name = 'external_index_remaining_fixture';
		const external = 'idx_external_index_named';
		const remaining = 'idx_external_index_remaining';
		const desired = model([table(name, false)]);
		await expect(convergePg(pool, desired, { schema })).resolves.toMatchObject({
			kind: 'applied',
		});
		for (const index of [external, remaining]) {
			await pool.query(
				`CREATE INDEX "${index}" ON "${schema}"."${name}" ("id") WHERE "id" > 0`,
			);
		}
		const externalOptions = {
			schema,
			externalIndexes: [{ table: name, name: external }],
		};

		await expect(
			convergePg(pool, desired, externalOptions),
		).rejects.toMatchObject({
			refusal: 'unsupported-change',
			changes: [expect.objectContaining({ kind: 'drop_index' })],
		});
		for (const index of [external, remaining]) {
			await expect(
				pool.query(
					'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname = $3) AS exists',
					[schema, name, index],
				),
			).resolves.toMatchObject({ rows: [{ exists: true }] });
		}
	});

	it('refuses a defaulted constrained-domain column on a populated managed table', async () => {
		const dedicatedPool = new pg.Pool({
			connectionString: process.env.DATABASE_URL!,
			options: `-c search_path=${typesSearchPath}`,
		});
		const name = 'defaulted_domain_fixture';
		try {
			await expect(
				convergePg(dedicatedPool, model([table(name, false)]), { schema }),
			).resolves.toMatchObject({ kind: 'applied' });
			await dedicatedPool.query(
				`INSERT INTO "${schema}"."${name}" ("id") VALUES (1)`,
			);

			await expect(
				convergePg(
					dedicatedPool,
					model([
						{
							...table(name, false),
							columns: [
								{ name: 'id', type: 'integer', nullable: false },
								{
									name: 'value',
									type: 'integer',
									nullable: false,
									originalDbType: domain,
									default: 1,
								},
							],
						},
					]),
					{ schema },
				),
			).rejects.toMatchObject({ refusal: 'unsupported-change' });
			await expect(
				dedicatedPool.query(
					'SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3) AS exists',
					[schema, name, 'value'],
				),
			).resolves.toMatchObject({ rows: [{ exists: false }] });
		} finally {
			await dedicatedPool.end();
		}
	});

	it('adds astix-style NOT NULL literal-default columns to a populated managed table without a rewrite', async () => {
		const pool = await getTestPool();
		const databaseId = await database();
		const name = 'literal_default_columns_fixture';
		const columns = [
			{ name: 'is_primary', type: 'boolean', nullable: false, default: false },
			{
				name: 'coverage_epoch',
				type: 'bigint',
				nullable: false,
				js: 'bigint',
				originalDbType: 'BIGINT',
				default: '0',
			},
			{
				name: 'file_state_version',
				type: 'bigint',
				nullable: false,
				js: 'bigint',
				originalDbType: 'BIGINT',
				default: '0',
			},
			{ name: 'is_test', type: 'boolean', nullable: false, default: false },
			{
				name: 'description_stale',
				type: 'boolean',
				nullable: false,
				default: false,
			},
			{
				name: 'call_kind',
				type: 'string',
				nullable: false,
				default: 'unknown',
			},
			{
				name: 'resolution_status',
				type: 'string',
				nullable: false,
				default: 'pending',
			},
		] satisfies TableIR['columns'];

		await expect(
			convergePg(pool, model([table(name, false)]), { schema }),
		).resolves.toMatchObject({ kind: 'applied' });
		await pool.query(`INSERT INTO "${schema}"."${name}" ("id") VALUES (1)`);
		await expect(
			convergePg(
				pool,
				model([
					{
						...table(name, false),
						columns: [
							{ name: 'id', type: 'integer', nullable: false },
							...columns,
						],
					},
				]),
				{ schema },
			),
		).resolves.toMatchObject({ kind: 'applied' });

		const nullability = await pool.query<{
			column_name: string;
			is_nullable: string;
		}>(
			'SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = ANY($3)',
			[schema, name, columns.map((column) => column.name)],
		);
		expect(nullability.rows).toHaveLength(columns.length);
		expect(nullability.rows).toEqual(
			expect.arrayContaining(
				columns.map((column) => ({
					column_name: column.name,
					is_nullable: 'NO',
				})),
			),
		);
		await expect(
			pool.query(
				`SELECT "is_primary", "coverage_epoch"::text, "file_state_version"::text, "is_test", "description_stale", "call_kind", "resolution_status" FROM "${schema}"."${name}" WHERE "id" = 1`,
			),
		).resolves.toMatchObject({
			rows: [
				{
					is_primary: false,
					coverage_epoch: '0',
					file_state_version: '0',
					is_test: false,
					description_stale: false,
					call_kind: 'unknown',
					resolution_status: 'pending',
				},
			],
		});
		await expect(
			pool.query(
				'SELECT attribute.attname AS column_name, attribute.atthasmissing FROM pg_catalog.pg_attribute attribute JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = $2 AND attribute.attname = ANY($3) AND NOT attribute.attisdropped',
				[schema, name, columns.map((column) => column.name)],
			),
		).resolves.toMatchObject({
			rows: expect.arrayContaining(
				columns.map((column) => ({
					column_name: column.name,
					atthasmissing: true,
				})),
			),
		});
		const root = address(databaseId, 'table', name);
		for (const column of columns)
			await expect(
				managed(address(databaseId, 'column', column.name, root)),
			).resolves.toBe(true);
		await expect(
			convergePg(
				pool,
				model([
					{
						...table(name, false),
						columns: [
							{ name: 'id', type: 'integer', nullable: false },
							...columns,
						],
					},
				]),
				{ schema },
			),
		).resolves.toEqual({ kind: 'no-drift', applied: [] });
	});

	it('adds a string literal default containing quotes and backslashes intact', async () => {
		const pool = await getTestPool();
		const name = 'escaped_default_fixture';
		const value = "O'Reilly\\backslash";
		await expect(
			convergePg(pool, model([table(name, false)]), { schema }),
		).resolves.toMatchObject({ kind: 'applied' });
		await pool.query(`INSERT INTO "${schema}"."${name}" ("id") VALUES (1)`);
		await expect(
			convergePg(
				pool,
				model([
					{
						...table(name, false),
						columns: [
							{ name: 'id', type: 'integer', nullable: false },
							{
								name: 'escaped_default',
								type: 'string',
								nullable: false,
								default: value,
							},
						],
					},
				]),
				{ schema },
			),
		).resolves.toMatchObject({ kind: 'applied' });
		await expect(
			pool.query(
				`SELECT "escaped_default" FROM "${schema}"."${name}" WHERE "id" = 1`,
			),
		).resolves.toMatchObject({ rows: [{ escaped_default: value }] });
	});

	it.each([
		[
			'not-null column without a default',
			{ name: 'missing_default', type: 'string', nullable: false },
		],
		[
			'function-like default',
			{
				name: 'function_default',
				type: 'string',
				nullable: false,
				default: 'now()',
			},
		],
	] satisfies readonly [string, TableIR['columns'][number]][])(
		'refuses a %s without adding it',
		async (_kind, column) => {
			const pool = await getTestPool();
			const name = `refused_${column.name}_fixture`;
			await expect(
				convergePg(pool, model([table(name, false)]), { schema }),
			).resolves.toMatchObject({ kind: 'applied' });
			await expect(
				convergePg(
					pool,
					model([
						{
							...table(name, false),
							columns: [
								{ name: 'id', type: 'integer', nullable: false },
								column,
							],
						},
					]),
					{ schema },
				),
			).rejects.toBeInstanceOf(PgConvergeRefusalError);
			await expect(
				pool.query(
					'SELECT count(*)::text AS count FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3',
					[schema, name, column.name],
				),
			).resolves.toMatchObject({ rows: [{ count: '0' }] });
		},
	);

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
