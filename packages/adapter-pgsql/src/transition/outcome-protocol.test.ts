import { validateNormalizedManagedStepManifest } from '@dbsp/core';
import { mintDurablyLoadedRun } from '@dbsp/core/internal';
import type {
	LedgerAddress,
	LedgerChainMember,
	LedgerReservationRow,
	OutcomeClaimPlan,
} from '@dbsp/types';
import { refusalFor, sameLedgerAddress } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./ledger.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./ledger.js')>()),
	classifyPgLedgerPhysicalShape: vi.fn(async () => ({ kind: 'verified' })),
	validatePgLedgerPhysicalShape: vi.fn(async () => undefined),
}));

import type { PgLockedRun } from './outcome-protocol.js';
import {
	appendPgOutcomeResolution,
	assertPgPairedReaddressTargetWitness,
	checkApprovalScope,
	checkLiveAdmission,
	checkValidatedManifest,
	executePgAdmittedOperation,
	type GeneratedDeclarationPayload,
	type GeneratedIdentityObservation,
	type GeneratedStructuralObservation,
	lockPgJournalRun,
	mintAdmittedPermit,
	PgCommitAcknowledgementAmbiguousError,
	PgCommitDeterministicFailureError,
	readPgOutcomeRecoveryReadBack,
	readPgPairedReaddressObserved,
	recoverPgOutcomeClaim,
	withPgOutcomeSession,
	withPgTransitionTransaction,
} from './outcome-protocol.js';

const generatedIdentityObservation = {
	value: { kind: 'table', name: 'orders' },
	digest: 'identity-observation',
	payloadKind: 'generated-identity-observation',
} satisfies GeneratedIdentityObservation;
const generatedDeclaration = {
	value: { kind: 'table', name: 'orders' },
	digest: 'declaration',
	payloadKind: 'generated-declaration',
} satisfies GeneratedDeclarationPayload;
const generatedStructuralObservation = {
	value: { columns: [] },
	digest: 'structural-observation',
	payloadKind: 'generated-structural-observation',
} satisfies GeneratedStructuralObservation;
// @ts-expect-error Identity observations cannot occupy declaration slots.
const identityInDeclarationSlot: GeneratedDeclarationPayload =
	generatedIdentityObservation;
// @ts-expect-error Identity observations cannot occupy structural slots.
const identityInStructuralSlot: GeneratedStructuralObservation =
	generatedIdentityObservation;
void generatedDeclaration;
void generatedStructuralObservation;
void identityInDeclarationSlot;
void identityInStructuralSlot;

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

describe('paired re-address observed evidence', () => {
	it('persists the structural verifier projection instead of address-only observed data', async () => {
		const projection = {
			value: { columns: [{ name: 'id', type: 'integer', nullable: false }] },
			digest: 'projection-digest',
			payloadKind: 'generated-structural-observation' as const,
		};
		await expect(
			readPgPairedReaddressObserved({} as never, {
				targetObserved: {
					value: { kind: 'table', name: 'orders_archive' },
					digest: 'address-only-digest',
					payloadKind: 'generated-identity-observation',
				},
				postDdlReadBack: vi.fn(async () => projection),
			}),
		).resolves.toEqual(projection);
	});

	it('refuses paired appends when a final target identity differs from its witness', () => {
		const target = { ...address, name: 'orders_archive' };
		expect(() =>
			assertPgPairedReaddressTargetWitness(
				[
					{
						source: address,
						target,
						catalogueIdentity: {
							engine: 'postgresql',
							format: 1,
							value: { oid: '42' },
						},
					},
				],
				{ source: address, target },
				{
					...target,
					catalogueIdentity: {
						engine: 'postgresql',
						format: 1,
						value: { oid: '99' },
					},
				},
			),
		).toThrow('re-address target identity changed');
	});
});

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

function lockedRun(runId: string, planDigest: string) {
	return lockPgJournalRun(
		mintDurablyLoadedRun({
			runId,
			planDigest,
			targetContextDigest: 'target',
			databaseId: 'app',
			coreVersion: 'test',
			startedAt: '2026-01-01T00:00:00.000Z',
			replayability: 'replayable',
		}),
	);
}

async function runAdmitted(
	executor: never,
	requestInput: ReturnType<typeof request> & Record<string, unknown>,
): Promise<any> {
	const plan = requestInput.plan;
	const manifest = validateNormalizedManagedStepManifest([
		{
			stepKey: plan.plannedClaimKey ?? plan.claimId,
			order: 0,
			segmentId: plan.claimId,
			dependencyOrder: [],
			address: plan.address as never,
			claimKind: plan.claimKind,
			plannedClaimKeys: [plan.plannedClaimKey ?? plan.claimId],
			statementBundle: plan.statementBundle,
			classification: 'non-destructive',
			requiresVacancy: plan.requiresVacancy ?? false,
			replayPolicy: 'recorded',
		},
	]);
	if (!manifest.ok) throw new Error(manifest.detail);
	return executePgAdmittedOperation(executor, {
		run: lockedRun(plan.executionId ?? plan.claimId, plan.claimId),
		approval: { approvals: [] },
		manifest: manifest.manifest,
		recomputedPlanDigest: plan.claimId,
		operation: { kind: 'single-outcome', request: requestInput as never },
	});
}

function recorder(
	failSql?: string,
	initialClaimId?: string,
	executing = false,
	chainAddress: LedgerAddress = address,
) {
	const sql: string[] = [];
	let claimId: string | undefined = initialClaimId;
	return {
		sql,
		query: vi.fn(async (statement: string, params?: readonly unknown[]) => {
			sql.push(statement);
			if (statement.includes('FROM pg_catalog.pg_class relation'))
				return { rows: [{ oid: '42' }] };
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
				const row = (
					eventId: string,
					eventKind: string,
					predecessor: string | null,
				) => ({
					event_id: eventId,
					address_engine: chainAddress.engine,
					address_database: chainAddress.database,
					address_schema: chainAddress.schema,
					address_parent: chainAddress.parent
						? JSON.stringify(chainAddress.parent)
						: null,
					address_kind: chainAddress.kind,
					address_name: chainAddress.name,
					catalogue_identity: null,
					event_kind: eventKind,
					predecessor,
					pair_id: null,
					declared: null,
					declared_digest: null,
					observed: null,
					observed_digest: null,
					controller: 'deployment',
					recorded_at: null,
				});
				return {
					rows:
						claimId === undefined
							? []
							: [
									row(claimId, 'intent', null),
									...(executing
										? [row('executing', 'executing', claimId)]
										: []),
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
	it('OBL-AUTH6 refuses a JavaScript-forged post-lock evidence shape before permit minting', async () => {
		await expect(
			checkLiveAdmission({
				homes: [{ scope: 'schema', schema: 'tenant' }],
				backendId: 'forged-backend',
				transactionId: 'forged-transaction',
			} as never),
		).resolves.toMatchObject({
			kind: 'outcome-protocol-refused',
			reason: 'admitted permit requires authentic post-lock admission evidence',
		});
	});

	it('OBL-AUTH3 refuses JavaScript-forged cross-wired verdicts at permit minting', () => {
		const claimB = {
			kind: 'admitted-outcome-claim',
			plan: request('operation-b').plan,
			stableStateBeforeClaim: 'unknown',
			token: {},
		} as never;
		expect(() =>
			mintAdmittedPermit(
				claimB,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
			),
		).toThrow('admitted permit requires a digest-binding verdict');
	});

	it('OBL-REC1 refuses a recovery append whose forged reservation subset omits the live claim address', async () => {
		const executor = recorder(undefined, 'live-claim');
		await expect(
			recoverPgOutcomeClaim(executor as never, {
				address,
				reservations: [],
				resolutionEventId: 'forged-recovery-resolution',
				acceptedExternalDdlExclusion: false,
				readBack: async () => ({
					value: { table: 'accounts' },
					digest: 'accounts-v1',
				}),
			}),
		).resolves.toMatchObject({
			kind: 'outcome-protocol-refused',
			reason: 'outcome recovery reservation subset is not the live open claim',
		});
	});

	it('appends an absence terminal only after its final catalogue re-read', async () => {
		const executor = recorder(undefined, 'absence-claim', true);
		const query = executor.query.getMockImplementation()!;
		const sequence: string[] = [];
		const operationReadBack = vi.fn(async () => ({
			observed: { value: { table: 'accounts' }, digest: 'accounts-v1' },
			effect: 'no-effect' as const,
		}));
		executor.query.mockImplementation(async (statement, params) => {
			if (statement.includes('FROM pg_catalog.pg_class relation')) {
				sequence.push('catalogue');
				return { rows: [] };
			}
			if (statement.includes('WITH appended AS')) sequence.push('append');
			return query(statement, params);
		});
		await expect(
			recoverPgOutcomeClaim(executor as never, {
				address,
				reservations: request('absence-claim').reservations,
				resolutionEventId: 'absence-refused',
				acceptedExternalDdlExclusion: false,
				readBack: async () => ({ value: {}, digest: 'unreachable' }),
				operationReadBack,
			}),
		).resolves.toMatchObject({
			kind: 'outcome-recovery-appended',
			classification: { resolution: { eventKind: 'refused' } },
		});
		expect(sequence).toEqual(['catalogue', 'catalogue', 'append']);
		expect(operationReadBack).toHaveBeenCalledTimes(1);
	});

	it('keeps absence evidence unbound when the final catalogue read becomes present', async () => {
		const executor = recorder(undefined, 'absence-became-present');
		const query = executor.query.getMockImplementation()!;
		const operationReadBack = vi.fn(async () => ({
			observed: { value: { table: 'accounts' }, digest: 'accounts-v1' },
			effect: 'no-effect' as const,
		}));
		let catalogueReads = 0;
		executor.query.mockImplementation(async (statement, params) => {
			if (statement.includes('FROM pg_catalog.pg_class relation')) {
				catalogueReads += 1;
				return catalogueReads === 1 ? { rows: [] } : { rows: [{ oid: '42' }] };
			}
			return query(statement, params);
		});
		await expect(
			recoverPgOutcomeClaim(executor as never, {
				address,
				reservations: request('absence-became-present').reservations,
				resolutionEventId: 'absence-became-present-refused',
				acceptedExternalDdlExclusion: false,
				readBack: async () => ({
					value: { table: 'accounts' },
					digest: 'accounts-v1',
				}),
				operationReadBack,
			}),
		).resolves.toMatchObject({
			kind: 'outcome-recovery-pending',
			reason: expect.stringContaining('became present after evidence was read'),
		});
		expect(catalogueReads).toBe(2);
		expect(operationReadBack).toHaveBeenCalledTimes(1);
		expect(operationReadBack).toHaveBeenCalledWith(
			expect.anything(),
			address,
			undefined,
		);
	});

	it('keeps present evidence bound to its original identity when the final read changes', async () => {
		const indexAddress: LedgerAddress = {
			...address,
			kind: 'index',
			name: 'accounts_by_id',
			parent: address,
		};
		const initial = request('identity-changed-final-read');
		const executor = recorder(
			undefined,
			'identity-changed-final-read',
			false,
			indexAddress,
		);
		const query = executor.query.getMockImplementation()!;
		let catalogueReads = 0;
		const readBack = vi.fn(async () => ({
			value: { table: 'accounts' },
			digest: 'accounts-v1',
		}));
		executor.query.mockImplementation(async (statement, params) => {
			if (statement.includes('FROM pg_catalog.pg_class index_relation')) {
				catalogueReads += 1;
				return { rows: [{ oid: catalogueReads < 2 ? '42' : '99' }] };
			}
			return query(statement, params);
		});
		await expect(
			recoverPgOutcomeClaim(executor as never, {
				address: indexAddress,
				reservations: initial.reservations.map((reservation) => ({
					...reservation,
					address: indexAddress,
				})),
				resolutionEventId: 'identity-changed-final-read-refused',
				acceptedExternalDdlExclusion: false,
				readBack,
			}),
		).resolves.toMatchObject({
			kind: 'outcome-recovery-pending',
			reason: expect.stringContaining('changed after evidence was read'),
		});
		expect(readBack).toHaveBeenCalledWith(
			expect.anything(),
			indexAddress,
			expect.objectContaining({ value: { oid: '42' } }),
		);
		expect(catalogueReads).toBe(2);
	});

	it('concludes an index terminal without claim-bound external DDL exclusion', async () => {
		const indexAddress: LedgerAddress = {
			...address,
			kind: 'index',
			name: 'accounts_by_id',
			parent: address,
		};
		const reservation = {
			...request('index-claim').reservations[0]!,
			address: indexAddress,
			rootClaimId: 'index-claim',
		};
		const executor = recorder(undefined, 'index-claim', true, indexAddress);
		const query = executor.query.getMockImplementation()!;
		executor.query.mockImplementation(async (statement, params) => {
			if (statement.includes('FROM pg_catalog.pg_class index_relation'))
				return { rows: [{ oid: '84' }] };
			return query(statement, params);
		});
		await expect(
			recoverPgOutcomeClaim(executor as never, {
				address: indexAddress,
				reservations: [reservation],
				resolutionEventId: 'index-indeterminate',
				acceptedExternalDdlExclusion: false,
				readBack: async () => ({ value: {}, digest: 'index-v1' }),
			}),
		).resolves.toMatchObject({
			kind: 'outcome-recovery-appended',
			classification: { resolution: { eventKind: 'indeterminate' } },
		});
	});

	it('refuses an identity-less observed terminal when catalogue identity is required', async () => {
		const source = recorder();
		const executor = {
			...source,
			query: vi.fn(async (statement: string, params?: readonly unknown[]) => {
				if (statement.includes('FROM pg_catalog.pg_class relation')) {
					source.sql.push(statement);
					return { rows: [] };
				}
				return source.query(statement, params);
			}),
		};
		await expect(
			runAdmitted(executor as never, {
				...request('observed-identity-absent'),
				resolution: {
					eventId: 'observed-identity-absent-terminal',
					eventKind: 'observed',
				},
				vacancy: async () => ({ kind: 'vacant' as const }),
				recordCatalogueIdentity: true,
				readBack: async () => ({
					value: { table: 'accounts' },
					digest: 'accounts-v1',
				}),
			}),
		).resolves.toMatchObject({
			kind: 'outcome-protocol-refused',
			reason: expect.stringContaining('refuses an absent catalogue identity'),
		});
		expect(
			source.sql.some((statement) => statement.startsWith('LOCK TABLE')),
		).toBe(false);
		expect(source.sql).not.toContain('observed-identity-absent-terminal');
	});

	it('keeps the relation lock through the terminal append and clears it at COMMIT', async () => {
		const source = recorder();
		let lockHeld = false;
		let relationLockSeen = false;
		let terminalAppendWhileLocked = false;
		const executor = {
			...source,
			query: vi.fn(async (statement: string, params?: readonly unknown[]) => {
				if (statement.startsWith('LOCK TABLE')) {
					lockHeld = true;
					relationLockSeen = true;
				}
				if (statement.includes('WITH appended AS') && relationLockSeen) {
					expect(lockHeld).toBe(true);
					terminalAppendWhileLocked = true;
				}
				if (statement === 'COMMIT' || statement === 'ROLLBACK')
					lockHeld = false;
				return source.query(statement, params);
			}),
		};
		await expect(
			runAdmitted(executor as never, {
				...request('stateful-lock-lifetime'),
				resolution: {
					eventId: 'stateful-lock-lifetime-observed',
					eventKind: 'observed',
				},
				vacancy: async () => ({ kind: 'vacant' as const }),
				recordCatalogueIdentity: true,
				readBack: async () => ({
					value: { table: 'accounts' },
					digest: 'accounts-v1',
				}),
			}),
		).resolves.toMatchObject({ kind: 'executed-outcome-claim' });
		expect(terminalAppendWhileLocked).toBe(true);
		expect(lockHeld).toBe(false);
		expect(source.sql).not.toContain("SET LOCAL statement_timeout = '5000ms'");
	});

	it('keeps the public recovery read-back usable with a Pool by never issuing LOCK TABLE', async () => {
		const sql: string[] = [];
		const session = {
			query: vi.fn(async (statement: string) => {
				sql.push(statement);
				if (statement.includes('FROM pg_catalog.pg_class relation'))
					return { rows: [{ oid: '42' }] };
				return { rows: [] };
			}),
		};
		const pool = {
			query: vi.fn(async (statement: string) => {
				if (statement.startsWith('LOCK TABLE'))
					throw new Error('LOCK TABLE can only be used in transaction blocks');
				return session.query(statement);
			}),
			connect: vi.fn(async () => session),
		};
		const result = await readPgOutcomeRecoveryReadBack(
			pool as never,
			address,
			async () => {
				return { value: { table: 'accounts' }, digest: 'accounts-v1' };
			},
		);
		expect(result).toMatchObject({ kind: 'present' });
		expect(pool.query).toHaveBeenCalled();
		expect(pool.connect).not.toHaveBeenCalled();
		expect(sql.some((statement) => statement.startsWith('LOCK TABLE'))).toBe(
			false,
		);
	});

	it('classifies an absent recovery relation without attempting its lock', async () => {
		const sql: string[] = [];
		const readBack = vi.fn(async () => ({
			value: { table: 'unreachable' },
			digest: 'unreachable',
		}));
		await expect(
			readPgOutcomeRecoveryReadBack(
				{
					query: vi.fn(async (statement: string) => {
						sql.push(statement);
						if (statement.includes('FROM pg_catalog.pg_class relation'))
							return { rows: [] };
						return { rows: [] };
					}),
				} as never,
				address,
				readBack,
			),
		).resolves.toEqual({ kind: 'absent' });
		expect(readBack).not.toHaveBeenCalled();
		expect(sql.some((statement) => statement.startsWith('LOCK TABLE'))).toBe(
			false,
		);
		expect(
			sql.filter((statement) =>
				statement.includes('FROM pg_catalog.pg_class relation'),
			),
		).toHaveLength(1);
	});

	it('keeps the standalone read-back available for non-lockable kinds', async () => {
		const sql: string[] = [];
		const enumAddress = { ...address, kind: 'enum' as const, name: 'status' };
		const result = await readPgOutcomeRecoveryReadBack(
			{
				query: vi.fn(async (statement: string) => {
					sql.push(statement);
					if (statement.includes('FROM pg_catalog.pg_type type'))
						return { rows: [{ oid: '84' }] };
					return { rows: [] };
				}),
			} as never,
			enumAddress,
			async () => ({ value: { enum: 'status' }, digest: 'status-v1' }),
		);
		expect(result).toMatchObject({ kind: 'present' });
		expect(sql).not.toContain(
			'LOCK TABLE "tenant"."status" IN SHARE UPDATE EXCLUSIVE MODE',
		);
		expect(sql[0]).toContain('FROM pg_catalog.pg_type type');
	});

	it.each([
		'claim key',
		'address',
		'claim kind',
		'classification',
		'vacancy flag',
		'statement ordinal',
		'statement SQL one-byte edit',
	] as const)(
		'OBL-AUTH4 refuses a manifest mutation of %s before any token or DDL',
		(mutation) => {
			const plan = request(`manifest-${mutation}`).plan;
			const step = {
				stepKey: 'manifest-step',
				order: 0,
				segmentId: 'manifest-segment',
				dependencyOrder: [],
				address: plan.address,
				claimKind: plan.claimKind,
				plannedClaimKeys: [plan.plannedClaimKey ?? ''],
				statementBundle: plan.statementBundle,
				classification: 'non-destructive' as const,
				requiresVacancy: false,
				replayPolicy: 'recorded' as const,
			};
			const mutated = {
				...step,
				...(mutation === 'claim key'
					? { plannedClaimKeys: ['attacker-key'] }
					: mutation === 'address'
						? { address: { ...address, name: 'attacker_accounts' } }
						: mutation === 'claim kind'
							? { claimKind: 'retire-intent' as const }
							: mutation === 'classification'
								? { classification: 'data-destructive' as const }
								: mutation === 'vacancy flag'
									? { requiresVacancy: true }
									: mutation === 'statement ordinal'
										? {
												statementBundle: {
													statements: [
														{
															...plan.statementBundle.statements[0]!,
															ordinal: 1,
														},
													],
												},
											}
										: {
												statementBundle: {
													statements: [
														{
															...plan.statementBundle.statements[0]!,
															sql: `${plan.statementBundle.statements[0]!.sql} `,
														},
													],
												},
											}),
			};
			const validation = validateNormalizedManagedStepManifest([
				mutated as never,
			]);
			if (!validation.ok) {
				expect(validation.detail).toBeTruthy();
				return;
			}
			expect(
				checkValidatedManifest({
					manifest: validation.manifest,
					expectedPlans: [plan],
					expectedClassification: 'non-destructive',
				}),
			).toMatchObject({ kind: 'outcome-protocol-refused' });
		},
	);

	it('OBL-AUTH4 refuses a closure member whose species is not cascade-covered before any token or DDL', () => {
		const root = request('closure-species-root').plan;
		const validation = validateNormalizedManagedStepManifest([
			{
				stepKey: 'closure-species-step',
				order: 0,
				segmentId: 'closure-species',
				dependencyOrder: [],
				address: root.address,
				claimKind: root.claimKind,
				plannedClaimKeys: [root.plannedClaimKey ?? ''],
				statementBundle: root.statementBundle,
				classification: 'data-destructive',
				requiresVacancy: false,
				replayPolicy: 'recorded',
			},
		] as never);
		if (!validation.ok) throw new Error(validation.detail);
		expect(
			checkValidatedManifest({
				manifest: validation.manifest,
				expectedPlans: [root],
				supplementalPlans: [
					{
						...root,
						claimId: 'not-covered',
						claimSpecies: 'sql-bearing',
						statementBundle: { statements: [] },
					},
				],
			}),
		).toMatchObject({ kind: 'outcome-protocol-refused' });
	});

	it('OBL-REC5 recognizes independently read equal ledger addresses', () => {
		expect(
			sameLedgerAddress(address, {
				...address,
				parent: {
					engine: 'postgresql',
					database: 'app',
					schema: 'tenant',
					kind: 'table',
					name: 'parent',
				},
			}),
		).toBe(false);
		const withParent = {
			...address,
			parent: {
				engine: 'postgresql',
				database: 'app',
				schema: 'tenant',
				kind: 'table' as const,
				name: 'parent',
			},
		};
		expect(sameLedgerAddress(withParent, structuredClone(withParent))).toBe(
			true,
		);
	});
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
		const run = lockedRun('reviewed-run', planDigest);

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
				run: lockedRun('trust-root-run', planDigest),
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

	it.each([
		[
			'a different plan digest',
			{ class: 'destructive-plan-accepted:other-plan' },
		],
		[
			'a different address scope',
			{
				class: 'destructive-plan-accepted:grant-bound-plan',
				withinScope: [{ schema: 'other' }],
			},
		],
		[
			'an unexpected trust root where none was declared',
			{
				class: 'destructive-plan-accepted:grant-bound-plan',
				fromTrustRoot: { kind: 'policy', policyId: 'attacker' },
			},
		],
		[
			'a missing trust root where one was declared',
			{ class: 'destructive-plan-accepted:grant-bound-plan' },
		],
	] as const)(
		'OBL-AUTH9 refuses a captured destructive grant replayed against %s',
		(_attack, grant) => {
			const planDigest = 'grant-bound-plan';
			const operation = {
				kind: 'destructive-outcome' as const,
				request: { ...request('grant-bound-claim'), members: [] } as never,
				readBackAndResolve: async () => ({
					rootClaimId: 'grant-bound-claim',
					members: [],
					reservations: [],
				}),
			};
			const requiresRoot =
				_attack === 'a missing trust root where one was declared';
			expect(
				checkApprovalScope({
					run: lockedRun('grant-bound-run', planDigest),
					approval: {
						approvals: [grant],
						...(requiresRoot
							? { declaredTrustRoot: { kind: 'policy', policyId: 'reviewed' } }
							: {}),
					},
					operation,
				}),
			).toMatchObject({
				kind: 'outcome-protocol-refused',
				reason:
					_attack === 'a different plan digest'
						? 'operator acceptance is absent'
						: 'admitted operation refuses destructive approval outside its scope or trust root',
			});
		},
	);

	/* Compatibility-path permit test retired with the synthesized-run bridge. */
	/* it('does not let a table A approval-scope verdict mint a permit for table B', async () => {
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

	}); */
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

	it('keeps a SQLSTATE-confirmed COMMIT refusal deterministic', async () => {
		const sql: string[] = [];
		const executor = {
			query: vi.fn(async (statement: string) => {
				sql.push(statement);
				if (statement === 'COMMIT') {
					const error = new Error('deferred constraint violation');
					Object.assign(error, { code: '23514' });
					throw error;
				}
				return { rows: [] };
			}),
		};
		await expect(
			withPgTransitionTransaction(executor, async () => 'completed'),
		).rejects.toBeInstanceOf(PgCommitDeterministicFailureError);
		expect(sql).toEqual(['BEGIN', 'COMMIT']);
	});

	it('evicts an outcome session after an unclassified transport failure', async () => {
		const release = vi.fn();
		const error = Object.assign(new Error('socket reset'), {
			code: 'ECONNRESET',
		});
		await expect(
			withPgOutcomeSession(
				{
					connect: vi.fn(async () => ({
						query: vi.fn(),
						release,
					})),
				} as never,
				async () => {
					throw error;
				},
			),
		).rejects.toBe(error);
		expect(release).toHaveBeenCalledWith(error);
	});

	/* Direct-runner cases are re-pointed to persisted real-PG coverage. */
	/* it('keeps claim, DDL and resolution inside one transactional boundary (SC-32)', async () => {
		const executor = recorder('CREATE TABLE tenant.accounts (id integer)');
		const input = request('transactional');
		const result = await runAdmitted(executor as never, {
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
		const result = await runAdmitted(pool as never, {
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
		expect(session.query).toHaveBeenCalledWith(
			'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
		);
		expect(session.query).toHaveBeenCalledWith('COMMIT');
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
		const result = await runAdmitted(executor as never, {
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
		const result = await runAdmitted(executor as never, {
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
		const result = await runAdmitted(executor as never, {
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

	it('keeps unarmed checkpoints inert and reports each admitted non-transactional boundary in order', async () => {
		const unarmed = recorder();
		const armed = recorder();
		const input = {
			...request('checkpoint-inert'),
			executingEventId: 'checkpoint-inert-executing',
			resolution: {
				eventId: 'checkpoint-inert-observed',
				eventKind: 'observed' as const,
			},
			vacancy: async () => ({ kind: 'vacant' as const }),
		};
		await expect(runAdmitted(unarmed as never, input)).resolves.toMatchObject({
			kind: 'executed-outcome-claim',
		});
		const checkpoints: string[] = [];
		await expect(
			runAdmitted(armed as never, {
				...input,
				observer: async (point: string) => {
					checkpoints.push(point);
				},
			}),
		).resolves.toMatchObject({ kind: 'executed-outcome-claim' });
		expect(armed.sql).toEqual(unarmed.sql);
		expect(checkpoints).toEqual([
			'post-lock-integrity-before-append',
			'commit-acknowledged',
			'post-lock-integrity-before-append',
			'commit-acknowledged',
			'ddl-completed-before-read-back',
			'post-lock-integrity-before-append',
			'commit-acknowledged',
		]);
	});

	it('refuses a mid-window non-transactional live-admission attack before executing or DDL', async () => {
		const executor = recorder();
		const result = await runAdmitted(executor as never, {
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

	}); */

	it('locks a present observed relation after resolvability and before proof and its terminal append', async () => {
		const executor = recorder();
		const input = request('observed-identity-lock');
		await expect(
			runAdmitted(executor as never, {
				...input,
				resolution: {
					eventId: 'observed-identity-lock-terminal',
					eventKind: 'observed',
				},
				vacancy: async () => ({ kind: 'vacant' as const }),
				recordCatalogueIdentity: true,
				readBack: async () => ({
					value: { table: 'accounts' },
					digest: 'accounts-v1',
				}),
			}),
		).resolves.toMatchObject({ kind: 'executed-outcome-claim' });
		const relationLock = executor.sql.indexOf(
			'LOCK TABLE ONLY "tenant"."accounts" IN SHARE UPDATE EXCLUSIVE MODE',
		);
		const identityReads = executor.sql
			.map((statement, index) =>
				statement.includes('FROM pg_catalog.pg_class relation') ? index : -1,
			)
			.filter((index) => index !== -1);
		const terminalAppend = executor.sql.reduce(
			(index, statement, candidate) =>
				statement.includes('WITH appended AS') ? candidate : index,
			-1,
		);
		expect(relationLock).toBeGreaterThan(-1);
		expect(identityReads).toHaveLength(3);
		expect(identityReads[0]).toBeLessThan(relationLock);
		expect(relationLock).toBeLessThan(identityReads[1]!);
		expect(identityReads[1]).toBeLessThan(identityReads[2]!);
		expect(identityReads[2]).toBeLessThan(terminalAppend);
		expect(executor.sql).not.toContain(
			"SET LOCAL statement_timeout = '5000ms'",
		);
	});

	it('maps an observed relation-lock failure to the protocol refusal before its final identity proof', async () => {
		const source = recorder();
		const executor = {
			...source,
			query: vi.fn(async (statement: string, params?: readonly unknown[]) => {
				if (statement.startsWith('LOCK TABLE'))
					throw new Error('canceling statement due to lock timeout');
				return source.query(statement, params);
			}),
		};
		const input = request('observed-identity-lock-failure');
		await expect(
			runAdmitted(executor as never, {
				...input,
				resolution: {
					eventId: 'observed-identity-lock-failure-terminal',
					eventKind: 'observed',
				},
				vacancy: async () => ({ kind: 'vacant' as const }),
				recordCatalogueIdentity: true,
				readBack: async () => ({
					value: { table: 'accounts' },
					digest: 'accounts-v1',
				}),
			}),
		).resolves.toMatchObject({
			kind: 'outcome-protocol-refused',
			reason: 'relation lock failed while establishing a relation lock',
		});
		expect(
			source.sql.filter((statement) =>
				statement.includes('FROM pg_catalog.pg_class relation'),
			),
		).toHaveLength(1);
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
