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
import {
	matrixDatabaseConfig,
	requireMatrixDatabaseUrl,
} from './catalogue-matrix-config.js';
import {
	createOwnedMatrixSchema,
	dropOwnedMatrixSchema,
	newMatrixSchemaName,
	type OwnedMatrixSchema,
} from './catalogue-matrix-schema.js';

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
const hookTimeoutMillis = 20_000;

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

function sessionWithPresentNull(
	field: string,
	isLiveProjection: (sql: string) => boolean,
) {
	return {
		async connect() {
			const client = await livePool().connect();
			return {
				async query(sql: string, params?: readonly unknown[]) {
					const result = await client.query(
						sql,
						params === undefined ? undefined : [...params],
					);
					if (!isLiveProjection(sql)) return { rows: result.rows };
					return {
						rows: result.rows.map((row) => ({ ...row, [field]: null })),
					};
				},
				release: () => client.release(),
			};
		},
	};
}

async function catalogueColumnExists(
	relation: 'pg_index' | 'pg_constraint',
	column: string,
): Promise<boolean> {
	const result = await livePool().query<{ exists: boolean }>(
		`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = $1::pg_catalog.regclass AND attname = $2) AS exists`,
		[`pg_catalog.${relation}`, column],
	);
	return result.rows[0]?.exists === true;
}

matrixDescribe(matrixSuiteName, () => {
	beforeAll(async () => {
		if (matrixDatabaseUrl === undefined)
			throw new Error('MATRIX_DATABASE_URL is required for this suite');
		pool = new pg.Pool({
			connectionString: matrixDatabaseUrl,
			connectionTimeoutMillis,
			options: `-c statement_timeout=${statementTimeoutMillis}`,
		});
		await matrixPhase('connect', async () => {
			const client = await livePool().connect();
			client.release();
		});
		ownedSchema = await matrixPhase('create schema', () =>
			createOwnedMatrixSchema(livePool(), schema),
		);
		await matrixPhase('fixtures', async () => {
			await livePool().query(
				`CREATE TABLE ${schema}.${table} (id integer NOT NULL, quantity integer NOT NULL DEFAULT 42, created_at timestamptz NOT NULL DEFAULT now())`,
			);
			await livePool().query(
				`CREATE INDEX ${index} ON ${schema}.${table} (quantity) WHERE quantity > 0`,
			);
			await livePool().query(
				`ALTER TABLE ${schema}.${table} ADD CONSTRAINT ${check} CHECK (quantity >= 0)`,
			);
		});
	}, hookTimeoutMillis);

	afterAll(async () => {
		if (pool === undefined) return;
		try {
			if (ownedSchema !== undefined)
				await matrixPhase('cleanup schema', () =>
					dropOwnedMatrixSchema(
						pool as pg.Pool,
						ownedSchema as OwnedMatrixSchema,
					),
				);
		} finally {
			await pool.end();
			pool = undefined;
			ownedSchema = undefined;
		}
	}, hookTimeoutMillis);

	it('fails a schema collision without deleting the schema created first', async () => {
		const collision = await createOwnedMatrixSchema(livePool());
		try {
			await expect(
				createOwnedMatrixSchema(livePool(), collision.name),
			).rejects.toThrow('already exists');
			expect(
				await livePool().query<{ exists: boolean }>(
					`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS exists`,
					[collision.name],
				),
			).toMatchObject({ rows: [{ exists: true }] });
		} finally {
			await dropOwnedMatrixSchema(livePool(), collision);
		}
	});

	it('proves producer expectations through one checked-out live session', async () => {
		// PostgreSQL 10: pg_index has no indnkeyatts, so the indnatts fallback is live.
		// PostgreSQL 11+: pg_index has indnkeyatts, so the key-column path is live.
		// PostgreSQL 10-14: pg_index lacks indnullsnotdistinct; absence defaults false.
		// PostgreSQL 15+: pg_index has indnullsnotdistinct; PostgreSQL 18 exercises it.
		// PostgreSQL 10-17: pg_constraint lacks conenforced; absence defaults true.
		// PostgreSQL 18+: pg_constraint has conenforced, exercised by this matrix.
		const verified = await withGeneratedPostconditionSession(
			livePool(),
			async (session) => ({
				table: await verifyGeneratedTablePostcondition({
					session,
					postcondition: tablePostcondition,
					target: { schema, table, name: table },
				}),
				index: await verifyGeneratedIndexPostcondition({
					session,
					postcondition: indexPostcondition,
					target: { schema, table, name: index },
				}),
				check: await verifyGeneratedCheckPostcondition({
					session,
					postcondition: checkPostcondition,
					target: { schema, table, name: check },
				}),
			}),
		);

		expect(verified.table.kind).toBe('table');
		expect(verified.index.kind).toBe('index');
		expect(verified.check.kind).toBe('constraint');
	});

	it('refuses producer-generated drifted table, index, and CHECK expectations live', async () => {
		await expect(
			withGeneratedPostconditionSession(livePool(), (session) =>
				verifyGeneratedTablePostcondition({
					session,
					postcondition: driftedTablePostcondition,
					target: { schema, table, name: table },
				}),
			),
		).rejects.toThrow('postcondition differs');
		await expect(
			withGeneratedPostconditionSession(livePool(), (session) =>
				verifyGeneratedIndexPostcondition({
					session,
					postcondition: driftedIndexPostcondition,
					target: { schema, table, name: index },
				}),
			),
		).rejects.toThrow('postcondition differs');
		await expect(
			withGeneratedPostconditionSession(livePool(), (session) =>
				verifyGeneratedCheckPostcondition({
					session,
					postcondition: driftedCheckPostcondition,
					target: { schema, table, name: check },
				}),
			),
		).rejects.toThrow('postcondition differs');
	});

	it('defaults absent version-gated fields and refuses every present NULL', async () => {
		const indexLiveProjection = (sql: string) =>
			sql.includes('WHERE namespace.nspname = $1') &&
			sql.includes('index_relation.relname = $3');
		const checkLiveProjection = (sql: string) =>
			sql.includes('WHERE namespace.nspname = $1') &&
			sql.includes("constraint_item.contype = 'c'");
		const indexFeatures = [
			['indnullsnotdistinct', 'nulls_not_distinct'],
			['indnkeyatts', 'key_count'],
		] as const;
		for (const [catalogueField, projectionField] of indexFeatures) {
			const exists = await catalogueColumnExists('pg_index', catalogueField);
			if (!exists) {
				expect(exists).toBe(false);
				continue;
			}
			await expect(
				withGeneratedPostconditionSession(
					sessionWithPresentNull(projectionField, indexLiveProjection),
					(session) =>
						verifyGeneratedIndexPostcondition({
							session,
							postcondition: indexPostcondition,
							target: { schema, table, name: index },
						}),
				),
			).rejects.toThrow('could not read a complete projection');
		}

		const enforcedExists = await catalogueColumnExists(
			'pg_constraint',
			'conenforced',
		);
		if (!enforcedExists) {
			expect(enforcedExists).toBe(false);
			return;
		}
		await expect(
			withGeneratedPostconditionSession(
				sessionWithPresentNull('enforced', checkLiveProjection),
				(session) =>
					verifyGeneratedCheckPostcondition({
						session,
						postcondition: checkPostcondition,
						target: { schema, table, name: check },
					}),
			),
		).rejects.toThrow('could not read a complete projection');
	});
});
