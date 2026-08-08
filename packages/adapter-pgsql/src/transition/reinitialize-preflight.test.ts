import type {
	DeclarableResourceAddress,
	DeclarationSet,
	LedgerAddress,
	LedgerHome,
	ReinitializePreflightScopeReport,
} from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import type { ReinitializePreflightScopeInspection } from './reinitialize-preflight.js';
import {
	assembleReinitializePreflightScopeReports,
	classifyPgLedgerMarker,
	isPgReinitializeScopeAccessDenied,
	processReinitializePreflightScopes,
	REINITIALIZE_PREFLIGHT_LOCK_TIMEOUT_SQL,
	renderReinitializePreflightCreationGrantSql,
	runPgReinitializePreflight,
	selectReinitializeAdoptionCandidates,
} from './reinitialize-preflight.js';

const table = (name: string): LedgerAddress => ({
	scope: 'schema',
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant_a',
	kind: 'table',
	name,
});

function key(address: LedgerAddress): string {
	return JSON.stringify([
		address.engine,
		address.database,
		address.schema ?? null,
		address.parent ?? null,
		address.kind,
		address.name,
	]);
}

const declarationAddress = (
	name: string,
): DeclarableResourceAddress<'table'> => ({
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant_a',
	kind: 'table',
	name,
});

describe('reinitialize-preflight pure decisions', () => {
	it('classifies only the current marker as current and treats a missing marker as absent', () => {
		expect(classifyPgLedgerMarker([1])).toEqual({ kind: 'current' });
		expect(classifyPgLedgerMarker([0])).toEqual({
			kind: 'older',
			version: 0,
		});
		expect(classifyPgLedgerMarker([2])).toEqual({
			kind: 'future',
			version: 2,
		});
		expect(classifyPgLedgerMarker([1, 2])).toEqual({
			kind: 'mixed',
			versions: [1, 2],
		});
		expect(classifyPgLedgerMarker(undefined)).toEqual({ kind: 'absent' });
	});

	it('classifies scope access denials by SQLSTATE, not error-message text', () => {
		expect(
			isPgReinitializeScopeAccessDenied(
				Object.assign(new Error('arbitrary server wording'), { code: '42501' }),
			),
		).toBe(true);
		expect(
			isPgReinitializeScopeAccessDenied(
				Object.assign(new Error('schema is unavailable'), { code: '3F000' }),
			),
		).toBe(true);
		expect(
			isPgReinitializeScopeAccessDenied(
				new Error('permission denied for schema denied'),
			),
		).toBe(false);
	});

	it('assembles one closed outcome for every requested scope', () => {
		const database: LedgerHome = { scope: 'database' };
		const tenant: LedgerHome = { scope: 'schema', schema: 'tenant_a' };
		const homes = [database, tenant];
		const completed = new Map<string, ReinitializePreflightScopeReport>([
			[
				'database',
				{
					ledger: database,
					outcome: 'unchanged' as const,
					marker: { kind: 'current' as const },
				},
			],
		]);
		const markers = new Map([
			['database', { kind: 'current' as const }],
			['schema:tenant_a', { kind: 'absent' as const }],
		]);
		expect(
			assembleReinitializePreflightScopeReports(homes, completed, markers),
		).toEqual([
			completed.get('database'),
			{
				ledger: tenant,
				outcome: 'not-attempted',
				marker: { kind: 'absent' },
			},
		]);
	});

	it('continues after an inspection access denial and retains its verbatim reason', async () => {
		const database: ReinitializePreflightScopeInspection = {
			home: { scope: 'database' },
			marker: { kind: 'current' },
		};
		const denied: ReinitializePreflightScopeInspection = {
			home: { scope: 'schema', schema: 'denied' },
			marker: { kind: 'absent' },
			accessFailure: 'permission denied for schema denied (SQLSTATE 42501)',
		};
		const ok: ReinitializePreflightScopeInspection = {
			home: { scope: 'schema', schema: 'ok' },
			marker: { kind: 'absent' },
		};
		const process = vi.fn(
			async (
				inspection: ReinitializePreflightScopeInspection,
			): Promise<ReinitializePreflightScopeReport> => {
				if (inspection === database)
					return {
						ledger: inspection.home,
						outcome: 'unchanged',
						marker: inspection.marker,
					};
				return {
					ledger: inspection.home,
					outcome: 'current',
					marker: inspection.marker,
				};
			},
		);

		expect(
			await processReinitializePreflightScopes([database, denied, ok], process),
		).toEqual([
			{ ledger: database.home, outcome: 'unchanged', marker: database.marker },
			{
				ledger: denied.home,
				outcome: 'failed',
				marker: denied.marker,
				refusal: {
					code: 'reinitialize-preflight-failed',
					detail: 'permission denied for schema denied (SQLSTATE 42501)',
				},
				reason: {
					step: 'marker',
					message: 'permission denied for schema denied (SQLSTATE 42501)',
				},
			},
			{ ledger: ok.home, outcome: 'current', marker: ok.marker },
		]);
		expect(process).toHaveBeenCalledTimes(2);
		expect(process).toHaveBeenLastCalledWith(ok);
	});

	it('refuses the full run when marker content is unreadable', async () => {
		const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
			if (sql.startsWith('SELECT to_regclass')) {
				return {
					rows: [
						{
							relation:
								typeof values?.[0] === 'string' &&
								values[0].startsWith('"dbsp_meta"')
									? 'dbsp_meta.dbsp_ledger_marker'
									: null,
						},
					],
				};
			}
			if (sql.startsWith('SELECT version FROM'))
				return { rows: [{ version: 'not-an-integer' }] };
			return { rows: [] };
		});

		const report = await runPgReinitializePreflight({
			pool: { connect: async () => ({ query }) },
			schemas: ['ok'],
			declarations: { version: 1, digest: 'empty', declarations: [] },
			writeAdoptionFile: async () => {},
		});

		expect(report).toEqual({
			scopes: [
				{
					ledger: { scope: 'database' },
					outcome: 'failed',
					marker: {
						kind: 'unreadable',
						reason: 'marker version is not an integer',
					},
					refusal: {
						code: 'reinitialize-preflight-marker-not-current',
						detail:
							'reinitialize-preflight refuses unreadable marker: marker version is not an integer',
					},
					reason: {
						step: 'marker',
						message:
							'reinitialize-preflight refuses unreadable marker: marker version is not an integer',
					},
				},
				{
					ledger: { scope: 'schema', schema: 'ok' },
					outcome: 'not-attempted',
					marker: { kind: 'absent' },
				},
			],
			adoptionCandidates: [],
		});
		expect(query).toHaveBeenCalledWith('SELECT to_regclass($1) AS relation', [
			'"ok"."dbsp_ledger_marker"',
		]);
	});

	it('selects exactly DSL declarations that have no chain', () => {
		const declarations: DeclarationSet = {
			version: 1,
			digest: 'set',
			declarations: [
				{
					address: declarationAddress('covered'),
					fragment: { name: 'covered' },
					digest: 'a',
				},
				{
					address: declarationAddress('candidate'),
					fragment: { name: 'candidate' },
					digest: 'b',
				},
			],
		};
		const candidates = selectReinitializeAdoptionCandidates(
			declarations,
			new Set([key(table('covered'))]),
		);
		expect(candidates).toEqual([
			{
				address: table('candidate'),
				declaration: { value: { name: 'candidate' }, digest: 'b' },
			},
		]);
	});

	it('bounds object-lock waits and preserves the PostgreSQL timeout refusal', async () => {
		const lockTimeout = new Error('canceling statement due to lock timeout');
		const query = vi.fn(async (sql: string) => {
			if (sql.includes('pg_is_in_recovery'))
				return {
					rows: [
						{
							in_recovery: false,
							default_transaction_read_only: 'off',
							transaction_read_only: 'off',
						},
					],
				};
			if (sql.startsWith('SELECT to_regclass'))
				return { rows: [{ relation: null }] };
			if (sql.includes('pg_try_advisory_xact_lock'))
				return { rows: [{ locked: true }] };
			if (sql.startsWith('CREATE SCHEMA')) throw lockTimeout;
			return { rows: [] };
		});
		const release = vi.fn();
		const report = await runPgReinitializePreflight({
			pool: { connect: async () => ({ query, release }) },
			schemas: [],
			declarations: { version: 1, digest: 'empty', declarations: [] },
			writeAdoptionFile: async () => {},
		});

		expect(query.mock.calls.map(([sql]) => sql)).toContain(
			REINITIALIZE_PREFLIGHT_LOCK_TIMEOUT_SQL,
		);
		expect(report.scopes).toEqual([
			expect.objectContaining({
				ledger: { scope: 'database' },
				outcome: 'failed',
				reason: {
					step: 'create',
					message: 'canceling statement due to lock timeout',
				},
				refusal: expect.objectContaining({
					detail: 'canceling statement due to lock timeout',
				}),
			}),
		]);
		expect(JSON.parse(JSON.stringify(report.scopes[0]))).toMatchObject({
			outcome: 'failed',
			reason: {
				step: 'create',
				message: 'canceling statement due to lock timeout',
			},
		});
		expect(release).toHaveBeenCalledTimes(2);
	});

	it('renders creation ownership and PUBLIC revocations without tenant grants', () => {
		const sql = renderReinitializePreflightCreationGrantSql({
			scope: 'schema',
			schema: 'tenant_a',
		}).join('\n');
		expect(sql).toContain(
			'ALTER TABLE "tenant_a"."dbsp_ledger_event" OWNER TO CURRENT_USER',
		);
		expect(sql).toContain(
			'REVOKE ALL ON TABLE "tenant_a"."dbsp_ledger_event" FROM PUBLIC',
		);
		expect(sql).not.toContain('GRANT ');
	});
});
