import {
	generatedPostconditionForChange,
	type SchemaChange,
	verifyGeneratedCheckPostcondition,
	verifyGeneratedIndexPostcondition,
	verifyGeneratedTablePostcondition,
	withGeneratedPostconditionSession,
} from '@dbsp/adapter-pgsql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireCatalogueColumnCapability } from './catalogue-matrix-capability.js';
import {
	matrixDatabaseConfig,
	requireMatrixDatabaseUrl,
} from './catalogue-matrix-config.js';
import { sessionWithPresentNull } from './catalogue-matrix-fault-session.js';
import {
	createOwnedMatrixSchema,
	dropOwnedMatrixSchema,
	newMatrixSchemaName,
	type OwnedMatrixSchema,
} from './catalogue-matrix-schema.js';
import { destroyMatrixClientOnAbort } from './catalogue-matrix-timeout.js';

const matrixConfig = matrixDatabaseConfig(process.env);
requireMatrixDatabaseUrl(matrixConfig);
const { databaseUrl: matrixDatabaseUrl } = matrixConfig;
const matrixDescribe =
	matrixDatabaseUrl === undefined ? describe.skip : describe;
const matrixSuiteName = matrixConfig.suiteName;
const schema = newMatrixSchemaName();
const table = 'catalogue_cases';
const index = 'catalogue_cases_positive_quantity_idx';
const check = 'catalogue_cases_quantity_check';
const connectionTimeoutMillis = 5_000;
const statementTimeoutMillis = 10_000;
const hookTimeoutMillis = 60_000;
const testTimeoutMillis = 150_000;

let matrixDatabaseName: string | undefined;

function matrixAddresses() {
	if (matrixDatabaseName === undefined)
		throw new Error('catalogue matrix database name is not ready');
	const tableAddress = {
		scope: 'schema' as const,
		engine: 'postgresql' as const,
		database: matrixDatabaseName,
		schema,
		kind: 'table' as const,
		name: table,
	};
	return {
		tableAddress,
		indexAddress: {
			...tableAddress,
			kind: 'index' as const,
			name: index,
			parent: tableAddress,
		},
		checkAddress: {
			...tableAddress,
			kind: 'constraint' as const,
			name: check,
			parent: tableAddress,
		},
	};
}

// The longest proof has 13 bounded statements (feature probe + 12 scratch
// statements) and two 5 s checkouts: 13 * 10 s + 2 * 5 s = 140 s < 150 s.
// beforeAll has 4 statements and 3 checkouts: 4 * 10 s + 3 * 5 s = 55 s < 60 s.

if (matrixDatabaseUrl === undefined)
	console.warn(
		'[catalogue-matrix] skipped: set a non-blank MATRIX_DATABASE_URL to run against PostgreSQL.',
	);

const tableShape = {
	name: table,
	columns: [
		{ name: 'id', type: 'integer', nullable: false },
		{ name: 'quantity', type: 'integer', nullable: false, default: 42 },
		{
			name: 'created_at',
			type: 'timestamptz',
			originalDbType: 'timestamp with time zone',
			nullable: false,
			default: { sql: 'now()' },
		},
		// #566: add a text default once its current canonicalization behavior lands.
	],
	foreignKeys: [],
	indexes: [],
};

const tableChange = {
	kind: 'create_table',
	table,
	destructive: false,
	details: 'catalogue matrix table',
	meta: { table: tableShape },
} satisfies SchemaChange;

const driftedTableChange = {
	kind: 'create_table',
	table,
	destructive: false,
	details: 'catalogue matrix drifted table expectation',
	meta: {
		table: {
			...tableShape,
			columns: [
				{ name: 'id', type: 'integer', nullable: false },
				{ name: 'quantity', type: 'integer', nullable: false, default: 7 },
				{
					name: 'created_at',
					type: 'timestamptz',
					originalDbType: 'timestamp with time zone',
					nullable: false,
					default: { sql: 'now()' },
				},
			],
		},
	},
} satisfies SchemaChange;

const indexChange = {
	kind: 'create_index',
	table,
	destructive: false,
	details: 'catalogue matrix partial index',
	meta: {
		index: {
			name: index,
			columns: ['quantity'],
			where: 'quantity > 0',
		},
	},
} satisfies SchemaChange;

const driftedIndexChange = {
	...indexChange,
	details: 'catalogue matrix drifted partial index expectation',
	meta: {
		index: {
			name: index,
			columns: ['id'],
			where: 'quantity > 0',
		},
	},
} satisfies SchemaChange;

const checkChange = {
	kind: 'add_check_constraint',
	table,
	destructive: false,
	details: 'catalogue matrix check constraint',
	meta: {
		check: { name: check, expression: 'CHECK (quantity >= 0)' },
	},
} satisfies SchemaChange;

const driftedCheckChange = {
	kind: 'add_check_constraint',
	table,
	destructive: false,
	details: 'catalogue matrix drifted check expectation',
	meta: {
		check: { name: check, expression: 'CHECK (quantity > 0)' },
	},
} satisfies SchemaChange;

function producedPostcondition(change: SchemaChange): unknown {
	const produced = generatedPostconditionForChange({ change, schema });
	if (produced === undefined)
		throw new Error(`matrix fixture has no postcondition for ${change.kind}`);
	return produced.value;
}

const tablePostcondition = producedPostcondition(tableChange);
const driftedTablePostcondition = producedPostcondition(driftedTableChange);
const indexPostcondition = producedPostcondition(indexChange);
const driftedIndexPostcondition = producedPostcondition(driftedIndexChange);
const checkPostcondition = producedPostcondition(checkChange);
const driftedCheckPostcondition = producedPostcondition(driftedCheckChange);

let pool: pg.Pool | undefined;
let ownedSchema: OwnedMatrixSchema | undefined;

function livePool(): pg.Pool {
	if (pool === undefined) throw new Error('catalogue matrix pool is not ready');
	return pool;
}

async function matrixPhase<T>(
	name: string,
	work: () => Promise<T>,
): Promise<T> {
	try {
		return await work();
	} catch (error) {
		throw new Error(`[catalogue-matrix] ${name} phase failed`, {
			cause: error,
		});
	}
}

async function catalogueColumnExistsWith(
	executor: Pick<pg.PoolClient, 'query'>,
	relation: 'pg_index' | 'pg_constraint',
	column: string,
): Promise<boolean> {
	const result = await executor.query<{ exists: unknown }>(
		`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = $1::pg_catalog.regclass AND attname = $2) AS exists`,
		[`pg_catalog.${relation}`, column],
	);
	return requireCatalogueColumnCapability(result.rows);
}

async function withMatrixClient<T>(
	signal: AbortSignal | undefined,
	work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
	const executor =
		signal === undefined
			? livePool()
			: destroyMatrixClientOnAbort(livePool(), signal);
	const client = (await executor.connect()) as pg.PoolClient;
	let failure: unknown;
	try {
		return await work(client);
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		if (failure === undefined) client.release();
		else
			client.release(
				failure instanceof Error
					? failure
					: new Error('catalogue matrix client work failed', {
							cause: failure,
						}),
			);
	}
}

function matrixProof(
	name: string,
	work: (signal: AbortSignal) => Promise<void>,
): void {
	it(name, async ({ signal }) => work(signal), testTimeoutMillis);
}

matrixDescribe(matrixSuiteName, () => {
	beforeAll(async () => {
		if (matrixDatabaseUrl === undefined)
			throw new Error('MATRIX_DATABASE_URL is required for this suite');
		pool = new pg.Pool({
			connectionString: matrixDatabaseUrl,
			connectionTimeoutMillis,
			query_timeout: statementTimeoutMillis,
			options: `-c statement_timeout=${statementTimeoutMillis}`,
		});
		await matrixPhase('connect', async () => {
			const client = await livePool().connect();
			try {
				const result = await client.query<{ database_name: unknown }>(
					'SELECT pg_catalog.current_database() AS database_name',
				);
				const databaseName = result.rows[0]?.database_name;
				if (typeof databaseName !== 'string' || databaseName.length === 0)
					throw new Error('current_database() did not return a database name');
				matrixDatabaseName = databaseName;
			} finally {
				client.release();
			}
		});
		ownedSchema = await matrixPhase('create schema', () =>
			createOwnedMatrixSchema(livePool(), schema),
		);
		await matrixPhase('fixtures', async () => {
			await withMatrixClient(undefined, async (client) => {
				await client.query(
					`CREATE TABLE ${schema}.${table} (id integer NOT NULL, quantity integer NOT NULL DEFAULT 42, created_at timestamptz NOT NULL DEFAULT now())`,
				);
				await client.query(
					`CREATE INDEX ${index} ON ${schema}.${table} (quantity) WHERE quantity > 0`,
				);
				await client.query(
					`ALTER TABLE ${schema}.${table} ADD CONSTRAINT ${check} CHECK (quantity >= 0)`,
				);
			});
		});
	}, hookTimeoutMillis);

	afterAll(async () => {
		if (pool === undefined) return;
		try {
			if (ownedSchema !== undefined)
				await matrixPhase('cleanup schema', () =>
					dropOwnedMatrixSchema(ownedSchema as OwnedMatrixSchema),
				);
		} finally {
			await pool.end();
			pool = undefined;
			ownedSchema = undefined;
		}
	}, hookTimeoutMillis);

	matrixProof(
		'fails a schema collision without deleting the schema created first',
		async () => {
			const collisionName = newMatrixSchemaName();
			const collision = await createOwnedMatrixSchema(
				livePool(),
				collisionName,
			);
			try {
				await expect(
					createOwnedMatrixSchema(livePool(), collisionName),
				).rejects.toThrow('already exists');
				expect(
					await livePool().query<{ exists: boolean }>(
						`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS exists`,
						[collisionName],
					),
				).toMatchObject({ rows: [{ exists: true }] });
			} finally {
				await dropOwnedMatrixSchema(collision);
			}
		},
	);

	matrixProof(
		'proves the generated table expectation through one checked-out live session',
		async (signal) => {
			// PostgreSQL 10: pg_index has no indnkeyatts, so the indnatts fallback is live.
			// PostgreSQL 11+: pg_index has indnkeyatts, so the key-column path is live.
			// PostgreSQL 10-14: pg_index lacks indnullsnotdistinct; absence defaults false.
			// PostgreSQL 15+: pg_index has indnullsnotdistinct; PostgreSQL 18 exercises it.
			// PostgreSQL 10-17: pg_constraint lacks conenforced; absence defaults true.
			// PostgreSQL 18+: pg_constraint has conenforced, exercised by this matrix.
			const verified = await withGeneratedPostconditionSession(
				destroyMatrixClientOnAbort(livePool(), signal),
				async (session) =>
					verifyGeneratedTablePostcondition({
						session,
						postcondition: tablePostcondition,
						address: matrixAddresses().tableAddress,
					}),
			);

			expect(verified.kind).toBe('table');
		},
	);

	matrixProof(
		'proves the generated index expectation through one checked-out live session',
		async (signal) => {
			const verified = await withGeneratedPostconditionSession(
				destroyMatrixClientOnAbort(livePool(), signal),
				(session) =>
					verifyGeneratedIndexPostcondition({
						session,
						postcondition: indexPostcondition,
						address: matrixAddresses().indexAddress,
					}),
			);
			expect(verified.kind).toBe('index');
		},
	);

	matrixProof(
		'proves the generated CHECK expectation through one checked-out live session',
		async (signal) => {
			const verified = await withGeneratedPostconditionSession(
				destroyMatrixClientOnAbort(livePool(), signal),
				(session) =>
					verifyGeneratedCheckPostcondition({
						session,
						postcondition: checkPostcondition,
						address: matrixAddresses().checkAddress,
					}),
			);
			expect(verified.kind).toBe('constraint');
		},
	);

	matrixProof(
		'refuses the producer-generated drifted table expectation live',
		async (signal) => {
			await expect(
				withGeneratedPostconditionSession(
					destroyMatrixClientOnAbort(livePool(), signal),
					(session) =>
						verifyGeneratedTablePostcondition({
							session,
							postcondition: driftedTablePostcondition,
							address: matrixAddresses().tableAddress,
						}),
				),
			).rejects.toThrow('postcondition differs');
		},
	);

	matrixProof(
		'refuses the producer-generated drifted index expectation live',
		async (signal) => {
			await expect(
				withGeneratedPostconditionSession(
					destroyMatrixClientOnAbort(livePool(), signal),
					(session) =>
						verifyGeneratedIndexPostcondition({
							session,
							postcondition: driftedIndexPostcondition,
							address: matrixAddresses().indexAddress,
						}),
				),
			).rejects.toThrow('postcondition differs');
		},
	);

	matrixProof(
		'refuses the producer-generated drifted CHECK expectation live',
		async (signal) => {
			await expect(
				withGeneratedPostconditionSession(
					destroyMatrixClientOnAbort(livePool(), signal),
					(session) =>
						verifyGeneratedCheckPostcondition({
							session,
							postcondition: driftedCheckPostcondition,
							address: matrixAddresses().checkAddress,
						}),
				),
			).rejects.toThrow('postcondition differs');
		},
	);

	matrixProof(
		'defaults an absent index feature and refuses a present NULL',
		async (signal) => {
			const indexLiveProjection = (sql: string) =>
				sql.includes('WHERE relation.oid = $1::pg_catalog.oid') &&
				sql.includes('index_relation.oid = $2::pg_catalog.oid');
			const exists = await withMatrixClient(signal, (client) =>
				catalogueColumnExistsWith(client, 'pg_index', 'indnullsnotdistinct'),
			);
			if (!exists) {
				expect(exists).toBe(false);
				return;
			}
			const fault = sessionWithPresentNull(
				destroyMatrixClientOnAbort(livePool(), signal),
				'nulls_not_distinct',
				indexLiveProjection,
			);
			await expect(
				withGeneratedPostconditionSession(fault, (session) =>
					verifyGeneratedIndexPostcondition({
						session,
						postcondition: indexPostcondition,
						address: matrixAddresses().indexAddress,
					}),
				),
			).rejects.toThrow('could not read a complete projection');
			fault.assertFiredOnce();
		},
	);

	matrixProof(
		'defaults an absent index key-count feature and refuses a present NULL',
		async (signal) => {
			const indexLiveProjection = (sql: string) =>
				sql.includes('WHERE relation.oid = $1::pg_catalog.oid') &&
				sql.includes('index_relation.oid = $2::pg_catalog.oid');
			const exists = await withMatrixClient(signal, (client) =>
				catalogueColumnExistsWith(client, 'pg_index', 'indnkeyatts'),
			);
			if (!exists) {
				expect(exists).toBe(false);
				return;
			}
			const fault = sessionWithPresentNull(
				destroyMatrixClientOnAbort(livePool(), signal),
				'key_count',
				indexLiveProjection,
			);
			await expect(
				withGeneratedPostconditionSession(fault, (session) =>
					verifyGeneratedIndexPostcondition({
						session,
						postcondition: indexPostcondition,
						address: matrixAddresses().indexAddress,
					}),
				),
			).rejects.toThrow('could not read a complete projection');
			fault.assertFiredOnce();
		},
	);

	matrixProof(
		'defaults an absent CHECK enforcement feature and refuses a present NULL',
		async (signal) => {
			const checkLiveProjection = (sql: string) =>
				sql.includes('WHERE constraint_item.oid = $1::pg_catalog.oid');
			const enforcedExists = await withMatrixClient(signal, (client) =>
				catalogueColumnExistsWith(client, 'pg_constraint', 'conenforced'),
			);
			if (!enforcedExists) {
				expect(enforcedExists).toBe(false);
				return;
			}
			const fault = sessionWithPresentNull(
				destroyMatrixClientOnAbort(livePool(), signal),
				'enforced',
				checkLiveProjection,
			);
			await expect(
				withGeneratedPostconditionSession(fault, (session) =>
					verifyGeneratedCheckPostcondition({
						session,
						postcondition: checkPostcondition,
						address: matrixAddresses().checkAddress,
					}),
				),
			).rejects.toThrow('could not read a complete projection');
			fault.assertFiredOnce();
		},
	);
});
