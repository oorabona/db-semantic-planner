import type {
	LedgerChainMember,
	LedgerReservationRow,
	OutcomeClaimPlan,
} from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import {
	appendPgOutcomeResolution,
	runPgNonTransactionalOutcome,
	runPgTransactionalOutcome,
} from './outcome-protocol.js';

const address = {
	scope: 'schema' as const,
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'table',
	name: 'accounts',
};

function request(claimId: string): {
	readonly plan: OutcomeClaimPlan;
	readonly reservations: readonly LedgerReservationRow[];
} {
	return {
		plan: {
			claimId,
			plannedClaimKey: `step:${claimId}/root`,
			address,
			claimKind: 'intent',
			statementBundle: {
				statements: [
					{ ordinal: 0, sql: 'CREATE TABLE tenant.accounts (id integer)' },
				],
			},
		},
		reservations: [
			{
				address,
				claimKind: 'intent',
				executionId: `${claimId}-execution`,
				rootClaimId: claimId,
				homeLedger: { scope: 'schema', schema: 'tenant' },
			},
		],
	};
}

function recorder(failSql?: string) {
	const sql: string[] = [];
	let claimId: string | undefined;
	return {
		sql,
		query: vi.fn(async (statement: string, params?: readonly unknown[]) => {
			sql.push(statement);
			if (statement.startsWith('SELECT to_regclass'))
				return { rows: [{ relation: 'tenant.dbsp_ledger_marker' }] };
			if (
				statement.includes('SELECT version FROM') &&
				statement.includes('dbsp_ledger_marker')
			)
				return { rows: [{ version: 1 }] };
			if (statement.includes('dbsp_ledger_identity'))
				return {
					rows: [
						{
							cluster_system_identifier: 'test-system',
							database_oid: '5',
							namespace_oid: '2200',
						},
					],
				};
			if (
				statement.startsWith(
					'SELECT (pg_catalog.pg_control_system()).system_identifier::text',
				)
			)
				return {
					rows: [
						{
							cluster_system_identifier: 'test-system',
							database_oid: '5',
							namespace_oid: '2200',
						},
					],
				};
			if (statement.includes('pg_try_advisory_xact_lock'))
				return { rows: [{ locked: true }] };
			if (statement.startsWith('SELECT event_id')) {
				return {
					rows:
						claimId === undefined
							? []
							: [
									{
										event_id: claimId,
										address_engine: 'postgresql',
										address_database: 'app',
										address_schema: 'tenant',
										address_parent: null,
										address_kind: 'table',
										address_name: 'accounts',
										catalogue_identity: null,
										event_kind: 'intent',
										predecessor: null,
										pair_id: null,
										declared: null,
										declared_digest: null,
										observed: null,
										observed_digest: null,
										controller: 'deployment',
										recorded_at: null,
									},
								],
				};
			}
			if (statement.includes('WITH appended AS') && claimId === undefined)
				claimId = String(params?.[0]);
			if (statement === failSql)
				throw new Error('DDL failed with PostgreSQL words');
			return { rows: [] };
		}),
	};
}

describe('PostgreSQL outcome protocol compositions', () => {
	it('keeps claim, DDL and resolution inside one transactional boundary (SC-32)', async () => {
		const executor = recorder('CREATE TABLE tenant.accounts (id integer)');
		const input = request('transactional');
		const result = await runPgTransactionalOutcome(executor, {
			...input,
			resolution: { eventId: 'transactional-observed', eventKind: 'observed' },
			vacancy: async () => ({ kind: 'vacant' }),
		});
		expect(result).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason: 'DDL failed with PostgreSQL words',
		});
		expect(executor.sql).toContain('BEGIN');
		expect(executor.sql).toContain('ROLLBACK');
		expect(executor.sql).not.toContain('COMMIT');
		const claim = executor.sql.findIndex((sql) =>
			sql.includes('WITH appended AS'),
		);
		const ddl = executor.sql.indexOf(
			'CREATE TABLE tenant.accounts (id integer)',
		);
		expect(claim).toBeGreaterThan(-1);
		expect(ddl).toBeGreaterThan(claim);
	});

	it('pins a pool-supplied claim lifecycle to one checked-out PostgreSQL client', async () => {
		const session = recorder();
		const release = vi.fn();
		const pool = {
			query: vi.fn(async () => {
				throw new Error('a pool query must not enter the outcome transaction');
			}),
			connect: vi.fn(async () => ({ ...session, release })),
		};
		const result = await runPgTransactionalOutcome(pool, {
			...request('pinned-session'),
			resolution: { eventId: 'pinned-session-observed', eventKind: 'observed' },
			vacancy: async () => ({ kind: 'vacant' }),
		});
		expect(result.kind).toBe('executed-outcome-claim');
		expect(pool.connect).toHaveBeenCalledOnce();
		expect(pool.query).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledOnce();
	});

	it('uses a caller-supplied checked-out client without reconnecting it', async () => {
		const executor = {
			...recorder(),
			connect: vi.fn(async () => {
				throw new Error('a checked-out client must not reconnect');
			}),
			release: vi.fn(),
		};
		const result = await runPgTransactionalOutcome(executor, {
			...request('caller-session'),
			resolution: { eventId: 'caller-session-observed', eventKind: 'observed' },
			vacancy: async () => ({ kind: 'vacant' }),
		});
		expect(result.kind).toBe('executed-outcome-claim');
		expect(executor.connect).not.toHaveBeenCalled();
		expect(executor.release).not.toHaveBeenCalled();
	});

	it('names the reviewed claim when a token sees a closed chain', async () => {
		const source = recorder();
		const executor = {
			query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
				if (sql.startsWith('SELECT event_id')) return { rows: [] };
				return source.query(sql, params);
			}),
		};
		const result = await runPgTransactionalOutcome(executor, {
			...request('opaque-hash'),
			resolution: { eventId: 'opaque-hash-observed', eventKind: 'observed' },
			vacancy: async () => ({ kind: 'vacant' }),
		});
		expect(result).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason:
				'claim token for opaque-hash (plannedClaimKey step:opaque-hash/root; claim kind intent; address accounts) is no longer valid because its claim is closed',
		});
	});

	it('commits executing before the observable gate and first non-transactional send', async () => {
		const executor = recorder();
		const input = request('nontransactional');
		let checkpoint = -1;
		const result = await runPgNonTransactionalOutcome(executor, {
			...input,
			executingEventId: 'nontransactional-executing',
			resolution: {
				eventId: 'nontransactional-observed',
				eventKind: 'observed',
			},
			vacancy: async () => ({ kind: 'vacant' }),
			onExecutingCommitted: () => {
				checkpoint = executor.sql.length;
			},
		});
		expect(result.kind).toBe('executed-outcome-claim');
		expect(checkpoint).toBeGreaterThan(0);
		expect(executor.sql[checkpoint - 1]).toBe('COMMIT');
		expect(executor.sql.slice(checkpoint)).toContain(
			'CREATE TABLE tenant.accounts (id integer)',
		);
	});

	it('treats an equal resolving payload as a retry success and a different child as malformed (SC-36)', async () => {
		const input = request('resolution-retry');
		const member: Omit<LedgerChainMember, 'controller' | 'recordedAt'> = {
			eventId: 'recovery-refused',
			address,
			eventKind: 'refused',
			predecessor: 'resolution-retry',
		};
		const row = (value: LedgerChainMember) => ({
			event_id: value.eventId,
			address_engine: value.address.engine,
			address_database: value.address.database,
			address_schema: value.address.schema,
			address_parent: null,
			address_kind: value.address.kind,
			address_name: value.address.name,
			catalogue_identity: null,
			event_kind: value.eventKind,
			predecessor: value.predecessor ?? null,
			pair_id: null,
			declared: null,
			declared_digest: null,
			observed: null,
			observed_digest: null,
			controller: value.controller,
			recorded_at: null,
		});
		const existing: LedgerChainMember = { ...member, controller: 'deployment' };
		const equal = {
			query: vi.fn(async (sql: string) => {
				if (sql.startsWith('SELECT event_id')) return { rows: [row(existing)] };
				throw new Error(
					'duplicate key value violates dbsp_ledger_event_one_child',
				);
			}),
		};
		await expect(
			appendPgOutcomeResolution(
				equal,
				{ scope: 'schema', schema: 'tenant' },
				member,
				'resolution-retry',
				input.reservations,
			),
		).resolves.toEqual({ kind: 'already-appended-outcome-resolution' });

		const differing = {
			query: vi.fn(async (sql: string) => {
				if (sql.startsWith('SELECT event_id'))
					return { rows: [row({ ...existing, eventKind: 'absent' })] };
				throw new Error(
					'duplicate key value violates dbsp_ledger_event_one_child',
				);
			}),
		};
		await expect(
			appendPgOutcomeResolution(
				differing,
				{ scope: 'schema', schema: 'tenant' },
				member,
				'resolution-retry',
				input.reservations,
			),
		).resolves.toMatchObject({ kind: 'malformed-outcome-resolution' });
	});

	it('leaves a one-shot resolving append fault retryable and writes one terminal member (SC-37)', async () => {
		const input = request('failpoint-retry');
		const member: Omit<LedgerChainMember, 'controller' | 'recordedAt'> = {
			eventId: 'failpoint-refused',
			address,
			eventKind: 'refused',
			predecessor: 'failpoint-retry',
		};
		let failures = 1;
		let appended = 0;
		const executor = {
			query: vi.fn(async (sql: string) => {
				if (sql.startsWith('SELECT event_id')) return { rows: [] };
				if (sql.includes('WITH appended AS')) {
					if (failures > 0) {
						failures -= 1;
						throw new Error('failpoint targeted event insert');
					}
					appended += 1;
				}
				return { rows: [] };
			}),
		};
		await expect(
			appendPgOutcomeResolution(
				executor,
				{ scope: 'schema', schema: 'tenant' },
				member,
				'failpoint-retry',
				input.reservations,
			),
		).rejects.toThrow('failpoint targeted event insert');
		await expect(
			appendPgOutcomeResolution(
				executor,
				{ scope: 'schema', schema: 'tenant' },
				member,
				'failpoint-retry',
				input.reservations,
			),
		).resolves.toEqual({ kind: 'appended-outcome-resolution' });
		expect(appended).toBe(1);
	});

	it('keeps the reservation open when recovery appends indeterminate (SC-39)', async () => {
		const input = request('indeterminate-claim');
		const sql: string[] = [];
		const executor = {
			query: vi.fn(async (statement: string) => {
				sql.push(statement);
				return { rows: [] };
			}),
		};
		await expect(
			appendPgOutcomeResolution(
				executor,
				{ scope: 'schema', schema: 'tenant' },
				{
					eventId: 'indeterminate-event',
					address,
					eventKind: 'indeterminate',
					predecessor: 'indeterminate-claim-executing',
				},
				'indeterminate-claim',
				input.reservations,
			),
		).resolves.toEqual({ kind: 'appended-outcome-resolution' });
		expect(sql).toHaveLength(1);
		expect(sql[0]).not.toContain('DELETE FROM');
	});
});
