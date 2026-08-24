import { createPgsqlGeneratedManagedStep } from '@dbsp/adapter-pgsql';
import { lockPgJournalRun } from '@dbsp/adapter-pgsql/internal';
import { transitionPlanDigest } from '@dbsp/core';
import { mintDurablyLoadedRun } from '@dbsp/core/internal';
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { executeGeneratorPlan } from '../../packages/cli/src/commands/generator-execution.js';
import type { GeneratorDurablePlan } from '../../packages/cli/src/commands/generator-plan.js';
import { createSchema, dropSchema, getTestPool } from './testkit/index.js';
import {
	quoteIdent,
	resetDbspMeta,
	runPreflight,
} from './transition-reinitialize-preflight-testkit.js';

const schemas: string[] = [];

function schemaName(): string {
	return `generated_deferred_kinds_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

async function databaseId(): Promise<string> {
	const pool = await getTestPool();
	const result = await pool.query<{ database_id: string }>(
		'SELECT current_database() AS database_id',
	);
	return String(result.rows[0]?.database_id);
}

function deferredKindsPlan(input: {
	readonly database: string;
	readonly schema: string;
}): GeneratorDurablePlan {
	return {
		observations: [],
		claims: [],
		assumptions: [],
		preconditions: [],
		segments: [],
		steps: [
			createPgsqlGeneratedManagedStep({
				change: {
					kind: 'create_enum',
					table: '',
					destructive: false,
					details: 'create real PostgreSQL generated enum fixture',
					meta: {
						enum: { name: 'order_state', values: ['new', 'paid'] },
					},
				},
				database: input.database,
				schema: input.schema,
				stepKey: 'generator:create-enum',
				order: 0,
				statements: [
					`CREATE TYPE ${quoteIdent(input.schema)}.${quoteIdent('order_state')} AS ENUM ('new', 'paid')`,
				],
			}),
			createPgsqlGeneratedManagedStep({
				change: {
					kind: 'create_sequence',
					table: '',
					destructive: false,
					details: 'create real PostgreSQL generated sequence fixture',
					meta: { sequence: { name: 'order_number', startWith: 1 } },
				},
				database: input.database,
				schema: input.schema,
				stepKey: 'generator:create-sequence',
				order: 1,
				statements: [
					`CREATE SEQUENCE ${quoteIdent(input.schema)}.${quoteIdent('order_number')} START WITH 1`,
				],
			}),
		],
		postconditions: [],
		generator: {
			kind: 'schema-differ-generator',
			planningSchema: input.schema,
			changes: [],
			statements: [],
		},
	} as unknown as GeneratorDurablePlan;
}

type PoolConnectCallback = (
	error: Error | undefined,
	client: PoolClient | undefined,
	done: PoolClient['release'],
) => void;

function recordingPoolFor(pool: Pool) {
	const statements: string[] = [];
	const recording = Object.create(pool) as typeof pool;
	async function checkout(): Promise<PoolClient> {
		const client = await pool.connect();
		const query = client.query.bind(client);
		client.query = (async (...args: Parameters<typeof client.query>) => {
			statements.push(String(args[0]));
			return query(...args);
		}) as typeof client.query;
		return client;
	}
	function connect(): Promise<PoolClient>;
	function connect(callback: PoolConnectCallback): void;
	function connect(
		callback?: PoolConnectCallback,
	): Promise<PoolClient> | undefined {
		if (callback === undefined) return checkout();
		void checkout().then(
			(client) => callback(undefined, client, client.release.bind(client)),
			(error: unknown) =>
				callback(
					error instanceof Error
						? error
						: new Error('recording pool checkout failed'),
					undefined,
					() => undefined,
				),
		);
		return undefined;
	}
	recording.connect = connect;
	return { pool: recording, statements };
}

async function recordingPool() {
	return recordingPoolFor(await getTestPool());
}

afterEach(async () => {
	const pool = await getTestPool();
	for (const schema of schemas.splice(0).reverse()) await dropSchema(schema);
	await resetDbspMeta();
});

describe.sequential('generated deferred kinds on real PostgreSQL', () => {
	it('persists and executes generated sequence and enum steps with identity observations and no LOCK TABLE', async () => {
		await resetDbspMeta();
		const schema = schemaName();
		schemas.push(schema);
		await createSchema(schema);
		await runPreflight([schema]);
		const database = await databaseId();
		const plan = deferredKindsPlan({ database, schema });
		const planDigest = transitionPlanDigest(plan);
		const runId = `generated-deferred-kinds:${crypto.randomUUID()}`;
		const { pool, statements } = await recordingPool();
		await expect(
			executeGeneratorPlan({
				pool,
				plan,
				planDigest,
				schema,
				run: lockPgJournalRun(
					mintDurablyLoadedRun({
						runId,
						planDigest,
						targetContextDigest: `generated-deferred-kinds:${schema}`,
						databaseId: database,
						coreVersion: 'generated-deferred-kinds-e2e',
						startedAt: new Date().toISOString(),
						replayability: 'replayable',
					}),
				),
				recordAttempt: async () => undefined,
				runId,
			}),
		).resolves.toEqual({ outcome: 'completed' });

		const verifiedPool = await getTestPool();
		const observed = await verifiedPool.query<{
			readonly kind: string;
			readonly observed: {
				readonly kind?: string;
				readonly observedKind?: string;
			};
		}>(
			`SELECT address_kind AS kind, observed FROM ${quoteIdent(schema)}.${quoteIdent('dbsp_ledger_event')} WHERE event_kind = 'observed' AND address_kind IN ('sequence', 'enum') ORDER BY address_kind`,
		);
		expect(observed.rows).toEqual([
			{
				kind: 'enum',
				observed: expect.objectContaining({
					kind: 'identity-observed',
					observedKind: 'enum',
				}),
			},
			{
				kind: 'sequence',
				observed: expect.objectContaining({
					kind: 'identity-observed',
					observedKind: 'sequence',
				}),
			},
		]);
		expect(
			statements.some((statement) => /^LOCK TABLE ONLY\b/i.test(statement)),
		).toBe(false);
	});
});
