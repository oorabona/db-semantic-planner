import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	DBSP_LEDGER_EVENT_TABLE,
	DBSP_LEDGER_IDENTITY_TABLE,
	DBSP_LEDGER_MARKER_TABLE,
	DBSP_LEDGER_RESERVATION_TABLE,
	DBSP_META_SCHEMA,
	PG_LEDGER_SHAPE_VERSION,
} from '@dbsp/adapter-pgsql';
import type { ReinitializePreflightReport } from '@dbsp/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAdoptionFileAtomically } from '../../packages/cli/src/commands/preflight.js';
import {
	type CheckpointChild,
	describeWithE2eCapabilities,
	spawnCheckpointChild,
} from './harness/index.js';
import { dropSchema, getTestPool } from './testkit/index.js';
import {
	corruptLedgerIdentity,
	createPreflightSchema,
	emptyDeclarations,
	ledgerEventCount,
	markerVersions,
	quoteIdent,
	resetDbspMeta,
	rolePool,
	runPreflight,
	seedCoveredChain,
	tableAddress,
	tableDeclarations,
	terminateReinitializePreflightChildBackends,
	uniqueName,
} from './transition-reinitialize-preflight-testkit.js';

function quoteLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

describeWithE2eCapabilities(
	['role-administration'],
	'SC-13 #481 reinitialize-preflight ownership and grants',
	() => {
		const roles: string[] = [];
		const schemas: string[] = [];

		async function assignMetaOwner(owner: string): Promise<void> {
			const pool = await getTestPool();
			await pool.query(
				`ALTER SCHEMA ${quoteIdent(DBSP_META_SCHEMA)} OWNER TO ${quoteIdent(owner)}`,
			);
			for (const table of [
				DBSP_LEDGER_EVENT_TABLE,
				DBSP_LEDGER_RESERVATION_TABLE,
				DBSP_LEDGER_IDENTITY_TABLE,
				DBSP_LEDGER_MARKER_TABLE,
			]) {
				await pool.query(
					`ALTER TABLE ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(table)} OWNER TO ${quoteIdent(owner)}`,
				);
			}
		}

		beforeEach(resetDbspMeta);

		afterEach(async () => {
			const pool = await getTestPool();
			for (const schema of schemas.splice(0))
				await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
			await resetDbspMeta();
			for (const role of roles.splice(0)) {
				await pool.query(`DROP OWNED BY ${quoteIdent(role)}`);
				await pool.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
			}
		});

		it('keeps tenant roles out of peer ledgers and dbsp_meta, then refuses widened grants', async () => {
			const deployment = uniqueName('dbsp_deployment');
			const tenantA = uniqueName('dbsp_tenant_a');
			const tenantB = uniqueName('dbsp_tenant_b');
			const password = uniqueName('password');
			roles.push(deployment, tenantA, tenantB);
			const schemaA = uniqueName('reinitialize_grants_a');
			const schemaB = uniqueName('reinitialize_grants_b');
			schemas.push(schemaA, schemaB);
			const setup = await getTestPool();
			const database = await setup.query<{ database: string }>(
				'SELECT current_database() AS database',
			);
			for (const role of [deployment, tenantA, tenantB]) {
				await setup.query(
					`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLiteral(password)}`,
				);
			}
			await setup.query(
				`GRANT CREATE ON DATABASE ${quoteIdent(database.rows[0]?.database ?? 'e2e_test')} TO ${quoteIdent(deployment)}`,
			);
			for (const schema of [schemaA, schemaB]) {
				await setup.query(
					`CREATE SCHEMA ${quoteIdent(schema)} AUTHORIZATION ${quoteIdent(deployment)}`,
				);
			}
			await runPreflight([], {
				pool: setup,
				declarations: emptyDeclarations(),
				writeAdoptionFile: async () => {},
			});
			await assignMetaOwner(deployment);
			const deployed = await rolePool(deployment, password);
			try {
				const report = await runPreflight([schemaA, schemaB], {
					pool: deployed,
					declarations: emptyDeclarations(),
					writeAdoptionFile: async () => {},
				});
				expect(
					report.scopes
						.filter(
							(scope) =>
								scope.ledger.schema === schemaA ||
								scope.ledger.schema === schemaB,
						)
						.every((scope) => scope.outcome === 'current'),
				).toBe(true);
				const tenant = await rolePool(tenantA, password);
				try {
					await expect(
						tenant.query(
							`SELECT * FROM ${quoteIdent(schemaB)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
						),
					).rejects.toThrow(/permission denied/i);
					await expect(
						tenant.query(
							`SELECT * FROM ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
						),
					).rejects.toThrow(/permission denied/i);
				} finally {
					await tenant.end();
				}
				await deployed.query(
					`GRANT USAGE ON SCHEMA ${quoteIdent(schemaA)} TO ${quoteIdent(tenantA)}`,
				);
				await deployed.query(
					`GRANT SELECT ON TABLE ${quoteIdent(schemaA)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)} TO ${quoteIdent(tenantA)}`,
				);
				const widened = await runPreflight([schemaA], {
					pool: deployed,
					declarations: emptyDeclarations(),
					writeAdoptionFile: async () => {},
				});
				expect(
					widened.scopes.find((scope) => scope.ledger.schema === schemaA),
				).toMatchObject({
					outcome: 'failed',
					refusal: { code: 'reinitialize-preflight-grants' },
				});
			} finally {
				await deployed.end();
			}
		});
	},
);

describe('SC-15 #481 reinitialize-preflight marker refusals', () => {
	const schemas: string[] = [];

	beforeEach(resetDbspMeta);

	afterEach(async () => {
		for (const schema of schemas.splice(0)) await dropSchema(schema);
		await resetDbspMeta();
	});

	it.each([
		['older', 'integer', [PG_LEDGER_SHAPE_VERSION - 1]],
		['future', 'integer', [PG_LEDGER_SHAPE_VERSION + 1]],
		[
			'mixed',
			'integer',
			[PG_LEDGER_SHAPE_VERSION - 1, PG_LEDGER_SHAPE_VERSION + 1],
		],
		['unreadable', 'text', ['not-a-version']],
	] as const)('%s marker refuses without changing its schema', async (_kind, type, versions) => {
		const schema = uniqueName('reinitialize_marker');
		schemas.push(schema);
		await createPreflightSchema(schema);
		const pool = await getTestPool();
		await pool.query(
			`CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_MARKER_TABLE)} (version ${type} NOT NULL)`,
		);
		for (const version of versions) {
			await pool.query(
				`INSERT INTO ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_MARKER_TABLE)} (version) VALUES ($1)`,
				[version],
			);
		}

		const report = await runPreflight([schema]);
		const refused = report.scopes.find(
			(scope) => scope.ledger.schema === schema,
		);
		expect(refused).toMatchObject({
			outcome: 'failed',
			marker: { kind: _kind },
			refusal: {
				code: 'reinitialize-preflight-marker-not-current',
			},
		});
		expect(refused?.refusal?.detail).toContain('reinitialize-preflight');

		const unchanged = await pool.query<{ version: string }>(
			`SELECT version::text AS version FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_MARKER_TABLE)} ORDER BY version`,
		);
		expect(unchanged.rows.map((row) => row.version)).toEqual(
			versions.map(String).sort(),
		);
		const ledger = await pool.query<{ exists: boolean }>(
			'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists',
			[`${quoteIdent(schema)}.${quoteIdent('dbsp_ledger_event')}`],
		);
		expect(ledger.rows[0]?.exists).toBe(false);
	});
});

describe('SC-15a #481 pre-existing ledger-shape admission', () => {
	const schemas: string[] = [];

	beforeEach(resetDbspMeta);

	afterEach(async () => {
		for (const schema of schemas.splice(0)) await dropSchema(schema);
		await resetDbspMeta();
	});

	it('accepts a ledger initialized in a random schema on the next validator pass', async () => {
		const schema = uniqueName('reinitialize_reflexive');
		schemas.push(schema);
		await createPreflightSchema(schema);

		const initialized = await runPreflight([schema]);
		expect(
			initialized.scopes.find((scope) => scope.ledger.schema === schema),
		).toMatchObject({ outcome: 'current' });

		// The second pass reaches validatePgLedgerPhysicalShape for the ledger
		// created by the first pass; no fixture replays the DDL here.
		const validated = await runPreflight([schema]);
		expect(
			validated.scopes.find((scope) => scope.ledger.schema === schema),
		).toMatchObject({ outcome: 'unchanged', marker: { kind: 'current' } });
	});

	it('initializes a fresh ledger but refuses a foreign pre-existing ledger table', async () => {
		const fresh = uniqueName('reinitialize_fresh');
		const foreign = uniqueName('reinitialize_foreign');
		schemas.push(fresh, foreign);
		await createPreflightSchema(fresh);
		await createPreflightSchema(foreign);
		const pool = await getTestPool();
		await pool.query(
			`CREATE TABLE ${quoteIdent(foreign)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)} (id text PRIMARY KEY)`,
		);

		const report = await runPreflight([fresh, foreign]);
		expect(
			report.scopes.find((scope) => scope.ledger.schema === fresh),
		).toMatchObject({ outcome: 'current', marker: { kind: 'absent' } });
		expect(
			report.scopes.find((scope) => scope.ledger.schema === foreign),
		).toMatchObject({
			outcome: 'failed',
			refusal: { code: 'reinitialize-preflight-failed' },
			reason: { step: 'create' },
		});
		const foreignMarker = await pool.query<{ exists: boolean }>(
			'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists',
			[`${quoteIdent(foreign)}.${quoteIdent(DBSP_LEDGER_MARKER_TABLE)}`],
		);
		expect(foreignMarker.rows[0]?.exists).toBe(false);
	});
});

describeWithE2eCapabilities(
	['role-administration'],
	'SC-16 #481 explicit reinitialize-preflight scope reports',
	() => {
		const roles: string[] = [];
		const schemas: string[] = [];

		async function assignMetaOwner(owner: string): Promise<void> {
			const pool = await getTestPool();
			await pool.query(
				`ALTER SCHEMA ${quoteIdent(DBSP_META_SCHEMA)} OWNER TO ${quoteIdent(owner)}`,
			);
			for (const table of [
				DBSP_LEDGER_EVENT_TABLE,
				DBSP_LEDGER_RESERVATION_TABLE,
				DBSP_LEDGER_IDENTITY_TABLE,
				DBSP_LEDGER_MARKER_TABLE,
			]) {
				await pool.query(
					`ALTER TABLE ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(table)} OWNER TO ${quoteIdent(owner)}`,
				);
			}
		}

		beforeEach(resetDbspMeta);

		afterEach(async () => {
			const pool = await getTestPool();
			for (const schema of schemas.splice(0))
				await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
			await resetDbspMeta();
			for (const role of roles.splice(0)) {
				await pool.query(`DROP OWNED BY ${quoteIdent(role)}`);
				await pool.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
			}
		});

		it('reports current, unchanged, failed, and not-attempted around a denied scope', async () => {
			const deployment = uniqueName('dbsp_scope_deployment');
			const deniedOwner = uniqueName('dbsp_scope_denied');
			const password = uniqueName('password');
			roles.push(deployment, deniedOwner);
			const permitted = uniqueName('reinitialize_scope_ok');
			const denied = uniqueName('reinitialize_scope_denied');
			schemas.push(permitted, denied);
			const setup = await getTestPool();
			const database = await setup.query<{ database: string }>(
				'SELECT current_database() AS database',
			);
			for (const role of [deployment, deniedOwner]) {
				await setup.query(
					`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLiteral(password)}`,
				);
			}
			await setup.query(
				`GRANT CREATE ON DATABASE ${quoteIdent(database.rows[0]?.database ?? 'e2e_test')} TO ${quoteIdent(deployment)}`,
			);
			await setup.query(
				`CREATE SCHEMA ${quoteIdent(permitted)} AUTHORIZATION ${quoteIdent(deployment)}`,
			);
			await setup.query(
				`CREATE SCHEMA ${quoteIdent(denied)} AUTHORIZATION ${quoteIdent(deniedOwner)}`,
			);
			await setup.query(
				`CREATE TABLE ${quoteIdent(denied)}.${quoteIdent('application_table')} (id integer PRIMARY KEY)`,
			);
			await setup.query(
				`REVOKE ALL ON SCHEMA ${quoteIdent(denied)} FROM ${quoteIdent(deployment)}`,
			);
			await setup.query(
				`REVOKE ALL ON TABLE ${quoteIdent(denied)}.${quoteIdent('application_table')} FROM ${quoteIdent(deployment)}`,
			);
			await runPreflight([], {
				pool: setup,
				declarations: emptyDeclarations(),
				writeAdoptionFile: async () => {},
			});
			await assignMetaOwner(deployment);
			const deployed = await rolePool(deployment, password);
			try {
				const first = await runPreflight([permitted, denied], {
					pool: deployed,
					declarations: emptyDeclarations(),
					writeAdoptionFile: async () => {},
				});
				expect(first.scopes).toMatchObject([
					{ ledger: { scope: 'database' }, outcome: 'unchanged' },
					{ ledger: { scope: 'schema', schema: denied }, outcome: 'failed' },
					{
						ledger: { scope: 'schema', schema: permitted },
						outcome: 'current',
					},
				]);
				expect(
					first.scopes.find((scope) => scope.ledger.schema === denied)?.refusal
						?.detail,
				).toMatch(/permission denied|must be owner/i);
				const retry = await runPreflight([permitted, denied], {
					pool: deployed,
					declarations: emptyDeclarations(),
					writeAdoptionFile: async () => {},
				});
				expect(retry.scopes).toMatchObject([
					{ ledger: { scope: 'database' }, outcome: 'unchanged' },
					{ ledger: { scope: 'schema', schema: denied }, outcome: 'failed' },
					{
						ledger: { scope: 'schema', schema: permitted },
						outcome: 'unchanged',
					},
				]);
				// A denied scope remains unusable by the deployment role outside the
				// privileged preflight; an ordinary table read is refused as well.
				await expect(
					deployed.query(
						`SELECT * FROM ${quoteIdent(denied)}.${quoteIdent('application_table')}`,
					),
				).rejects.toThrow(/permission denied/i);
			} finally {
				await deployed.end();
			}
		});
	},
);

describe('SC-17 #481 reinitialize-preflight interruption matrix', () => {
	const schemas: string[] = [];
	const directories: string[] = [];
	const checkpoints = [
		'archive',
		'create',
		'grants',
		'marker',
		'output',
	] as const;

	beforeEach(resetDbspMeta);

	afterEach(async () => {
		for (const schema of schemas.splice(0)) await dropSchema(schema);
		for (const directory of directories.splice(0))
			await rm(directory, { recursive: true, force: true });
		await resetDbspMeta();
	});

	async function prepareInterruptedLedger(schema: string): Promise<void> {
		await createPreflightSchema(schema);
		await runPreflight([schema]);
		await corruptLedgerIdentity(schema);
	}

	async function killAt(
		child: CheckpointChild,
		checkpoint: string,
	): Promise<void> {
		for (const point of checkpoints) {
			if (point === checkpoint) {
				const exit = await child.killAtCheckpoint(point);
				expect(exit.signal).toBe('SIGKILL');
				return;
			}
			await child.waitForCheckpoint(point);
			await child.acknowledge(point);
		}
		throw new Error(`unknown preflight checkpoint ${checkpoint}`);
	}

	async function complete(
		child: CheckpointChild,
		points: readonly string[],
	): Promise<void> {
		for (const point of points) {
			await child.waitForCheckpoint(point);
			await child.acknowledge(point);
		}
		const exit = await child.exited;
		expect(exit).toEqual({ code: 0, signal: null });
	}

	it.each([
		'archive',
		'create',
		'grants',
		'marker',
		'output',
	] as const)('keeps a current marker and recovers after kill at %s', async (checkpoint) => {
		const schema = uniqueName(`reinitialize_kill_${checkpoint}`);
		schemas.push(schema);
		await prepareInterruptedLedger(schema);
		const directory = await mkdtemp(join(tmpdir(), 'dbsp-preflight-kill-'));
		directories.push(directory);
		const out = join(directory, 'adoption.json');
		const child = spawnCheckpointChild(
			fileURLToPath(
				new URL(
					'./transition-reinitialize-preflight-child.ts',
					import.meta.url,
				),
			),
			{ args: [schema, out], env: process.env },
		);

		await killAt(child, checkpoint);
		if (child.process.pid === undefined)
			throw new Error('checkpoint child has no pid');
		await terminateReinitializePreflightChildBackends(child.process.pid);
		await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
		expect(await markerVersions(schema)).toEqual([1]);

		const rerun = spawnCheckpointChild(
			fileURLToPath(
				new URL(
					'./transition-reinitialize-preflight-child.ts',
					import.meta.url,
				),
			),
			{ args: [schema, out], env: process.env },
		);
		await complete(rerun, checkpoint === 'output' ? ['output'] : checkpoints);
		expect(await markerVersions(schema)).toEqual([1]);
		expect(JSON.parse(await readFile(out, 'utf8'))).toMatchObject({
			adoptions: [],
		});
	}, 90_000);
});

describe('SC-18 #481 greenfield reinitialize-preflight', () => {
	const schemas: string[] = [];

	beforeEach(resetDbspMeta);

	afterEach(async () => {
		for (const schema of schemas.splice(0)) await dropSchema(schema);
		await resetDbspMeta();
	});

	it('initializes a schema with application and inert pre-ledger transition tables', async () => {
		const schema = uniqueName('reinitialize_greenfield');
		schemas.push(schema);
		await createPreflightSchema(schema);
		const pool = await getTestPool();
		for (const table of [
			'dbsp_transition_run',
			'dbsp_transition_run_plan',
			'dbsp_transition_journal',
			'dbsp_transition_authorization',
		]) {
			await pool.query(
				`CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(table)} (inert integer)`,
			);
		}

		const report = await runPreflight([schema]);
		expect(
			report.scopes.find((scope) => scope.ledger.schema === schema),
		).toMatchObject({
			outcome: 'current',
			marker: { kind: 'absent' },
		});
		expect(await markerVersions(schema)).toEqual([1]);
		for (const table of ['application_table', 'dbsp_transition_run']) {
			const exists = await pool.query<{ exists: boolean }>(
				'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists',
				[`${quoteIdent(schema)}.${quoteIdent(table)}`],
			);
			expect(exists.rows[0]?.exists).toBe(true);
		}
		const ledger = await pool.query<{ exists: boolean }>(
			'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists',
			[`${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`],
		);
		expect(ledger.rows[0]?.exists).toBe(true);
		const marker = await pool.query<{ exists: boolean }>(
			'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists',
			[`${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_MARKER_TABLE)}`],
		);
		expect(marker.rows[0]?.exists).toBe(true);
	});
});

describe('SC-19 #481 reinitialize-preflight adoption output', () => {
	const schemas: string[] = [];
	const directories: string[] = [];

	beforeEach(resetDbspMeta);

	afterEach(async () => {
		for (const schema of schemas.splice(0)) await dropSchema(schema);
		for (const directory of directories.splice(0))
			await rm(directory, { recursive: true, force: true });
		await resetDbspMeta();
	});

	it('writes only DSL declarations without a chain and appends no events', async () => {
		const schema = uniqueName('reinitialize_adoption');
		schemas.push(schema);
		await createPreflightSchema(schema);
		await runPreflight([schema]);
		await seedCoveredChain(schema, tableAddress(schema, 'covered'));
		const before = await ledgerEventCount(schema);
		const directory = await mkdtemp(join(tmpdir(), 'dbsp-preflight-e2e-'));
		directories.push(directory);
		const out = join(directory, 'adoption.json');

		const report = await runPreflight([schema], {
			declarations: tableDeclarations(schema, ['covered', 'candidate']),
			writeAdoptionFile: (value: ReinitializePreflightReport) =>
				writeAdoptionFileAtomically(out, value),
		});

		expect(report.adoptionCandidates).toEqual([
			expect.objectContaining({ address: tableAddress(schema, 'candidate') }),
		]);
		expect(JSON.parse(await readFile(out, 'utf8'))).toEqual({
			version: 1,
			adoptions: report.adoptionCandidates,
		});
		expect(await ledgerEventCount(schema)).toBe(before);
	});
});
