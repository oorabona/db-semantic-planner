import { randomUUID } from 'node:crypto';
import {
	createPgTransitionRunPersister,
	executePgAdmittedOperation,
	type PgOutcomeTransactionalRequest,
	readTransitionJournal,
	runPgReinitializePreflight,
} from '@dbsp/adapter-pgsql';
import {
	appendPgLedgerResolution,
	lockPgJournalRun,
	openPgOutcomeClaim,
} from '@dbsp/adapter-pgsql/internal';
import {
	outcomeClaimEventId,
	outcomeClaimId,
	transitionPlanDigest,
	validateNormalizedManagedStepManifest,
} from '@dbsp/core';
import { mintDurablyLoadedRun } from '@dbsp/core/internal';
import type {
	LedgerAddress,
	LedgerReservationRow,
	OutcomeClaimPlan,
	ProvenPlanShape,
} from '@dbsp/types';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureOutcomeClaim } from './outcome-claim-fixture.js';

const pools: pg.Pool[] = [];
const schemas: string[] = [];

/**
 * Fixture-only equivalent of the CLI's locked, permit-holding façade call.
 *
 * The protocol cases deliberately retain their precise claim-window seams
 * (notably SC-32's backend kill), but no longer fabricate the run offered to
 * the façade.  The exact normalized manifest is persisted, reloaded, then
 * passed through the same durable-run lock bridge as an ordinary operation.
 */
async function runAdmitted(
	executor: pg.Pool | pg.PoolClient,
	request: PgOutcomeTransactionalRequest,
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
			coreVersion: 'managed-ledger-outcome-e2e',
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

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function address(schema: string, name: string): LedgerAddress {
	return {
		scope: 'schema',
		engine: 'postgresql',
		database: 'outcome_protocol_e2e',
		schema,
		kind: 'table',
		name,
	};
}

function claim(
	schema: string,
	name: string,
	claimId: string,
): {
	readonly plan: OutcomeClaimPlan;
	readonly reservations: readonly LedgerReservationRow[];
} {
	const value = address(schema, name);
	return fixtureOutcomeClaim({
		claimId,
		address: value,
		claimKind: 'intent',
		statements: [
			`CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(name)} (id integer)`,
		],
		reservations: [
			{
				address: value,
				claimKind: 'intent',
				executionId: `${claimId}-execution`,
				rootClaimId: claimId,
				homeLedger: { scope: 'schema', schema },
			},
		],
	});
}

async function fixture(): Promise<{
	readonly pool: pg.Pool;
	readonly schema: string;
}> {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString)
		throw new Error('DATABASE_URL is required for outcome protocol E2E');
	const pool = new pg.Pool({ connectionString, max: 6 });
	pools.push(pool);
	const schema = `ledger_outcome_${randomUUID().replaceAll('-', '')}`;
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

async function vacancy(pool: pg.Pool, schema: string, name: string) {
	const live = await pool.query<{ occupied: boolean }>(
		'SELECT to_regclass($1) IS NOT NULL AS occupied',
		[`${schema}.${name}`],
	);
	return live.rows[0]?.occupied === true
		? {
				kind: 'occupied' as const,
				reason: `creation vacancy found occupied ${schema}.${name}`,
			}
		: { kind: 'vacant' as const };
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

describe.sequential('managed ledger outcome protocol (SC-32, SC-40…42)', () => {
	it('extends one address through two completed execution-scoped lifecycles', async () => {
		const { pool, schema } = await fixture();
		const value = address(schema, 'twice_mutated');
		const firstExecution = 'e2e-execution-1';
		const secondExecution = 'e2e-execution-2';
		const firstId = outcomeClaimId(firstExecution, 'step:0/root', value);
		const secondId = outcomeClaimId(secondExecution, 'step:0/root', value);
		const firstObserved = outcomeClaimEventId(firstId, 'observed');
		const secondObserved = outcomeClaimEventId(secondId, 'observed');
		expect(secondId).not.toBe(firstId);
		const first = fixtureOutcomeClaim({
			claimId: firstId,
			executionId: firstExecution,
			plannedClaimKey: 'step:0/root',
			claimGroupId: firstId,
			rootClaimId: firstId,
			address: value,
			claimKind: 'intent',
			requiresVacancy: true,
			statements: [
				`CREATE TABLE ${quoteIdent(schema)}."twice_mutated" (id integer)`,
			],
			reservations: [
				{
					address: value,
					claimKind: 'intent',
					executionId: firstExecution,
					rootClaimId: firstId,
					homeLedger: { scope: 'schema', schema },
				},
			],
		});
		const second = fixtureOutcomeClaim({
			claimId: secondId,
			executionId: secondExecution,
			plannedClaimKey: 'step:0/root',
			claimGroupId: secondId,
			rootClaimId: secondId,
			address: value,
			claimKind: 'intent',
			requiresVacancy: false,
			statements: [
				`ALTER TABLE ${quoteIdent(schema)}."twice_mutated" ADD COLUMN note text`,
			],
			reservations: [
				{
					address: value,
					claimKind: 'intent',
					executionId: secondExecution,
					rootClaimId: secondId,
					homeLedger: { scope: 'schema', schema },
				},
			],
		});
		await expect(
			runAdmitted(pool, {
				...first,
				resolution: { eventId: firstObserved, eventKind: 'observed' },
				recordCatalogueIdentity: true,
				vacancy: async () => ({ kind: 'vacant' }),
				readBack: async () => ({
					value: { table: 'twice_mutated', cycle: 1 },
					digest: 'twice-mutated-cycle-1',
				}),
			}),
		).resolves.toMatchObject({ kind: 'executed-outcome-claim' });
		await expect(
			runAdmitted(pool, {
				...second,
				resolution: { eventId: secondObserved, eventKind: 'observed' },
				readBack: async () => ({
					value: { table: 'twice_mutated', cycle: 2 },
					digest: 'twice-mutated-cycle-2',
				}),
			}),
		).resolves.toMatchObject({ kind: 'executed-outcome-claim' });
		const events = await pool.query<{
			event_id: string;
			predecessor: string | null;
		}>(
			`SELECT event_id, predecessor FROM ${quoteIdent(schema)}."dbsp_ledger_event" WHERE address_name = 'twice_mutated' ORDER BY event_id`,
		);
		expect(events.rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ event_id: firstId }),
				expect.objectContaining({
					event_id: secondId,
					predecessor: firstObserved,
				}),
			]),
		);
	});

	it('SC-32: backend termination inside the transactional claim window leaves no event, reservation, or catalogue effect', async () => {
		const { pool, schema } = await fixture();
		const client = await pool.connect();
		const expectedTerminationError = (error: Error & { code?: string }) => {
			if (
				error.code === '57P01' ||
				error.message === 'Connection terminated unexpectedly'
			)
				return;
			throw error;
		};
		client.on('error', expectedTerminationError);
		pool.on('error', expectedTerminationError);
		const input = claim(schema, 'killed_create', 'killed-claim');
		let atCheckpoint!: () => void;
		const checkpoint = new Promise<void>((resolve) => {
			atCheckpoint = resolve;
		});
		let continueVacancy!: () => void;
		const wait = new Promise<void>((resolve) => {
			continueVacancy = resolve;
		});
		try {
			const pid = (
				await client.query<{ pg_backend_pid: number }>(
					'SELECT pg_backend_pid()',
				)
			).rows[0]?.pg_backend_pid;
			if (!pid)
				throw new Error('transactional outcome client has no backend pid');
			const running = runAdmitted(client, {
				...input,
				resolution: { eventId: 'killed-observed', eventKind: 'observed' },
				vacancy: async () => {
					atCheckpoint();
					await wait;
					return { kind: 'vacant' };
				},
			});
			await checkpoint;
			await pool.query('SELECT pg_terminate_backend($1::int)', [pid]);
			continueVacancy();
			await expect(running).resolves.toMatchObject({
				kind: 'outcome-protocol-refused',
			});
			await expect(
				pool.query(`SELECT * FROM ${quoteIdent(schema)}."dbsp_ledger_event"`),
			).resolves.toMatchObject({ rows: [] });
			await expect(
				pool.query(
					`SELECT * FROM ${quoteIdent(schema)}."dbsp_ledger_reservation"`,
				),
			).resolves.toMatchObject({ rows: [] });
			await expect(
				pool.query('SELECT to_regclass($1) AS object', [
					`${schema}.killed_create`,
				]),
			).resolves.toMatchObject({ rows: [{ object: null }] });
		} finally {
			pool.off('error', expectedTerminationError);
			client.release(true);
		}
	});

	it('OBL-LIFE7: foreign occupants from unknown and absent refuse; a matching shape is never adopted', async () => {
		const { pool, schema } = await fixture();
		const client = await pool.connect();
		const input = claim(schema, 'externally_created', 'vacancy-claim');
		try {
			// An untracked foreign relation at an unknown address is drift even when
			// it has the exact tempting shape.  It must leave a refusal, never an
			// adoption/managed terminal.
			await pool.query(
				`CREATE TABLE ${quoteIdent(schema)}."occupied_from_unknown" (id integer)`,
			);
			const unknown = claim(
				schema,
				'occupied_from_unknown',
				'occupied-from-unknown-claim',
			);
			await expect(
				runAdmitted(client, {
					...unknown,
					resolution: {
						eventId: 'occupied-from-unknown-refused',
						eventKind: 'refused',
					},
					vacancy: async () => vacancy(pool, schema, 'occupied_from_unknown'),
				}),
			).resolves.toMatchObject({
				kind: 'outcome-protocol-refused',
				reason: `creation vacancy found occupied ${schema}.occupied_from_unknown`,
			});
			await expect(
				pool.query(
					`SELECT event_kind FROM ${quoteIdent(schema)}."dbsp_ledger_event" WHERE address_name = 'occupied_from_unknown' ORDER BY event_id`,
				),
			).resolves.toMatchObject({
				rows: [{ event_kind: 'intent' }, { event_kind: 'refused' }],
			});

			// Re-encounter the exact same shape after a durable absent terminal. The
			// address is still not self-recorded; physical similarity is not creation
			// idempotency and cannot mint management authority.
			await pool.query(
				`CREATE TABLE ${quoteIdent(schema)}."externally_created" (id integer)`,
			);
			const adoption = fixtureOutcomeClaim({
				claimId: 'prior-adopt',
				address: input.plan.address,
				claimKind: 'adopt-intent',
				statements: ['SELECT 1'],
				requiresVacancy: false,
				reservations: input.reservations.map((reservation) => ({
					...reservation,
					claimKind: 'adopt-intent' as const,
					executionId: 'prior-adopt-execution',
					rootClaimId: 'prior-adopt',
				})),
			});
			const adopted = await runAdmitted(client, {
				...adoption,
				resolution: { eventId: 'prior-adopted', eventKind: 'adopt' },
				readBack: async () => ({
					value: { table: 'externally_created' },
					digest: 'prior',
				}),
				recordCatalogueIdentity: true,
			});
			if (adopted.kind !== 'executed-outcome-claim')
				throw new Error('present fixture adoption did not complete');
			const retirement = fixtureOutcomeClaim({
				claimId: 'prior-retire',
				address: input.plan.address,
				claimKind: 'retire-intent',
				statements: ['DROP TABLE ignored'],
				reservations: input.reservations.map((reservation) => ({
					...reservation,
					claimKind: 'retire-intent' as const,
					executionId: 'prior-retire-execution',
					rootClaimId: 'prior-retire',
				})),
			});
			const admittedRetirement = await openPgOutcomeClaim(client, retirement);
			if (admittedRetirement.kind !== 'admitted-outcome-claim')
				throw new Error('absent fixture retirement did not admit');
			await appendPgLedgerResolution(
				client,
				{ scope: 'schema', schema },
				{
					eventId: 'prior-absent',
					address: input.plan.address,
					eventKind: 'absent',
					predecessor: 'prior-retire',
				},
				'prior-retire',
				retirement.reservations,
			);
			const result = await runAdmitted(client, {
				...input,
				resolution: { eventId: 'vacancy-refused', eventKind: 'refused' },
				vacancy: async () => {
					return vacancy(pool, schema, 'externally_created');
				},
			});
			expect(result).toMatchObject({
				kind: 'outcome-protocol-refused',
				reason: `creation vacancy found occupied ${schema}.externally_created`,
			});
			const events = await pool.query(
				`SELECT event_kind FROM ${quoteIdent(schema)}."dbsp_ledger_event" ORDER BY event_id`,
			);
			expect(events.rows.map((event) => event.event_kind)).toEqual(
				expect.arrayContaining([
					'adopt-intent',
					'adopt',
					'retire-intent',
					'absent',
					'intent',
					'refused',
				]),
			);
			expect(events.rows.map((event) => event.event_kind)).not.toContain(
				'observed',
			);
		} finally {
			client.release();
		}
	});

	it('OBL-LIFE7: a recorded catalogue identity permits the same managed object to be re-encountered', async () => {
		const { pool, schema } = await fixture();
		const execution = randomUUID();
		const first = fixtureOutcomeClaim({
			claimId: `recorded-identity-first:${execution}`,
			executionId: `recorded-identity-first-execution:${execution}`,
			plannedClaimKey: 'recorded-identity/root',
			address: address(schema, 'recorded_identity'),
			claimKind: 'intent',
			requiresVacancy: true,
			statements: [
				`CREATE TABLE ${quoteIdent(schema)}."recorded_identity" (id integer)`,
			],
			reservations: [
				{
					address: address(schema, 'recorded_identity'),
					claimKind: 'intent',
					executionId: `recorded-identity-first-execution:${execution}`,
					rootClaimId: `recorded-identity-first:${execution}`,
					homeLedger: { scope: 'schema', schema },
				},
			],
		});
		await expect(
			runAdmitted(pool, {
				...first,
				resolution: {
					eventId: `recorded-identity-first-observed:${execution}`,
					eventKind: 'observed',
				},
				vacancy: async () => ({ kind: 'vacant' }),
				readBack: async () => ({
					value: { table: 'recorded_identity', cycle: 1 },
					digest: 'recorded-identity-first',
				}),
				recordCatalogueIdentity: true,
			}),
		).resolves.toMatchObject({ kind: 'executed-outcome-claim' });

		const again = fixtureOutcomeClaim({
			...first.plan,
			claimId: `recorded-identity-again:${execution}`,
			executionId: `recorded-identity-again-execution:${execution}`,
			plannedClaimKey: 'recorded-identity/re-encounter',
			claimGroupId: `recorded-identity-again:${execution}`,
			rootClaimId: `recorded-identity-again:${execution}`,
			requiresVacancy: false,
			statements: [
				`ALTER TABLE ${quoteIdent(schema)}."recorded_identity" ADD COLUMN note text`,
			],
			reservations: [
				{
					address: first.plan.address,
					claimKind: 'intent',
					executionId: `recorded-identity-again-execution:${execution}`,
					rootClaimId: `recorded-identity-again:${execution}`,
					homeLedger: { scope: 'schema', schema },
				},
			],
		});
		const reencounter = await runAdmitted(pool, {
			...again,
			resolution: {
				eventId: `recorded-identity-again-observed:${execution}`,
				eventKind: 'observed',
			},
			readBack: async () => ({
				value: { table: 'recorded_identity', cycle: 2 },
				digest: 'recorded-identity-again',
			}),
			recordCatalogueIdentity: true,
		});
		if (reencounter.kind === 'outcome-protocol-refused')
			throw new Error(reencounter.reason);
		expect(reencounter).toMatchObject({ kind: 'executed-outcome-claim' });
		await expect(
			pool.query(
				`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'recorded_identity' AND column_name = 'note'`,
				[schema],
			),
		).resolves.toMatchObject({ rows: [{ column_name: 'note' }] });
	});

	it('SC-41: two sessions race a creation and exactly one open claim wins', async () => {
		const { pool, schema } = await fixture();
		const input = claim(schema, 'one_winner', 'winner-claim');
		const contender = {
			...input,
			plan: { ...input.plan, claimId: 'loser-claim' },
			reservations: input.reservations.map((row) => ({
				...row,
				executionId: 'loser-execution',
				rootClaimId: 'loser-claim',
			})),
		};
		const first = await pool.connect();
		const second = await pool.connect();
		try {
			const results = await Promise.all([
				openPgOutcomeClaim(first, input),
				openPgOutcomeClaim(second, contender),
			]);
			expect(
				results.filter((result) => result.kind === 'admitted-outcome-claim'),
			).toHaveLength(1);
			expect(
				results.filter((result) => result.kind === 'outcome-protocol-refused'),
			).toHaveLength(1);
		} finally {
			first.release();
			second.release();
		}
	});

	it('SC-42: the facade owns the bundle and rejects a repeated closed claim', async () => {
		const { pool, schema } = await fixture();
		const input = claim(schema, 'token_one', 'token-one');
		const request = {
			...input,
			resolution: {
				eventId: 'token-one-observed',
				eventKind: 'observed' as const,
			},
			// The facade executes the complete creation protocol, including its
			// operation-owned vacancy admission. The former sink-only fixture never
			// needed this reader because it did not execute the bundle itself.
			vacancy: async () => vacancy(pool, schema, 'token_one'),
		};
		await expect(runAdmitted(pool, request)).resolves.toMatchObject({
			kind: 'executed-outcome-claim',
		});
		await expect(runAdmitted(pool, request)).resolves.toMatchObject({
			kind: 'outcome-protocol-refused',
		});
	});
});
