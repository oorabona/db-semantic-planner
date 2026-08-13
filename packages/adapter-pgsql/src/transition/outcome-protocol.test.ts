import { validateNormalizedManagedStepManifest } from '@dbsp/core';
import type {
	LedgerChainMember,
	LedgerReservationRow,
	OutcomeClaimPlan,
} from '@dbsp/types';
import { refusalFor } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import type { PgLockedRun } from './outcome-protocol.js';
import {
	appendPgOutcomeResolution,
	checkApprovalScope,
	checkDigestBinding,
	checkLiveAdmissionForNextRoundCompatibilityPath,
	checkValidatedManifest,
	executePgAdmittedOperation,
	lockPgJournalRunForNextRoundCompatibilityPath,
	mintAdmittedPermitForNextRoundCompatibilityPath,
	PgCommitAcknowledgementAmbiguousError,
	recoverPgAdmittedReaddressPair,
	runPgNonTransactionalOutcome,
	runPgTransactionalOutcome,
	withPgTransitionTransaction,
} from './outcome-protocol.js';

// @ts-expect-error PgLockedRun is minted only at the journal-load/run-lock bridge.
const structurallyBuiltLockedRun: PgLockedRun = {
	runId: 'caller-string-run',
	planDigest: 'caller-string-digest',
};
void structurallyBuiltLockedRun;

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
			claimSpecies: 'sql-bearing',
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
			if (statement.includes('pg_backend_pid()::text AS backend_id'))
				return { rows: [{ backend_id: '42', transaction_id: '7' }] };
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
	it('OBL-AUTH1 refuses a JavaScript-fabricated locked run at the admitted facade', async () => {
		const result = await executePgAdmittedOperation(
			{ query: vi.fn() },
			{
				run: {
					runId: 'fabricated-run',
					planDigest: 'fabricated-digest',
				} as PgLockedRun,
				approval: { approvals: [] },
				operation: { kind: 'single-outcome', request: {} } as never,
			},
		);
		expect(result).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason: 'admitted operation refuses an unbound locked journal run',
		});
	});

	it('admits an empty live supplemental closure member beside its manifest-declared destructive root', () => {
		const root = request('destructive-root').plan;
		const validation = validateNormalizedManagedStepManifest([
			{
				stepKey: 'destructive-root',
				order: 0,
				segmentId: 'destructive-root-segment',
				dependencyOrder: [],
				address: { ...address, kind: 'table' as const },
				claimKind: 'intent',
				plannedClaimKeys: [root.plannedClaimKey ?? ''],
				statementBundle: {
					statements: root.statementBundle.statements.map((statement) => ({
						...statement,
					})),
				},
				classification: 'data-destructive',
				requiresVacancy: false,
				replayPolicy: 'recorded',
			},
		]);
		if (!validation.ok) throw new Error(validation.detail);
		const supplemental: OutcomeClaimPlan = {
			...root,
			claimId: 'live-supplemental-sequence',
			claimSpecies: 'cascade-covered',
			rootClaimId: root.claimId,
			plannedClaimKey: 'closure:sequence:accounts_id_seq',
			address: { ...address, kind: 'sequence', name: 'accounts_id_seq' },
			statementBundle: { statements: [] },
		};

		expect(
			checkValidatedManifest({
				manifest: validation.manifest,
				expectedPlans: [root],
				supplementalPlans: [supplemental],
			}),
		).not.toHaveProperty('kind');
	});

	it('refuses a live supplemental closure member that smuggles SQL', () => {
		const root = request('destructive-root').plan;
		const validation = validateNormalizedManagedStepManifest([
			{
				stepKey: 'destructive-root',
				order: 0,
				segmentId: 'destructive-root-segment',
				dependencyOrder: [],
				address: { ...address, kind: 'table' as const },
				claimKind: 'intent',
				plannedClaimKeys: [root.plannedClaimKey ?? ''],
				statementBundle: root.statementBundle,
				classification: 'data-destructive',
				requiresVacancy: false,
				replayPolicy: 'recorded',
			},
		]);
		if (!validation.ok) throw new Error(validation.detail);
		const supplemental: OutcomeClaimPlan = {
			...root,
			claimId: 'live-supplemental-sequence',
			claimSpecies: 'cascade-covered',
			rootClaimId: root.claimId,
			plannedClaimKey: 'closure:sequence:accounts_id_seq',
			address: { ...address, kind: 'sequence', name: 'accounts_id_seq' },
			statementBundle: {
				statements: [
					{ ordinal: 0, sql: 'DROP SEQUENCE tenant.accounts_id_seq' },
				],
			},
		} as unknown as OutcomeClaimPlan;

		expect(
			checkValidatedManifest({
				manifest: validation.manifest,
				expectedPlans: [root],
				supplementalPlans: [supplemental],
			}),
		).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason:
				'admitted operation refuses supplemental closure member closure:sequence:accounts_id_seq with a non-empty statement bundle',
		});
	});

	it('attributes a missing destructive acceptance before a scoped rejection', () => {
		const planDigest = 'reviewed-plan';
		const operation = {
			kind: 'destructive-outcome' as const,
			request: {
				...request('destructive-claim'),
				plan: { ...request('destructive-claim').plan, address },
				members: [],
			} as never,
			readBackAndResolve: async () => ({
				rootClaimId: 'destructive-claim',
				members: [],
				reservations: [],
			}),
		};
		const run = lockPgJournalRunForNextRoundCompatibilityPath({
			runId: 'reviewed-run',
			planDigest,
		});

		expect(
			checkApprovalScope({
				run,
				approval: { approvals: [] },
				operation,
			}),
		).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason: 'operator acceptance is absent',
		});
		expect(
			checkApprovalScope({
				run,
				approval: {
					approvals: [
						{
							class: `destructive-plan-accepted:${planDigest}`,
							withinScope: [{ schema: 'another_schema' }],
						},
					],
				},
				operation,
			}),
		).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason:
				'admitted operation refuses destructive approval outside its scope or trust root',
		});
	});

	it('refuses a destructive grant whose trust root differs from the declared policy root', () => {
		const planDigest = 'trust-root-bound-plan';
		const operation = {
			kind: 'destructive-outcome' as const,
			request: { ...request('trust-root-claim'), members: [] } as never,
			readBackAndResolve: async () => ({
				rootClaimId: 'trust-root-claim',
				members: [],
				reservations: [],
			}),
		};
		expect(
			checkApprovalScope({
				run: lockPgJournalRunForNextRoundCompatibilityPath({
					runId: 'trust-root-run',
					planDigest,
				}),
				approval: {
					declaredTrustRoot: { kind: 'policy', policyId: 'reviewed-policy' },
					approvals: [
						{
							class: `destructive-plan-accepted:${planDigest}`,
							fromTrustRoot: { kind: 'policy', policyId: 'attacker-policy' },
						},
					],
				},
				operation,
			}),
		).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason:
				'admitted operation refuses destructive approval outside its scope or trust root',
		});
	});

	it('does not let a table A approval-scope verdict mint a permit for table B', async () => {
		const tableA = {
			scope: 'schema' as const,
			engine: 'postgresql' as const,
			database: 'app',
			schema: 'tenant',
			kind: 'table' as const,
			name: 'accounts',
		};
		const tableB = { ...tableA, name: 'audit_log' };
		const planDigest = 'scope-bound-plan';
		const planA: OutcomeClaimPlan = {
			claimId: 'scope-bound-claim-a',
			claimSpecies: 'sql-bearing',
			plannedClaimKey: 'scope-bound-step-a/root',
			address: tableA,
			claimKind: 'intent',
			requiresVacancy: true,
			statementBundle: {
				statements: [
					{ ordinal: 0, sql: 'ALTER TABLE tenant.accounts ADD x integer' },
				],
			},
		};
		const planB: OutcomeClaimPlan = {
			claimId: 'scope-bound-claim-b',
			claimSpecies: 'sql-bearing',
			plannedClaimKey: 'scope-bound-step-b/root',
			address: tableB,
			claimKind: 'intent',
			requiresVacancy: true,
			statementBundle: {
				statements: [
					{ ordinal: 0, sql: 'ALTER TABLE tenant.audit_log ADD x integer' },
				],
			},
		};
		const validation = validateNormalizedManagedStepManifest([
			{
				stepKey: 'scope-bound-step-b',
				order: 0,
				segmentId: 'scope-bound-segment',
				dependencyOrder: [],
				address: tableB,
				claimKind: 'intent',
				plannedClaimKeys: ['scope-bound-step-b/root'],
				statementBundle: planB.statementBundle,
				classification: 'non-destructive',
				requiresVacancy: true,
				replayPolicy: 'recorded',
			},
		]);
		if (!validation.ok) throw new Error(validation.detail);
		const run = lockPgJournalRunForNextRoundCompatibilityPath({
			runId: 'scope-bound-run',
			planDigest,
		});
		const operationA = {
			kind: 'single-outcome' as const,
			request: {
				...request(planA.claimId),
				plan: planA,
				resolution: {
					eventId: 'scope-bound-a',
					eventKind: 'observed' as const,
				},
			},
		};
		const operationB = {
			kind: 'single-outcome' as const,
			request: {
				...request(planB.claimId),
				plan: planB,
				resolution: {
					eventId: 'scope-bound-b',
					eventKind: 'observed' as const,
				},
			},
		};
		const digestBinding = checkDigestBinding({
			run,
			recomputedPlanDigest: planDigest,
		});
		const validatedManifest = checkValidatedManifest({
			manifest: validation.manifest,
			expectedPlans: [planB],
		});
		const approvalScope = checkApprovalScope({
			run,
			approval: { approvals: [] },
			operation: operationA,
		});
		const liveAdmission = await checkLiveAdmissionForNextRoundCompatibilityPath(
			recorder(),
			operationA.request,
		);
		if (
			'kind' in digestBinding ||
			'kind' in validatedManifest ||
			'kind' in approvalScope ||
			'kind' in liveAdmission
		)
			throw new Error('scope-binding setup unexpectedly refused');

		expect(() =>
			mintAdmittedPermitForNextRoundCompatibilityPath(
				{
					...operationB.request,
					token: {} as never,
					kind: 'admitted-outcome-claim',
					stableStateBeforeClaim: 'unknown',
				},
				digestBinding,
				validatedManifest,
				approvalScope,
				liveAdmission,
			),
		).toThrow(
			'admitted permit refuses an approval scope verdict for another operation',
		);
	});

	it('keeps a lost COMMIT acknowledgement transport-ambiguous without a rollback', async () => {
		const sql: string[] = [];
		const executor = {
			query: vi.fn(async (statement: string) => {
				sql.push(statement);
				if (statement === 'COMMIT') throw new Error('connection reset');
				return { rows: [] };
			}),
		};
		await expect(
			withPgTransitionTransaction(executor, async () => 'completed'),
		).rejects.toBeInstanceOf(PgCommitAcknowledgementAmbiguousError);
		expect(sql).toEqual(['BEGIN', 'COMMIT']);
	});

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

	it('serializes every paired-recovery query on its checked-out client before release', async () => {
		let inFlight = 0;
		const overlap = new Error(
			'client.query called while the prior query is active',
		);
		const session = {
			query: vi.fn((_statement: string) => {
				if (inFlight !== 0) return Promise.reject(overlap);
				inFlight += 1;
				return new Promise<{
					readonly rows: readonly Record<string, unknown>[];
				}>((resolve) => {
					queueMicrotask(() => {
						inFlight -= 1;
						resolve({ rows: [] });
					});
				});
			}),
		};
		const release = vi.fn(() => expect(inFlight).toBe(0));
		const pool = {
			query: vi.fn(async () => {
				throw new Error('a pool query must not enter paired recovery');
			}),
			connect: vi.fn(async () => ({ ...session, release })),
		};

		await expect(
			recoverPgAdmittedReaddressPair(pool, {
				pairId: 'pair:serialized-recovery',
				executionId: 'execution:serialized-recovery',
				reservations: [],
				assess: vi.fn(),
			}),
		).resolves.toEqual({
			kind: 'pending',
			reason:
				're-address recovery reservation subset is not the durable execution closure',
		});
		expect(pool.connect).toHaveBeenCalledOnce();
		expect(pool.query).not.toHaveBeenCalled();
		expect(session.query).toHaveBeenCalledWith('BEGIN');
		expect(session.query).toHaveBeenCalledWith('ROLLBACK');
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

	it('refuses a mid-window non-transactional live-admission attack before executing or DDL', async () => {
		const executor = recorder();
		const result = await runPgNonTransactionalOutcome(executor, {
			...request('nontransactional-live-attack'),
			executingEventId: 'nontransactional-live-attack-executing',
			resolution: {
				eventId: 'nontransactional-live-attack-refused',
				eventKind: 'observed',
			},
			verifyLiveAdmission: async () => ({
				kind: 'outcome-protocol-refused',
				reason: 'live controller changed after claim admission',
			}),
		});
		expect(result).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason: 'live controller changed after claim admission',
		});
		expect(executor.sql).not.toContain(
			'CREATE TABLE tenant.accounts (id integer)',
		);
		expect(executor.sql).not.toContain(
			'nontransactional-live-attack-executing',
		);
	});

	it('treats an equal resolving payload as a retry success and a different child as malformed (SC-36)', async () => {
		const input = request('resolution-retry');
		const member: Omit<LedgerChainMember, 'controller' | 'recordedAt'> = {
			eventId: 'recovery-refused',
			address,
			eventKind: 'refused',
			predecessor: 'resolution-retry',
			refusal: refusalFor('ERR-11', { address, state: 'unknown' }),
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
			refusal_code: value.refusal?.code ?? null,
			refusal_cause: value.refusal?.cause ?? null,
			refusal_state: value.refusal?.state ?? null,
			refusal_withheld_authority: value.refusal?.withheldAuthority ?? null,
			refusal_resolving_command: value.refusal?.resolvingCommand ?? null,
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
			refusal: refusalFor('ERR-11', { address, state: 'unknown' }),
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
