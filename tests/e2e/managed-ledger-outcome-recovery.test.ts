import { randomUUID } from 'node:crypto';
import {
	createPgTransitionRunPersister,
	executePgAdmittedOperation,
	type PgOutcomeNonTransactionalRequest,
	type PgOutcomeTransactionalRequest,
	readTransitionJournal,
	runPgReinitializePreflight,
} from '@dbsp/adapter-pgsql';
// E2E deliberately exercises the outcome-protocol internals.
import {
	appendPgLedgerProgress,
	appendPgOutcomeResolution,
	createPgLedgerShapeAllowance,
	lockPgJournalRun,
	openPgOutcomeClaim,
	PgCommitAcknowledgementAmbiguousError,
	recoverPgOutcomeClaim,
} from '@dbsp/adapter-pgsql/internal';
import {
	transitionPlanDigest,
	validateNormalizedManagedStepManifest,
} from '@dbsp/core';
import { mintDurablyLoadedRun } from '@dbsp/core/internal';
import type { LedgerAddress, ProvenPlanShape } from '@dbsp/types';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { armOneShotInsertFailpoint } from './harness/index.js';
import {
	fixtureOutcomeClaim,
	fixtureRefusedResolutionMember,
} from './outcome-claim-fixture.js';

const pools: pg.Pool[] = [];
const schemas: string[] = [];

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function makeClaim(schema: string, name: string, claimId: string) {
	const address: LedgerAddress = {
		scope: 'schema',
		engine: 'postgresql',
		database: 'outcome_recovery_e2e',
		schema,
		kind: 'table',
		name,
	};
	const declared = {
		value: {
			kind: 'table',
			columns: [{ name: 'id', dataType: 'integer', nullable: false }],
		},
		digest: `declared-${name}-id-integer-not-null`,
	} as const;
	return fixtureOutcomeClaim({
		claimId,
		address,
		claimKind: 'intent',
		statements: [
			`CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(name)} (id integer NOT NULL)`,
		],
		declared,
		reservations: [
			{
				address,
				claimKind: 'intent',
				executionId: `${claimId}-execution`,
				rootClaimId: claimId,
				homeLedger: { scope: 'schema', schema },
			},
		],
	});
}

function resolutionEvidence(input: ReturnType<typeof makeClaim>) {
	return {
		runId: 'fixture-run',
		planDigest: 'fixture-plan',
		executionId: input.plan.executionId!,
		claimId: input.plan.claimId,
		plannedClaimKey: input.plan.plannedClaimKey!,
		admittedBundleDigest: 'fixture-bundle',
		persistedBundleDigest: 'fixture-bundle',
		recordedPreState: 'unknown' as const,
		externalDdlExclusion: {
			planDigest: 'fixture-plan',
			address: input.plan.address,
			trustRoot: 'fixture-external-ddl-window',
		},
	};
}

/**
 * Persist the exact normalized outcome step before passing it through the
 * admitted facade.  The acknowledgement seam remains observable, but this
 * E2E never invokes the removed raw non-transactional runner.
 */
async function runPersistedOutcome(
	executor: pg.Pool | pg.PoolClient,
	request: PgOutcomeTransactionalRequest | PgOutcomeNonTransactionalRequest,
) {
	const classification =
		request.plan.claimKind === 'retire-intent' ? 'removal' : 'non-destructive';
	const manifest = validateNormalizedManagedStepManifest([
		{
			stepKey: request.plan.plannedClaimKey ?? request.plan.claimId,
			order: 0,
			segmentId: request.plan.claimId,
			dependencyOrder: [],
			address: request.plan.address as never,
			claimKind: request.plan.claimKind,
			plannedClaimKeys: [request.plan.plannedClaimKey ?? request.plan.claimId],
			statementBundle: request.plan.statementBundle,
			classification,
			requiresVacancy: request.plan.requiresVacancy ?? false,
			replayPolicy:
				classification === 'removal' ? 'fresh-live-only' : 'recorded',
		},
	]);
	if (!manifest.ok) throw new Error(manifest.detail);
	const plan = {
		observations: [],
		claims: [],
		assumptions: [],
		preconditions: [],
		segments: [],
		steps: manifest.manifest.steps,
		postconditions: [],
	} as unknown as ProvenPlanShape;
	const planDigest = transitionPlanDigest(plan);
	const runId = `managed-ledger-outcome:${
		request.plan.executionId ?? request.plan.claimId
	}`;
	await createPgTransitionRunPersister(executor).persist(
		{
			runId,
			planDigest,
			targetContextDigest: `fixture:${request.plan.address.database}`,
			databaseId: request.plan.address.database,
			coreVersion: 'managed-ledger-outcome-recovery-e2e',
			startedAt: '2000-01-01T00:00:00.000Z',
			replayability: 'replayable',
		},
		plan,
	);
	const persisted = await readTransitionJournal(executor, runId, {
		ensure: false,
	});
	return executePgAdmittedOperation(executor, {
		run: lockPgJournalRun(mintDurablyLoadedRun(persisted.run)),
		approval: { approvals: [] },
		manifest: manifest.manifest,
		recomputedPlanDigest: planDigest,
		operation: { kind: 'single-outcome', request },
	});
}

async function fixture() {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString)
		throw new Error('DATABASE_URL is required for outcome recovery E2E');
	const pool = new pg.Pool({ connectionString, max: 8 });
	pools.push(pool);
	const schema = `ledger_recovery_${randomUUID().replaceAll('-', '')}`;
	schemas.push(schema);
	await pool.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
	const preflight = await runPgReinitializePreflight({
		pool,
		schemas: [schema],
		declarations: { version: 1, digest: `fixture:${schema}`, declarations: [] },
		writeAdoptionFile: async () => {},
	});
	if (preflight.scopes.some((scope) => scope.outcome === 'failed'))
		throw new Error('fixture could not initialize a current ledger lineage');
	return { pool, schema };
}

async function openExecuting(
	pool: pg.Pool,
	input: ReturnType<typeof makeClaim>,
): Promise<void> {
	const schema = input.plan.address.schema;
	if (!schema) throw new Error('schema-scoped outcome claim has no schema');
	const opened = await openPgOutcomeClaim(pool, input);
	if (opened.kind !== 'admitted-outcome-claim')
		throw new Error(
			`claim ${input.plan.claimId} did not admit: ${opened.reason}`,
		);
	await appendPgLedgerProgress(
		pool,
		{
			scope: 'schema',
			schema,
		},
		{
			eventId: `${input.plan.claimId}-executing`,
			address: input.plan.address,
			eventKind: 'executing',
			predecessor: input.plan.claimId,
		},
	);
}

function recovery(input: ReturnType<typeof makeClaim>, eventId: string) {
	return {
		address: input.plan.address,
		reservations: input.reservations,
		resolutionEventId: eventId,
		acceptedExternalDdlExclusion: false,
		readBack: async () => ({
			value: { table: input.plan.address.name },
			digest: `read-back-${input.plan.address.name}`,
		}),
	};
}

afterEach(async () => {
	for (const [index, pool] of pools.splice(0).entries()) {
		const schema = schemas[index];
		if (schema)
			await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
		await pool.end();
	}
	schemas.splice(0);
});

describe('managed ledger outcome recovery (SC-33…39)', {
	concurrent: false,
}, () => {
	it.each([
		[
			'transactional completion',
			'transactional',
			1,
			['intent', 'observed'],
		] as const,
		['claim opening', 'claim', 1, ['intent']] as const,
		[
			'non-transactional executing',
			'non-transactional',
			2,
			['intent', 'executing'],
		] as const,
		[
			'non-transactional terminal',
			'non-transactional',
			3,
			['intent', 'executing', 'observed'],
		] as const,
	] as const)(
		'OBL-LOCK3: severing the %s COMMIT acknowledgement never reports success and leaves durable truth inspectable',
		async (_path, mode, severAt, durableKinds) => {
			const { pool, schema } = await fixture();
			const input = makeClaim(
				schema,
				`ambiguous_${mode}_${severAt}`,
				`ambiguous-${mode}-${severAt}-claim`,
			);
			let acknowledgements = 0;
			const observer = (point: string) => {
				if (point !== 'commit-acknowledged') return;
				acknowledgements += 1;
				if (acknowledgements === severAt)
					throw new Error('simulated lost COMMIT acknowledgement');
			};
			if (mode === 'claim') {
				await expect(
					openPgOutcomeClaim(pool, { ...input, observer }),
				).rejects.toBeInstanceOf(PgCommitAcknowledgementAmbiguousError);
			} else {
				const request = {
					...input,
					resolution: {
						eventId: `ambiguous-${mode}-observed`,
						eventKind: 'observed' as const,
					},
					vacancy: async () => ({ kind: 'vacant' as const }),
					observer,
					...(mode === 'non-transactional'
						? { executingEventId: `ambiguous-${mode}-executing` }
						: {}),
				};
				await expect(runPersistedOutcome(pool, request)).resolves.toMatchObject(
					_path === 'non-transactional terminal'
						? {
								// The terminal COMMIT was already sent after executing committed,
								// so its open claim propagates as recovery-required.
								kind: 'outcome-recovery-required',
								claimId: input.plan.claimId,
							}
						: { kind: 'outcome-transport-ambiguous' },
				);
			}
			const events = await pool.query<{ event_kind: string }>(
				`SELECT event_kind FROM ${quoteIdent(schema)}."dbsp_ledger_event" WHERE address_name = $1 ORDER BY recorded_at, event_id`,
				[input.plan.address.name],
			);
			expect(events.rows.map((event) => event.event_kind)).toEqual(
				durableKinds,
			);
		},
	);

	it('OBL-LOCK3: severing a single recovery append acknowledgement reports ambiguity, then inspection sees the durable refusal', async () => {
		const { pool, schema } = await fixture();
		const input = makeClaim(
			schema,
			'ambiguous_recovery',
			'ambiguous-recovery-claim',
		);
		await openExecuting(pool, input);
		await expect(
			recoverPgOutcomeClaim(pool, {
				...recovery(input, 'ambiguous-recovery-refused'),
				observer: (point) => {
					if (point === 'commit-acknowledged')
						throw new Error('simulated lost COMMIT acknowledgement');
				},
			}),
		).resolves.toMatchObject({ kind: 'outcome-transport-ambiguous' });
		const terminal = await pool.query<{ event_kind: string }>(
			`SELECT event_kind FROM ${quoteIdent(schema)}."dbsp_ledger_event" WHERE address_name = $1 ORDER BY recorded_at DESC LIMIT 1`,
			[input.plan.address.name],
		);
		expect(terminal.rows).toEqual([{ event_kind: 'refused' }]);
		await expect(
			recoverPgOutcomeClaim(pool, recovery(input, 'ambiguous-recovery-retry')),
		).resolves.toMatchObject({ kind: 'outcome-recovery-no-open-claim' });
	});

	it('OBL-READ3: an untouched post-executing recovery appends refused only after its operation read-back', async () => {
		const { pool, schema } = await fixture();
		const input = makeClaim(
			schema,
			'untouched_readback',
			'untouched-readback-claim',
		);
		await openExecuting(pool, input);
		let readBacks = 0;
		await expect(
			recoverPgOutcomeClaim(pool, {
				...recovery(input, 'untouched-readback-refused'),
				operationReadBack: async () => {
					readBacks += 1;
					return {
						observed: { value: { untouched: true }, digest: 'untouched' },
						effect: 'no-effect',
					};
				},
			}),
		).resolves.toMatchObject({
			kind: 'outcome-recovery-appended',
			classification: { resolution: { eventKind: 'refused' } },
		});
		expect(readBacks).toBe(1);
	});

	it('OBL-READ3: a touched post-executing object is indeterminate, never refused', async () => {
		const { pool, schema } = await fixture();
		const input = makeClaim(
			schema,
			'touched_readback',
			'touched-readback-claim',
		);
		await openExecuting(pool, input);
		await pool.query(
			`CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(input.plan.address.name)} (id integer NOT NULL)`,
		);
		await expect(
			recoverPgOutcomeClaim(
				pool,
				recovery(input, 'touched-readback-indeterminate'),
			),
		).resolves.toMatchObject({
			kind: 'outcome-recovery-appended',
			classification: { resolution: { eventKind: 'indeterminate' } },
		});
		const terminals = await pool.query<{ event_kind: string }>(
			`SELECT event_kind FROM ${quoteIdent(schema)}."dbsp_ledger_event" WHERE address_name = $1 AND event_kind = 'refused'`,
			[input.plan.address.name],
		);
		expect(terminals.rows).toEqual([]);
	});

	it('refuses a drifted ledger before a recovery terminal append', async () => {
		const { pool, schema } = await fixture();
		const input = makeClaim(
			schema,
			'drifted_recovery',
			'drifted-recovery-claim',
		);
		await openExecuting(pool, input);
		await pool.query(
			`CREATE FUNCTION ${quoteIdent(schema)}.extra_ledger_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$`,
		);
		await pool.query(
			`CREATE TRIGGER extra_ledger_trigger BEFORE INSERT ON ${quoteIdent(schema)}.dbsp_ledger_event FOR EACH ROW EXECUTE FUNCTION ${quoteIdent(schema)}.extra_ledger_trigger()`,
		);

		await expect(
			recoverPgOutcomeClaim(pool, recovery(input, 'drifted-recovery-refused')),
		).resolves.toMatchObject({ kind: 'outcome-protocol-refused' });
		const terminals = await pool.query<{ event_kind: string }>(
			`SELECT event_kind FROM ${quoteIdent(schema)}.dbsp_ledger_event WHERE address_name = $1 AND event_kind = 'refused'`,
			[input.plan.address.name],
		);
		expect(terminals.rows).toEqual([]);
	});

	it('SC-33: a kill after executing commits requires recovery with no catalogue effect', async () => {
		const { pool, schema } = await fixture();
		const client = await pool.connect();
		client.on('error', () => undefined);
		const input = makeClaim(schema, 'acknowledged_gate', 'acknowledged-claim');
		let atGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			atGate = resolve;
		});
		let continueSend!: () => void;
		const send = new Promise<void>((resolve) => {
			continueSend = resolve;
		});
		try {
			const pid = (
				await client.query<{ pg_backend_pid: number }>(
					'SELECT pg_backend_pid()',
				)
			).rows[0]?.pg_backend_pid;
			if (!pid) throw new Error('acknowledgement client has no backend pid');
			const running = runPersistedOutcome(client, {
				...input,
				executingEventId: 'acknowledged-executing',
				resolution: { eventId: 'acknowledged-observed', eventKind: 'observed' },
				vacancy: async () => ({ kind: 'vacant' }),
				onExecutingCommitted: async () => {
					atGate();
					await send;
				},
			});
			await gate;
			await pool.query('SELECT pg_terminate_backend($1::int)', [pid]);
			continueSend();
			await expect(running).resolves.toMatchObject({
				kind: 'outcome-recovery-required',
				claimId: input.plan.claimId,
			});
			await expect(
				recoverPgOutcomeClaim(pool, recovery(input, 'acknowledged-refused')),
			).resolves.toMatchObject({
				kind: 'outcome-recovery-appended',
				classification: { resolution: { eventKind: 'refused' } },
			});
		} finally {
			client.release(true);
		}
	});

	it('SC-34 and SC-35: post-DDL recovery uses accepted exclusion per address', async () => {
		const { pool, schema } = await fixture();
		const accepted = makeClaim(schema, 'accepted_create', 'accepted-claim');
		const unaccepted = makeClaim(
			schema,
			'unaccepted_create',
			'unaccepted-claim',
		);
		for (const input of [accepted, unaccepted]) {
			await openExecuting(pool, input);
			await pool.query(
				`CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(input.plan.address.name)} (id integer)`,
			);
		}
		await expect(
			recoverPgOutcomeClaim(pool, {
				...recovery(accepted, 'accepted-observed'),
				acceptedExternalDdlExclusion: true,
			}),
		).resolves.toMatchObject({
			kind: 'outcome-recovery-appended',
			classification: { resolution: { eventKind: 'observed' } },
		});
		await expect(
			recoverPgOutcomeClaim(pool, recovery(unaccepted, 'unaccepted-unknown')),
		).resolves.toMatchObject({
			kind: 'outcome-recovery-appended',
			classification: { resolution: { eventKind: 'indeterminate' } },
		});
	});

	it('SC-37: a one-shot resolution insert fault leaves one retryable terminal member', async () => {
		const { pool, schema } = await fixture();
		const input = makeClaim(schema, 'append_fault', 'append-fault-claim');
		await openExecuting(pool, input);
		const failpoint = await armOneShotInsertFailpoint(pool, {
			schema,
			table: 'dbsp_ledger_event',
			column: 'event_id',
			value: 'append-fault-refused',
		});
		try {
			const firstRecoveryAllowance = await createPgLedgerShapeAllowance(
				pool,
				{ scope: 'schema', schema },
				failpoint.triggerName,
			);
			await expect(
				recoverPgOutcomeClaim(pool, {
					...recovery(input, 'append-fault-refused'),
					ledgerShapeAllowance: firstRecoveryAllowance,
				}),
			).resolves.toMatchObject({ kind: 'outcome-protocol-refused' });
			await failpoint.assertFired();
			const retryRecoveryAllowance = await createPgLedgerShapeAllowance(
				pool,
				{ scope: 'schema', schema },
				failpoint.triggerName,
			);
			await expect(
				recoverPgOutcomeClaim(pool, {
					...recovery(input, 'append-fault-refused'),
					ledgerShapeAllowance: retryRecoveryAllowance,
				}),
			).resolves.toMatchObject({ kind: 'outcome-recovery-appended' });
			const events = await pool.query<{ count: string }>(
				`SELECT count(*)::text AS count FROM ${quoteIdent(schema)}."dbsp_ledger_event" WHERE predecessor = $1`,
				['append-fault-claim-executing'],
			);
			expect(events.rows[0]?.count).toBe('1');
		} finally {
			await failpoint.disarm();
		}
	});

	it('CAP-1: a failpoint-named trigger without an allowance is refused', async () => {
		const { pool, schema } = await fixture();
		const input = makeClaim(schema, 'hostile_name', 'hostile-name-claim');
		await openExecuting(pool, input);
		const failpoint = await armOneShotInsertFailpoint(pool, {
			schema,
			table: 'dbsp_ledger_event',
			column: 'event_id',
			value: 'hostile-name-refused',
		});
		try {
			await expect(
				recoverPgOutcomeClaim(pool, recovery(input, 'hostile-name-refused')),
			).resolves.toMatchObject({ kind: 'outcome-protocol-refused' });
		} finally {
			await failpoint.disarm();
		}
	});

	it('CAP-2: an allowance refuses its trigger after its WHEN clause changes', async () => {
		const { pool, schema } = await fixture();
		const input = makeClaim(schema, 'hostile_when', 'hostile-when-claim');
		await openExecuting(pool, input);
		const failpoint = await armOneShotInsertFailpoint(pool, {
			schema,
			table: 'dbsp_ledger_event',
			column: 'event_id',
			value: 'hostile-when-refused',
		});
		const ledgerShapeAllowance = await createPgLedgerShapeAllowance(
			pool,
			{ scope: 'schema', schema },
			failpoint.triggerName,
		);
		try {
			await pool.query(
				`DROP TRIGGER ${quoteIdent(failpoint.triggerName)} ON ${quoteIdent(schema)}."dbsp_ledger_event"; CREATE TRIGGER ${quoteIdent(failpoint.triggerName)} BEFORE INSERT ON ${quoteIdent(schema)}."dbsp_ledger_event" FOR EACH ROW WHEN (NEW."event_id" IS NOT DISTINCT FROM 'hostile-when-refused' AND NEW."predecessor" IS NOT NULL) EXECUTE FUNCTION ${quoteIdent(schema)}.${quoteIdent(failpoint.functionName)}()`,
			);
			await expect(
				recoverPgOutcomeClaim(pool, {
					...recovery(input, 'hostile-when-refused'),
					ledgerShapeAllowance,
				}),
			).resolves.toMatchObject({ kind: 'outcome-protocol-refused' });
		} finally {
			await failpoint.disarm();
		}
	});

	it('SC-36: PostgreSQL accepts an equal resolution retry and fails closed on a differing child', async () => {
		const { pool, schema } = await fixture();
		const input = makeClaim(schema, 'equal_retry', 'equal-retry-claim');
		await openExecuting(pool, input);
		const target = { scope: 'schema' as const, schema };
		const member = fixtureRefusedResolutionMember({
			eventId: 'equal-retry-refused',
			address: input.plan.address,
			predecessor: 'equal-retry-claim-executing',
			code: 'ERR-11',
		});
		await expect(
			appendPgOutcomeResolution(
				pool,
				target,
				member,
				'equal-retry-claim',
				input.reservations,
			),
		).resolves.toEqual({ kind: 'appended-outcome-resolution' });
		await expect(
			appendPgOutcomeResolution(
				pool,
				target,
				member,
				'equal-retry-claim',
				input.reservations,
			),
		).resolves.toEqual({ kind: 'already-appended-outcome-resolution' });
		await expect(
			appendPgOutcomeResolution(
				pool,
				target,
				{ ...member, eventId: 'different-resolution', eventKind: 'absent' },
				'equal-retry-claim',
				input.reservations,
			),
		).resolves.toMatchObject({ kind: 'malformed-outcome-resolution' });
	});

	it('SC-38: a catalogue-session termination reports pending and appends nothing', async () => {
		const { pool, schema } = await fixture();
		const input = makeClaim(schema, 'catalogue_lost', 'catalogue-lost-claim');
		await openExecuting(pool, input);
		const client = await pool.connect();
		client.on('error', () => undefined);
		try {
			const pid = (
				await client.query<{ pg_backend_pid: number }>(
					'SELECT pg_backend_pid()',
				)
			).rows[0]?.pg_backend_pid;
			if (!pid) throw new Error('catalogue recovery client has no backend pid');
			let terminateOnCatalogueRead = true;
			const terminatingExecutor = {
				query: async (sql: string, params?: readonly unknown[]) => {
					if (
						terminateOnCatalogueRead &&
						sql.includes('FROM pg_catalog.pg_class relation')
					) {
						terminateOnCatalogueRead = false;
						await pool.query('SELECT pg_terminate_backend($1::int)', [pid]);
					}
					return params === undefined
						? client.query<Record<string, unknown>>(sql)
						: client.query<Record<string, unknown>>(sql, [...params]);
				},
			};
			await expect(
				recoverPgOutcomeClaim(
					terminatingExecutor,
					recovery(input, 'catalogue-lost-resolution'),
				),
			).resolves.toMatchObject({
				kind: 'outcome-recovery-pending',
			});
			const events = await pool.query<{ event_kind: string }>(
				`SELECT event_kind FROM ${quoteIdent(schema)}."dbsp_ledger_event" ORDER BY event_id`,
			);
			expect(events.rows.map((event) => event.event_kind)).toEqual([
				'intent',
				'executing',
			]);
		} finally {
			client.release(true);
		}
	});

	it('SC-39: indeterminate keeps its reservation until resolved by a live read-back', async () => {
		const { pool, schema } = await fixture();
		const input = makeClaim(schema, 'blocked_create', 'blocked-claim');
		await openExecuting(pool, input);
		await pool.query(
			`CREATE TABLE ${quoteIdent(schema)}."blocked_create" (id integer NOT NULL)`,
		);
		await expect(
			recoverPgOutcomeClaim(pool, recovery(input, 'blocked-indeterminate')),
		).resolves.toMatchObject({
			kind: 'outcome-recovery-appended',
			classification: { resolution: { eventKind: 'indeterminate' } },
		});
		await expect(
			pool.query(
				`SELECT root_claim_id FROM ${quoteIdent(schema)}."dbsp_ledger_reservation"`,
			),
		).resolves.toMatchObject({ rows: [{ root_claim_id: 'blocked-claim' }] });
		await expect(
			openPgOutcomeClaim(
				pool,
				makeClaim(schema, 'blocked_create', 'second-claim'),
			),
		).resolves.toMatchObject({
			kind: 'outcome-protocol-refused',
		});
		await expect(
			recoverPgOutcomeClaim(pool, {
				...recovery(input, 'blocked-resolved'),
				resolveIndeterminate: true,
				indeterminateEvidence: resolutionEvidence(input),
			}),
		).resolves.toMatchObject({ kind: 'outcome-recovery-blocked' });
		let operationReadBackCalls = 0;
		await expect(
			recoverPgOutcomeClaim(pool, {
				...recovery(input, 'blocked-resolved'),
				resolveIndeterminate: true,
				indeterminateEvidence: resolutionEvidence(input),
				operationReadBack: async (executor, address) => {
					operationReadBackCalls += 1;
					const live = await executor.query(
						`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
						[address.schema, address.name],
					);
					const columns = live.rows as readonly {
						readonly column_name: string;
						readonly data_type: string;
						readonly is_nullable: string;
					}[];
					const expected = input.plan.declared!;
					const matchesExpectedDeclaration =
						address.schema === input.plan.address.schema &&
						address.name === input.plan.address.name &&
						columns.length === 1 &&
						columns[0]?.column_name === 'id' &&
						columns[0]?.data_type === 'integer' &&
						columns[0]?.is_nullable === 'NO';
					return {
						observed: expected,
						effect: matchesExpectedDeclaration
							? ('applied' as const)
							: ('no-effect' as const),
					};
				},
			}),
		).resolves.toMatchObject({
			kind: 'outcome-recovery-appended',
			classification: { resolution: { eventKind: 'resolved' } },
		});
		expect(operationReadBackCalls).toBe(1);
		await expect(
			pool.query(
				`SELECT * FROM ${quoteIdent(schema)}."dbsp_ledger_reservation"`,
			),
		).resolves.toMatchObject({ rows: [] });
	});
});
