import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import {
	armOneShotInsertFailpoint,
	createStreamingStandbyTopology,
	describeWithE2eCapabilities,
	dumpAndRestoreInLocalPostgresContainer,
} from './harness/index.js';
import { createSchema, dropSchema, getTestPool } from './testkit/index.js';

describeWithE2eCapabilities(
	['container-exec'],
	'SC-01 #481 container dump/restore harness positive path',
	() => {
		it('round-trips a database through in-container pg_dump and pg_restore', async () => {
			const suffix = randomUUID().replaceAll('-', '');
			const sourceDatabase = `dbsp_e2e_dump_source_${suffix}`;
			const targetDatabase = `dbsp_e2e_dump_target_${suffix}`;
			const pool = await getTestPool();
			try {
				await pool.query(`CREATE DATABASE ${sourceDatabase}`);
				await pool.query(`CREATE DATABASE ${targetDatabase}`);
				const source = new pg.Pool({
					connectionString: process.env.DATABASE_URL?.replace(
						/\/[^/?]+(?=\?|$)/u,
						`/${sourceDatabase}`,
					),
				});
				try {
					await source.query('CREATE TABLE harness_round_trip (value integer)');
					await source.query(
						'INSERT INTO harness_round_trip (value) VALUES (481)',
					);
				} finally {
					await source.end();
				}
				await dumpAndRestoreInLocalPostgresContainer({
					sourceDatabase,
					targetDatabase,
				});
				const target = new pg.Pool({
					connectionString: process.env.DATABASE_URL?.replace(
						/\/[^/?]+(?=\?|$)/u,
						`/${targetDatabase}`,
					),
				});
				try {
					const restored = await target.query<{ value: number }>(
						'SELECT value FROM harness_round_trip',
					);
					expect(restored.rows).toEqual([{ value: 481 }]);
				} finally {
					await target.end();
				}
			} finally {
				await pool.query(`DROP DATABASE IF EXISTS ${sourceDatabase}`);
				await pool.query(`DROP DATABASE IF EXISTS ${targetDatabase}`);
			}
		});
	},
);

describeWithE2eCapabilities(
	['standby-topology'],
	'SC-01 #481 streaming standby harness positive path',
	() => {
		it('starts an observable streaming primary/standby topology', async () => {
			const topology = await createStreamingStandbyTopology();
			try {
				const state = await topology.standbyPool.query<{ streaming: boolean }>(
					'SELECT pg_catalog.pg_is_in_recovery() AND EXISTS (SELECT 1 FROM pg_catalog.pg_stat_wal_receiver) AS streaming',
				);
				expect(state.rows[0]?.streaming).toBe(true);
			} finally {
				await topology.stop();
			}
		});
	},
);

describeWithE2eCapabilities(
	[],
	'SC-01 #481 one-shot insert failpoint harness positive path',
	() => {
		it('fires once for its exact matching insert, then lets a second insert pass', async () => {
			const schema = `harness_failpoint_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
			const pool = await getTestPool();
			let failpoint:
				| Awaited<ReturnType<typeof armOneShotInsertFailpoint>>
				| undefined;
			try {
				await createSchema(schema);
				await pool.query(
					`CREATE TABLE "${schema}"."events" (id integer PRIMARY KEY, marker text NOT NULL)`,
				);
				failpoint = await armOneShotInsertFailpoint(pool, {
					schema,
					table: 'events',
					column: 'marker',
					value: 'fire-once',
				});
				await expect(
					pool.query(
						`INSERT INTO "${schema}"."events" (id, marker) VALUES (1, 'fire-once')`,
					),
				).rejects.toThrow(failpoint.message);
				await failpoint.assertFired();
				await pool.query(
					`INSERT INTO "${schema}"."events" (id, marker) VALUES (2, 'fire-once')`,
				);
				await failpoint.disarm();
				failpoint = undefined;
			} finally {
				await failpoint?.disarm().catch(() => undefined);
				await dropSchema(schema);
			}
		});
	},
);
