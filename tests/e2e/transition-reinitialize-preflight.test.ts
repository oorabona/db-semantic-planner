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
	DBSP_TRANSITION_AUTHORIZATION_TABLE,
	DBSP_TRANSITION_JOURNAL_TABLE,
	DBSP_TRANSITION_RUN_PLAN_TABLE,
	DBSP_TRANSITION_RUN_TABLE,
	ensureTransitionJournal,
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

const transitionJournalTables = [
	DBSP_TRANSITION_RUN_TABLE,
	DBSP_TRANSITION_RUN_PLAN_TABLE,
	DBSP_TRANSITION_JOURNAL_TABLE,
	DBSP_TRANSITION_AUTHORIZATION_TABLE,
] as const;

describeWithE2eCapabilities(
	['role-administration'],
	'SC-13 / OBL-REC8 #481 reinitialize-preflight ownership and grants',
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
				...transitionJournalTables,
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
					for (const ledgerSchema of [schemaA, schemaB, DBSP_META_SCHEMA]) {
						for (const table of [
							DBSP_LEDGER_EVENT_TABLE,
							DBSP_LEDGER_RESERVATION_TABLE,
							DBSP_LEDGER_IDENTITY_TABLE,
							DBSP_LEDGER_MARKER_TABLE,
							...(ledgerSchema === DBSP_META_SCHEMA
								? transitionJournalTables
								: []),
						]) {
							const access = await setup.query<{ allowed: boolean }>(
								'SELECT has_table_privilege($1, $2, $3) AS allowed',
								[
									tenantA,
									`${quoteIdent(ledgerSchema)}.${quoteIdent(table)}`,
									'SELECT,INSERT,UPDATE,DELETE,TRUNCATE',
								],
							);
							expect(
								access.rows[0]?.allowed,
								`${tenantA} must not have any ledger DML privilege on ${ledgerSchema}.${table}`,
							).toBe(false);
						}
					}
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
				const stillGranted = await setup.query<{ allowed: boolean }>(
					'SELECT has_table_privilege($1, $2, $3) AS allowed',
					[
						tenantA,
						`${quoteIdent(schemaA)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
						'SELECT',
					],
				);
				expect(stillGranted.rows[0]?.allowed).toBe(true);
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
	] as const)(
		'%s marker refuses without changing its schema',
		async (_kind, type, versions) => {
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
		},
	);
});

describe('SC-20 #769 reinitialize-preflight transition journal', () => {
	beforeEach(resetDbspMeta);

	afterEach(resetDbspMeta);

	async function journalState(): Promise<
		readonly {
			readonly name: string;
			readonly owner: string;
			readonly widened: boolean;
		}[]
	> {
		const pool = await getTestPool();
		const result = await pool.query<{
			name: string;
			owner: string;
			widened: boolean;
		}>(
			`SELECT c.relname AS name, pg_catalog.pg_get_userbyid(c.relowner) AS owner, EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) acl WHERE acl.grantee = 0 OR acl.grantee <> c.relowner) AS widened FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) ORDER BY c.relname`,
			[DBSP_META_SCHEMA, transitionJournalTables],
		);
		return result.rows;
	}

	it('creates and owns an empty journal family once, including from a schema-scoped preflight', async () => {
		const schema = uniqueName('reinitialize_journal_scope');
		await createPreflightSchema(schema);
		try {
			const pool = await getTestPool();
			const role = await pool.query<{ role: string }>(
				'SELECT current_user AS role',
			);
			const first = await runPreflight([schema]);
			expect(first.scopes).toContainEqual(
				expect.objectContaining({
					ledger: { scope: 'database' },
					outcome: 'current',
				}),
			);
			const state = await journalState();
			expect(state).toHaveLength(transitionJournalTables.length);
			expect(state).toEqual(
				expect.arrayContaining(
					transitionJournalTables.map((name) => ({
						name,
						owner: role.rows[0]?.role,
						widened: false,
					})),
				),
			);
			for (const table of transitionJournalTables) {
				const count = await pool.query<{ count: string }>(
					`SELECT count(*)::text AS count FROM ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(table)}`,
				);
				expect(count.rows[0]?.count).toBe('0');
			}
			const second = await runPreflight([schema]);
			expect(second.scopes).toContainEqual(
				expect.objectContaining({
					ledger: { scope: 'database' },
					outcome: 'unchanged',
				}),
			);
		} finally {
			await dropSchema(schema);
		}
	});

	it('creates an absent journal family on the current-ledger fast path', async () => {
		const pool = await getTestPool();
		await runPreflight([]);
		await pool.query(
			`DROP TABLE ${transitionJournalTables
				.map((table) => `${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(table)}`)
				.join(', ')} CASCADE`,
		);

		const report = await runPreflight([]);
		expect(report.scopes).toContainEqual(
			expect.objectContaining({
				ledger: { scope: 'database' },
				outcome: 'current',
				marker: { kind: 'current' },
			}),
		);
		expect(await journalState()).toHaveLength(transitionJournalTables.length);
	});

	it('keeps a conforming journal family and its rows untouched', async () => {
		const pool = await getTestPool();
		await ensureTransitionJournal(pool);
		await pool.query(
			`INSERT INTO ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(DBSP_TRANSITION_RUN_TABLE)} (run_id, plan_digest, target_context_digest, database_id, core_version) VALUES ('preserved-run', 'plan', 'context', 'database', 'core')`,
		);

		const report = await runPreflight([]);
		expect(report.scopes).toContainEqual(
			expect.objectContaining({
				ledger: { scope: 'database' },
				outcome: 'current',
			}),
		);
		const count = await pool.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(DBSP_TRANSITION_RUN_TABLE)}`,
		);
		expect(count.rows[0]?.count).toBe('1');
	});

	it('refuses partial and drifted journal families before creating the ledger', async () => {
		const pool = await getTestPool();
		await pool.query(`CREATE SCHEMA ${quoteIdent(DBSP_META_SCHEMA)}`);
		await pool.query(
			`CREATE TABLE ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(DBSP_TRANSITION_RUN_TABLE)} (id text PRIMARY KEY)`,
		);
		const partial = await runPreflight([]);
		expect(partial.scopes).toContainEqual(
			expect.objectContaining({
				ledger: { scope: 'database' },
				outcome: 'failed',
				reason: expect.objectContaining({
					message: expect.stringContaining(DBSP_TRANSITION_RUN_PLAN_TABLE),
					step: 'create',
				}),
			}),
		);
		const ledger = await pool.query<{ exists: boolean }>(
			'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists',
			[
				`${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
			],
		);
		expect(ledger.rows[0]?.exists).toBe(false);

		await resetDbspMeta();
		await ensureTransitionJournal(pool);
		await pool.query(
			`ALTER TABLE ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(DBSP_TRANSITION_AUTHORIZATION_TABLE)} DROP COLUMN actor`,
		);
		const drifted = await runPreflight([]);
		expect(drifted.scopes).toContainEqual(
			expect.objectContaining({
				ledger: { scope: 'database' },
				outcome: 'failed',
				reason: expect.objectContaining({
					message: expect.stringContaining('authorization'),
					step: 'create',
				}),
			}),
		);
	});

	it('removes inherited PUBLIC grants from a fresh journal family', async () => {
		const pool = await getTestPool();
		await pool.query(`CREATE SCHEMA ${quoteIdent(DBSP_META_SCHEMA)}`);
		await pool.query(
			`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(DBSP_META_SCHEMA)} GRANT SELECT ON TABLES TO PUBLIC`,
		);

		const report = await runPreflight([]);
		expect(report.scopes).toContainEqual(
			expect.objectContaining({
				ledger: { scope: 'database' },
				outcome: 'current',
			}),
		);
		const publicGrants = await pool.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) acl WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND acl.grantee = 0`,
			[DBSP_META_SCHEMA, transitionJournalTables],
		);
		expect(publicGrants.rows[0]?.count).toBe('0');
	});
});

describeWithE2eCapabilities(
	['role-administration'],
	'SC-20a #769 reinitialize-preflight transition journal authority refusals',
	() => {
		const roles: string[] = [];

		afterEach(async () => {
			await resetDbspMeta();
			const pool = await getTestPool();
			for (const role of roles.splice(0)) {
				await pool.query(`DROP OWNED BY ${quoteIdent(role)}`);
				await pool.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
			}
		});

		it('refuses a foreign-owned or widened journal table without repairing it', async () => {
			const foreignOwner = uniqueName('dbsp_journal_owner');
			const grantee = uniqueName('dbsp_journal_grantee');
			roles.push(foreignOwner, grantee);
			const pool = await getTestPool();
			for (const role of [foreignOwner, grantee])
				await pool.query(`CREATE ROLE ${quoteIdent(role)}`);
			await ensureTransitionJournal(pool);
			await runPreflight([]);
			await pool.query(
				`ALTER TABLE ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(DBSP_TRANSITION_RUN_TABLE)} OWNER TO ${quoteIdent(foreignOwner)}`,
			);
			const foreign = await runPreflight([]);
			expect(foreign.scopes).toContainEqual(
				expect.objectContaining({
					ledger: { scope: 'database' },
					outcome: 'failed',
					reason: expect.objectContaining({
						message: expect.stringContaining(DBSP_TRANSITION_RUN_TABLE),
					}),
				}),
			);

			await resetDbspMeta();
			await ensureTransitionJournal(pool);
			await runPreflight([]);
			await pool.query(
				`GRANT SELECT ON TABLE ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(DBSP_TRANSITION_JOURNAL_TABLE)} TO ${quoteIdent(grantee)}`,
			);
			const widened = await runPreflight([]);
			expect(widened.scopes).toContainEqual(
				expect.objectContaining({
					ledger: { scope: 'database' },
					outcome: 'failed',
					refusal: expect.objectContaining({
						code: 'reinitialize-preflight-grants',
					}),
					reason: expect.objectContaining({
						message: expect.stringContaining(DBSP_TRANSITION_JOURNAL_TABLE),
					}),
				}),
			);

			await resetDbspMeta();
			await pool.query(
				`CREATE SCHEMA ${quoteIdent(DBSP_META_SCHEMA)} AUTHORIZATION ${quoteIdent(foreignOwner)}`,
			);
			const foreignSchema = await runPreflight([]);
			expect(foreignSchema.scopes).toContainEqual(
				expect.objectContaining({
					ledger: { scope: 'database' },
					outcome: 'failed',
					reason: expect.objectContaining({
						message: expect.stringContaining(DBSP_META_SCHEMA),
					}),
				}),
			);
		});

		it('refuses a column grant on a conforming journal table', async () => {
			const grantee = uniqueName('dbsp_journal_column_grantee');
			roles.push(grantee);
			const pool = await getTestPool();
			await pool.query(`CREATE ROLE ${quoteIdent(grantee)}`);
			await ensureTransitionJournal(pool);
			await runPreflight([]);
			await pool.query(
				`GRANT SELECT (${quoteIdent('run_id')}) ON TABLE ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(DBSP_TRANSITION_RUN_TABLE)} TO ${quoteIdent(grantee)}`,
			);

			const report = await runPreflight([]);
			expect(report.scopes).toContainEqual(
				expect.objectContaining({
					ledger: { scope: 'database' },
					outcome: 'failed',
					refusal: expect.objectContaining({
						code: 'reinitialize-preflight-grants',
					}),
					reason: expect.objectContaining({
						message: expect.stringContaining(DBSP_TRANSITION_RUN_TABLE),
						step: 'ownership-grants',
					}),
				}),
			);
			const failed = report.scopes.find(
				(scope) => scope.ledger.scope === 'database',
			);
			expect(failed?.reason?.message).toContain('widened grants on a column');
		});
	},
);

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

	it('refuses a foreign partial database ledger without completing its missing relations', async () => {
		const pool = await getTestPool();
		await pool.query(`CREATE SCHEMA ${quoteIdent(DBSP_META_SCHEMA)}`);
		await pool.query(
			`CREATE TABLE ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)} (id text PRIMARY KEY)`,
		);

		const report = await runPreflight([]);
		expect(
			report.scopes.find((scope) => scope.ledger.scope === 'database'),
		).toMatchObject({
			outcome: 'failed',
			refusal: { code: 'reinitialize-preflight-failed' },
			reason: { step: 'create' },
		});
		for (const table of [
			DBSP_LEDGER_IDENTITY_TABLE,
			DBSP_LEDGER_MARKER_TABLE,
			DBSP_LEDGER_RESERVATION_TABLE,
		]) {
			const relation = await pool.query<{ exists: boolean }>(
				'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists',
				[`${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(table)}`],
			);
			expect(relation.rows[0]?.exists).toBe(false);
		}
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
				...transitionJournalTables,
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

	it.each(['archive', 'create', 'grants', 'marker', 'output'] as const)(
		'keeps a current marker and recovers after kill at %s',
		async (checkpoint) => {
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
		},
		90_000,
	);
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

	it('OBL-REC10: excludes every covered and dbsp-infrastructure address from adoption candidates', async () => {
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
			declarations: tableDeclarations(schema, [
				'covered',
				'candidate',
				DBSP_LEDGER_EVENT_TABLE,
				DBSP_TRANSITION_RUN_TABLE,
			]),
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

	it('OBL-CLI3: emits an adoption artifact with owner-only mode under umask 022', async () => {
		const schema = uniqueName('reinitialize_adoption_mode');
		schemas.push(schema);
		await createPreflightSchema(schema);
		const directory = await mkdtemp(join(tmpdir(), 'dbsp-preflight-mode-e2e-'));
		directories.push(directory);
		const out = join(directory, 'adoption.json');
		const previousUmask = process.umask(0o022);
		try {
			await runPreflight([schema], {
				declarations: tableDeclarations(schema, ['candidate']),
				writeAdoptionFile: (value: ReinitializePreflightReport) =>
					writeAdoptionFileAtomically(out, value),
			});
		} finally {
			process.umask(previousUmask);
		}
		expect((await stat(out)).mode & 0o777).toBe(0o600);
	});
});

describe('OBL-REC11 reinitialize preflight statement capture', () => {
	const schemas: string[] = [];

	beforeEach(resetDbspMeta);

	afterEach(async () => {
		for (const schema of schemas.splice(0)) await dropSchema(schema);
		await resetDbspMeta();
	}, 30_000);

	it('captures a full preflight with zero event, reservation, or journal-table writes', async () => {
		const schema = uniqueName('reinitialize_statement_capture');
		schemas.push(schema);
		await createPreflightSchema(schema);
		const pool = await getTestPool();
		const statements: string[] = [];
		const capturedPool = Object.create(pool) as typeof pool;
		capturedPool.connect = async () => {
			const client = await pool.connect();
			const query = client.query.bind(client);
			const capturedClient = Object.create(client) as typeof client;
			capturedClient.query = (async (sql: string, values?: unknown[]) => {
				statements.push(sql);
				return await query(sql, values);
			}) as typeof capturedClient.query;
			capturedClient.release = client.release.bind(client);
			return capturedClient;
		};
		const report = await runPreflight([schema], {
			pool: capturedPool,
			writeAdoptionFile: async () => {},
		});
		expect(report.scopes).toContainEqual(
			expect.objectContaining({
				ledger: { scope: 'schema', schema },
				outcome: 'current',
			}),
		);
		const writes = statements.filter(
			(sql) =>
				/^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(sql) &&
				(sql.includes(DBSP_LEDGER_EVENT_TABLE) ||
					sql.includes(DBSP_LEDGER_RESERVATION_TABLE) ||
					transitionJournalTables.some((table) => sql.includes(table))),
		);
		expect(writes).toEqual([]);
	});
});
