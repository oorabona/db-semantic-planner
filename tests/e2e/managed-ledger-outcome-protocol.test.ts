import { randomUUID } from 'node:crypto';
import {
	appendPgLedgerResolution,
	ensurePgLedger,
	executePgManagedBundle,
	openPgOutcomeClaim,
	runPgTransactionalOutcome,
} from '@dbsp/adapter-pgsql';
import type {
	LedgerAddress,
	LedgerReservationRow,
	OutcomeClaimPlan,
} from '@dbsp/types';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

const pools: pg.Pool[] = [];
const schemas: string[] = [];

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
	return {
		plan: {
			claimId,
			address: value,
			claimKind: 'intent',
			statementBundle: {
				statements: [
					{
						ordinal: 0,
						sql: `CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(name)} (id integer)`,
					},
				],
			},
		},
		reservations: [
			{
				address: value,
				claimKind: 'intent',
				executionId: `${claimId}-execution`,
				rootClaimId: claimId,
				homeLedger: { scope: 'schema', schema },
			},
		],
	};
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
	await ensurePgLedger(pool, { scope: 'schema', schema });
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
			const running = runPgTransactionalOutcome(client, {
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

	it('SC-40: a post-claim occupied creation refuses and leaves no adoption', async () => {
		const { pool, schema } = await fixture();
		const client = await pool.connect();
		const input = claim(schema, 'externally_created', 'vacancy-claim');
		try {
			const adoption = {
				plan: {
					...input.plan,
					claimId: 'prior-adopt',
					claimKind: 'adopt-intent' as const,
					statementBundle: { statements: [] },
				},
				reservations: input.reservations.map((reservation) => ({
					...reservation,
					claimKind: 'adopt-intent' as const,
					executionId: 'prior-adopt-execution',
					rootClaimId: 'prior-adopt',
				})),
			};
			const admittedAdoption = await openPgOutcomeClaim(client, adoption);
			if (admittedAdoption.kind !== 'admitted-outcome-claim')
				throw new Error('absent fixture adoption did not admit');
			await appendPgLedgerResolution(
				client,
				{ scope: 'schema', schema },
				{
					eventId: 'prior-adopted',
					address: input.plan.address,
					eventKind: 'adopt',
					predecessor: 'prior-adopt',
					observed: { value: { table: 'externally_created' }, digest: 'prior' },
				},
				'prior-adopt',
				adoption.reservations,
			);
			const retirement = {
				plan: {
					...input.plan,
					claimId: 'prior-retire',
					claimKind: 'retire-intent' as const,
					statementBundle: {
						statements: [{ ordinal: 0, sql: 'DROP TABLE ignored' }],
					},
				},
				reservations: input.reservations.map((reservation) => ({
					...reservation,
					claimKind: 'retire-intent' as const,
					executionId: 'prior-retire-execution',
					rootClaimId: 'prior-retire',
				})),
			};
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
			const result = await runPgTransactionalOutcome(client, {
				...input,
				resolution: { eventId: 'vacancy-refused', eventKind: 'refused' },
				vacancy: async () => {
					await pool.query(
						`CREATE TABLE ${quoteIdent(schema)}."externally_created" (id integer)`,
					);
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

	it('SC-42: another claim, duplicate use, a resolved claim, and an outside bundle all reject at the token-gated sink', async () => {
		const { pool, schema } = await fixture();
		const client = await pool.connect();
		try {
			const first = await openPgOutcomeClaim(
				client,
				claim(schema, 'token_one', 'token-one'),
			);
			const second = await openPgOutcomeClaim(
				client,
				claim(schema, 'token_two', 'token-two'),
			);
			if (
				first.kind !== 'admitted-outcome-claim' ||
				second.kind !== 'admitted-outcome-claim'
			)
				throw new Error('token fixtures did not admit');
			await expect(
				executePgManagedBundle(client, {
					token: first.token,
					claim: second,
					statements: second.plan.statementBundle.statements,
				}),
			).resolves.toMatchObject({ kind: 'outcome-protocol-refused' });
			await expect(
				executePgManagedBundle(client, {
					token: first.token,
					claim: first,
					statements: [{ ordinal: 0, sql: 'DROP TABLE nowhere' }],
				}),
			).resolves.toMatchObject({ kind: 'outcome-protocol-refused' });
			await expect(
				executePgManagedBundle(client, {
					token: first.token,
					claim: first,
					statements: first.plan.statementBundle.statements,
				}),
			).resolves.toBeUndefined();
			await expect(
				executePgManagedBundle(client, {
					token: first.token,
					claim: first,
					statements: first.plan.statementBundle.statements,
				}),
			).resolves.toMatchObject({ kind: 'outcome-protocol-refused' });
			await appendPgLedgerResolution(
				client,
				{ scope: 'schema', schema },
				{
					eventId: 'token-two-refused',
					address: second.plan.address,
					eventKind: 'refused',
					predecessor: second.plan.claimId,
				},
				second.plan.claimId,
				second.plan.address
					? claim(schema, 'token_two', 'token-two').reservations
					: [],
			);
			await expect(
				executePgManagedBundle(client, {
					token: second.token,
					claim: second,
					statements: second.plan.statementBundle.statements,
				}),
			).resolves.toMatchObject({ kind: 'outcome-protocol-refused' });
		} finally {
			client.release();
		}
	});
});
