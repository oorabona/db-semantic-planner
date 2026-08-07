import { randomUUID } from 'node:crypto';
import {
	acquirePgLedgerLocks,
	appendPgLedgerClaim,
	appendPgLedgerProgress,
	ensurePgLedger,
} from '@dbsp/adapter-pgsql';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

const pools: pg.Pool[] = [];
const schemas = new Map<pg.Pool, string>();

function testAddress(schema: string, name: string) {
	return {
		scope: 'schema' as const,
		engine: 'postgresql',
		database: 'ledger_integration',
		schema,
		kind: 'table',
		name,
	};
}

async function fixture(): Promise<{
	readonly pool: pg.Pool;
	readonly schema: string;
}> {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString)
		throw new Error('DATABASE_URL is required for ledger integration');
	const pool = new pg.Pool({ connectionString, max: 3 });
	pools.push(pool);
	const schema = `ledger_integration_${randomUUID().replaceAll('-', '')}`;
	await pool.query(`CREATE SCHEMA "${schema}"`);
	await ensurePgLedger(pool, { scope: 'schema', schema });
	schemas.set(pool, schema);
	return { pool, schema };
}

afterEach(async () => {
	await Promise.all(
		pools.splice(0).map(async (pool) => {
			const schema = schemas.get(pool);
			if (schema) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
			schemas.delete(pool);
			await pool.end();
		}),
	);
});

describe('managed ledger database constraints (SC-07, SC-08, SC-09, SC-10, SC-12)', () => {
	it('SC-07: rejects update and delete at the database', async () => {
		const { pool, schema } = await fixture();
		const address = testAddress(schema, 'immutable');
		await appendPgLedgerClaim(
			pool,
			{ scope: 'schema', schema },
			{
				eventId: 'immutable-root',
				address,
				eventKind: 'intent',
			},
			[
				{
					address,
					claimKind: 'intent',
					executionId: 'immutable-execution',
					rootClaimId: 'immutable-root',
					homeLedger: { scope: 'schema', schema },
				},
			],
		);
		await expect(
			pool.query(
				`UPDATE "${schema}"."dbsp_ledger_event" SET event_kind = 'observed'`,
			),
		).rejects.toThrow('dbsp ledger events are append-only');
		await expect(
			pool.query(`DELETE FROM "${schema}"."dbsp_ledger_event"`),
		).rejects.toThrow('dbsp ledger events are append-only');
	});

	it('SC-08: resolves a terminal member by predecessor rather than a table-wide position', async () => {
		const { pool, schema } = await fixture();
		const first = testAddress(schema, 'first');
		const second = testAddress(schema, 'second');
		for (const [address, id] of [
			[first, 'later-allocated'],
			[second, 'earlier-allocated'],
		] as const) {
			await appendPgLedgerClaim(
				pool,
				{ scope: 'schema', schema },
				{
					eventId: `${id}-root`,
					address,
					eventKind: 'intent',
				},
				[
					{
						address,
						claimKind: 'intent',
						executionId: `${id}-execution`,
						rootClaimId: `${id}-root`,
						homeLedger: { scope: 'schema', schema },
					},
				],
			);
		}
		await appendPgLedgerProgress(
			pool,
			{ scope: 'schema', schema },
			{
				eventId: 'first-terminal',
				address: first,
				eventKind: 'executing',
				predecessor: 'later-allocated-root',
			},
		);
		const terminals = await pool.query(
			`SELECT e.address_name, e.event_id FROM "${schema}"."dbsp_ledger_event" e WHERE NOT EXISTS (SELECT 1 FROM "${schema}"."dbsp_ledger_event" child WHERE child.address_engine = e.address_engine AND child.address_database = e.address_database AND child.address_schema IS NOT DISTINCT FROM e.address_schema AND child.address_parent = e.address_parent AND child.address_kind = e.address_kind AND child.address_name = e.address_name AND child.predecessor = e.event_id) ORDER BY e.address_name`,
		);
		expect(terminals.rows).toEqual([
			{ address_name: 'first', event_id: 'first-terminal' },
			{ address_name: 'second', event_id: 'earlier-allocated-root' },
		]);
	});

	it('SC-09 and SC-10: constraints reject forks, second roots, foreign predecessors, and duplicate reservations', async () => {
		const { pool, schema } = await fixture();
		const address = testAddress(schema, 'constrained');
		await appendPgLedgerClaim(
			pool,
			{ scope: 'schema', schema },
			{
				eventId: 'constraint-root',
				address,
				eventKind: 'intent',
			},
			[
				{
					address,
					claimKind: 'intent',
					executionId: 'constraint-execution',
					rootClaimId: 'constraint-root',
					homeLedger: { scope: 'schema', schema },
				},
			],
		);
		await appendPgLedgerProgress(
			pool,
			{ scope: 'schema', schema },
			{
				eventId: 'constraint-child',
				address,
				eventKind: 'executing',
				predecessor: 'constraint-root',
			},
		);
		await expect(
			appendPgLedgerProgress(
				pool,
				{ scope: 'schema', schema },
				{
					eventId: 'fork-child',
					address,
					eventKind: 'executing',
					predecessor: 'constraint-root',
				},
			),
		).rejects.toThrow();
		await expect(
			appendPgLedgerClaim(
				pool,
				{ scope: 'schema', schema },
				{
					eventId: 'second-root',
					address,
					eventKind: 'intent',
				},
				[
					{
						address,
						claimKind: 'intent',
						executionId: 'second-execution',
						rootClaimId: 'second-root',
						homeLedger: { scope: 'schema', schema },
					},
				],
			),
		).rejects.toThrow();
		const other = testAddress(schema, 'other');
		await expect(
			appendPgLedgerProgress(
				pool,
				{ scope: 'schema', schema },
				{
					eventId: 'foreign-predecessor',
					address: other,
					eventKind: 'executing',
					predecessor: 'constraint-root',
				},
			),
		).rejects.toThrow();
		await expect(
			pool.query(
				`INSERT INTO "${schema}"."dbsp_ledger_reservation" (address_engine, address_database, address_schema, address_parent, address_kind, address_name, claim_kind, execution_id, root_claim_id, home_ledger_scope, home_ledger_schema) VALUES ($1, $2, $3, 'null'::jsonb, $4, $5, 'intent', 'duplicate', 'constraint-root', 'schema', $3)`,
				[
					address.engine,
					address.database,
					address.schema,
					address.kind,
					address.name,
				],
			),
		).rejects.toThrow();
	});

	it('SC-12: a PostgreSQL advisory-lock error is returned as a refusal without waiting', async () => {
		const refusal = await acquirePgLedgerLocks(
			{
				query: async () => {
					throw new Error('permission denied for advisory lock');
				},
			},
			[{ scope: 'database' }],
		);
		expect(refusal).toMatchObject({
			kind: 'refused',
			ledger: { scope: 'database' },
		});
		if (refusal.kind === 'refused')
			expect(refusal.error).toMatchObject({
				message: 'permission denied for advisory lock',
			});
	});
});
