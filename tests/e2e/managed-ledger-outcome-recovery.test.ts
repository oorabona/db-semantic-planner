import { randomUUID } from 'node:crypto';
import {
	recoverPgOutcomeClaim,
	runPgNonTransactionalOutcome,
	runPgReinitializePreflight,
} from '@dbsp/adapter-pgsql';
import {
	appendPgLedgerProgress,
	appendPgOutcomeResolution,
	openPgOutcomeClaim,
} from '@dbsp/adapter-pgsql/internal';
import type { LedgerAddress } from '@dbsp/types';
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
	return fixtureOutcomeClaim({
		claimId,
		address,
		claimKind: 'intent',
		statements: [
			`CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(name)} (id integer)`,
		],
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

describe.sequential('managed ledger outcome recovery (SC-33…39)', () => {
	it('SC-33: a kill at executing acknowledgement recovers as refused with no catalogue effect', async () => {
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
			const running = runPgNonTransactionalOutcome(client, {
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
				kind: 'outcome-protocol-refused',
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
			await expect(
				recoverPgOutcomeClaim(pool, recovery(input, 'append-fault-refused')),
			).resolves.toMatchObject({ kind: 'outcome-protocol-refused' });
			await failpoint.assertFired();
			await expect(
				recoverPgOutcomeClaim(pool, recovery(input, 'append-fault-refused')),
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
			`CREATE TABLE ${quoteIdent(schema)}."blocked_create" (id integer)`,
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
			}),
		).resolves.toMatchObject({
			kind: 'outcome-recovery-appended',
			classification: { resolution: { eventKind: 'resolved' } },
		});
		await expect(
			pool.query(
				`SELECT * FROM ${quoteIdent(schema)}."dbsp_ledger_reservation"`,
			),
		).resolves.toMatchObject({ rows: [] });
	});
});
