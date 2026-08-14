import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createPgsqlAdapter,
	DBSP_LEDGER_EVENT_TABLE,
	DBSP_LEDGER_IDENTITY_TABLE,
	DBSP_LEDGER_MARKER_TABLE,
	runPgReinitializePreflight,
} from '@dbsp/adapter-pgsql';
import { type ModelIR, ModelIRImpl } from '@dbsp/core';
import type { DeclarationSet } from '@dbsp/types';
import pg from 'pg';
import { expect, it } from 'vitest';
import { runApply } from '../../packages/cli/src/commands/apply.js';
import { runInspect } from '../../packages/cli/src/commands/inspect.js';
import { runPlan } from '../../packages/cli/src/commands/plan.js';
import {
	describeWithE2eCapabilities,
	dumpAndRestoreInLocalPostgresContainer,
} from './harness/index.js';

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function unique(prefix: string): string {
	return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function databaseUrl(database: string): string {
	const configured = process.env.DATABASE_URL;
	if (!configured) throw new Error('DATABASE_URL is required for restore E2E');
	const url = new URL(configured);
	url.pathname = `/${encodeURIComponent(database)}`;
	return url.toString();
}

/** Preserve the fixture's observed application objects and request one enum addition. */
function enumModelWithPendingValue(current: ModelIR): ModelIR {
	const currentEnums = current.enums;
	const status = currentEnums?.get('status');
	if (!status) throw new Error('expected status enum to be introspected');
	const enums = new Map(currentEnums);
	enums.set('status', { ...status, values: [...status.values, 'pending'] });
	return new ModelIRImpl(
		new Map(current.tables),
		new Map(current.relations),
		enums,
		current.extensions,
		current.sequences ? new Map(current.sequences) : undefined,
		current.externalTables,
	);
}

function declarations(schema: string, database: string): DeclarationSet {
	return {
		version: 1,
		digest: `lineage-${schema}`,
		declarations: [
			{
				address: {
					engine: 'postgresql',
					database,
					schema,
					kind: 'table',
					name: 'application_table',
				},
				fragment: { name: 'application_table' },
				digest: `lineage-table-${schema}`,
			},
		],
	};
}

async function planEnumAdd(
	pool: pg.Pool,
	db: string,
	schema: string,
): Promise<{
	readonly runId: string;
	readonly planDigest: string;
	readonly plan: NonNullable<Awaited<ReturnType<typeof runPlan>>['plan']>;
}> {
	const planned = await runPlan(
		{ db, schemaFile: 'lineage-restore-local.ts', schema },
		{
			createDbConnection: async () => ({
				pool,
				release: async () => undefined,
			}),
			loadSchema: async () => {
				const current = await createPgsqlAdapter(pool, {
					schemaName: schema,
				}).introspect({ schema });
				return {
					model: enumModelWithPendingValue(current),
					definition: {},
					tableNames: [...current.tables.keys()],
				};
			},
		},
	);
	if (!planned.runId || !planned.planDigest || !planned.plan)
		throw new Error(
			`expected a persisted enum transition plan; runPlan returned ${JSON.stringify(planned)}`,
		);
	return {
		runId: planned.runId,
		planDigest: planned.planDigest,
		plan: planned.plan,
	};
}

async function createDatabase(pool: pg.Pool, name: string): Promise<void> {
	await pool.query(`CREATE DATABASE ${quoteIdent(name)}`);
}

async function dropDatabase(pool: pg.Pool, name: string): Promise<void> {
	await pool.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
}

describeWithE2eCapabilities(
	['container-exec'],
	'SC-43, SC-44 #481 restored ledgers refuse mutation and retain readable provenance',
	() => {
		it('SC-43 / OBL-REC9: full pg_dump/pg_restore archives byte-stable, read-only lineage before a fresh ledger', async () => {
			const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
			const sourceDatabase = unique('dbsp_lineage_full_source');
			const targetDatabase = unique('dbsp_lineage_full_target');
			const schema = unique('lineage_full_schema');
			const temporary = await mkdtemp(join(tmpdir(), 'dbsp-lineage-'));
			let source: pg.Pool | undefined;
			let target: pg.Pool | undefined;
			let sourceEventRows: readonly {
				readonly event_id: string;
				readonly row: string;
			}[] = [];
			try {
				await createDatabase(admin, sourceDatabase);
				await createDatabase(admin, targetDatabase);
				source = new pg.Pool({ connectionString: databaseUrl(sourceDatabase) });
				await source.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
				await source.query(
					`CREATE TABLE ${quoteIdent(schema)}.${quoteIdent('application_table')} (id integer PRIMARY KEY)`,
				);
				await source.query(
					`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
				);
				await runPgReinitializePreflight({
					pool: source,
					schemas: [schema],
					declarations: declarations(schema, sourceDatabase),
					writeAdoptionFile: async () => {},
				});
				await source.query(
					`INSERT INTO ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)} (event_id, address_engine, address_database, address_schema, address_parent, address_kind, address_name, event_kind) VALUES ($1, 'postgresql', $2, $3, 'null'::jsonb, 'table', 'application_table', 'observed')`,
					[`lineage-observed-${randomUUID()}`, sourceDatabase, schema],
				);
				const planned = await planEnumAdd(
					source,
					databaseUrl(sourceDatabase),
					schema,
				);
				sourceEventRows = (
					await source.query<{ event_id: string; row: string }>(
						`SELECT event_id, row_to_json(e)::text AS row FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)} e ORDER BY event_id`,
					)
				).rows;
				await source.end();
				source = undefined;

				await dumpAndRestoreInLocalPostgresContainer({
					sourceDatabase,
					targetDatabase,
				});
				target = new pg.Pool({ connectionString: databaseUrl(targetDatabase) });
				const refused = await runApply(
					planned.runId,
					{
						db: databaseUrl(targetDatabase),
						planDigest: planned.planDigest,
						accept: planned.plan.assumptions.map(
							(assumption) => assumption.class,
						),
					},
					target,
				);
				expect(
					refused.outcome,
					'a restored ledger must not be allowed to mutate',
				).not.toBe('completed');
				expect(
					JSON.stringify(refused),
					'the refusal must name its actionable fresh-ledger command',
				).toContain('dbsp preflight --reinitialize');

				const inspected = await runInspect(undefined, {
					db: databaseUrl(targetDatabase),
					schema,
				});
				expect(
					inspected.addresses,
					'inspect must retain read access to every restored ledger address',
				).toContainEqual(
					expect.objectContaining({ schema, name: 'application_table' }),
				);

				const adoptionPath = join(temporary, 'adoption.json');
				const reinitialized = await runPgReinitializePreflight({
					pool: target,
					schemas: [schema],
					declarations: declarations(schema, targetDatabase),
					writeAdoptionFile: async (report) => {
						await import('node:fs/promises').then(({ writeFile }) =>
							writeFile(adoptionPath, JSON.stringify(report), 'utf8'),
						);
					},
				});
				expect(
					reinitialized.scopes,
					'each restored scope must get a fresh current ledger',
				).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							ledger: { scope: 'schema', schema },
							outcome: 'current',
						}),
					]),
				);
				const adoption = JSON.parse(await readFile(adoptionPath, 'utf8')) as {
					readonly adoptionCandidates: readonly unknown[];
				};
				expect(
					adoption.adoptionCandidates,
					'the named adoption file must be written after the cutover',
				).toHaveLength(1);
				const freshEvents = await target.query<{ count: string }>(
					`SELECT count(*)::text AS count FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
				);
				expect(
					freshEvents.rows[0]?.count,
					'the fresh ledger must begin without appended events',
				).toBe('0');
				const liveIdentity = await target.query<{ database_oid: string }>(
					'SELECT oid::text AS database_oid FROM pg_catalog.pg_database WHERE datname = current_database()',
				);
				const freshIdentity = await target.query<{ database_oid: string }>(
					`SELECT database_oid FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_IDENTITY_TABLE)} WHERE id = true`,
				);
				expect(
					freshIdentity.rows[0]?.database_oid,
					'the fresh ledger must bind the target database identity',
				).toBe(liveIdentity.rows[0]?.database_oid);
				const archived = await target.query<{ relname: string }>(
					"SELECT relname FROM pg_catalog.pg_class JOIN pg_catalog.pg_namespace ON pg_namespace.oid = pg_class.relnamespace WHERE nspname = $1 AND relname LIKE 'dbsp_ledger_event_archive_%'",
					[schema],
				);
				const archivedEvent = archived.rows[0]?.relname;
				if (!archivedEvent)
					throw new Error('expected archived event ledger table');
				const archivedRows = await target.query<{
					event_id: string;
					row: string;
				}>(
					`SELECT event_id, row_to_json(e)::text AS row FROM ${quoteIdent(schema)}.${quoteIdent(archivedEvent)} e ORDER BY event_id`,
				);
				expect(archivedRows.rows).toEqual(sourceEventRows);
				const archiveAccess = await target.query<{ public_select: boolean }>(
					"SELECT coalesce(bool_or(access.grantee = 0), false) AS public_select FROM pg_catalog.pg_class relation CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))) access WHERE relation.oid = $1::regclass AND access.privilege_type = 'SELECT'",
					[`${quoteIdent(schema)}.${quoteIdent(archivedEvent)}`],
				);
				expect(archiveAccess.rows[0]?.public_select).toBe(false);
				await expect(
					target.query(
						`INSERT INTO ${quoteIdent(schema)}.${quoteIdent(archivedEvent)} DEFAULT VALUES`,
					),
					'archived restored history must be trigger-enforced read-only',
				).rejects.toThrow('dbsp archived ledger is read-only');
				for (const mutation of [
					`UPDATE ${quoteIdent(schema)}.${quoteIdent(archivedEvent)} SET event_id = event_id`,
					`DELETE FROM ${quoteIdent(schema)}.${quoteIdent(archivedEvent)}`,
				])
					await expect(target.query(mutation)).rejects.toThrow(
						'dbsp archived ledger is read-only',
					);
			} finally {
				await source?.end();
				await target?.end();
				await rm(temporary, { recursive: true, force: true });
				await dropDatabase(admin, sourceDatabase);
				await dropDatabase(admin, targetDatabase);
				await admin.end();
			}
		}, 90_000);

		it('SC-44: a schema-only dump restored to another database refuses on the recorded lineage tuple', async () => {
			const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
			const sourceDatabase = unique('dbsp_lineage_schema_source');
			const targetDatabase = unique('dbsp_lineage_schema_target');
			const schema = unique('lineage_schema');
			let source: pg.Pool | undefined;
			let target: pg.Pool | undefined;
			try {
				await createDatabase(admin, sourceDatabase);
				await createDatabase(admin, targetDatabase);
				source = new pg.Pool({ connectionString: databaseUrl(sourceDatabase) });
				await source.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
				await source.query(
					`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
				);
				await source.query(
					`CREATE TABLE ${quoteIdent(schema)}.${quoteIdent('application_table')} (id integer PRIMARY KEY)`,
				);
				await runPgReinitializePreflight({
					pool: source,
					schemas: [schema],
					declarations: declarations(schema, sourceDatabase),
					writeAdoptionFile: async () => {},
				});
				await source.end();
				source = undefined;
				await dumpAndRestoreInLocalPostgresContainer({
					sourceDatabase,
					targetDatabase,
					schema,
				});
				target = new pg.Pool({ connectionString: databaseUrl(targetDatabase) });
				const planned = await planEnumAdd(
					target,
					databaseUrl(targetDatabase),
					schema,
				);
				const refused = await runApply(
					planned.runId,
					{
						db: databaseUrl(targetDatabase),
						planDigest: planned.planDigest,
						accept: planned.plan.assumptions.map(
							(assumption) => assumption.class,
						),
					},
					target,
				);
				expect(
					JSON.stringify(refused),
					'schema-only restoration must refuse against the ledger-recorded tuple',
				).toContain('dbsp preflight --reinitialize');
				const marker = await target.query<{ version: number }>(
					`SELECT version FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_MARKER_TABLE)}`,
				);
				expect(
					marker.rows,
					'the restored ledger must remain readable instead of being silently replaced',
				).toHaveLength(1);
			} finally {
				await source?.end();
				await target?.end();
				await dropDatabase(admin, sourceDatabase);
				await dropDatabase(admin, targetDatabase);
				await admin.end();
			}
		}, 90_000);
	},
);
