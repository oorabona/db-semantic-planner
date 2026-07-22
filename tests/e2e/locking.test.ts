/**
 * E15 — Row-Level Locking E2E Tests
 *
 * Tests concurrent job queue pattern with FOR UPDATE SKIP LOCKED:
 * - Two workers claim jobs concurrently → each gets a different row
 * - SKIP LOCKED prevents double-processing
 * - Lock strengths produce correct SQL and execute against real PostgreSQL
 */

import {
	PgsqlTransactionAbortSignalError,
	PgsqlTransactionTimeoutError,
} from '@dbsp/adapter-pgsql';
import { createOrm, eq, schema } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSchema, dropSchema } from './testkit/db.js';
import { closeTestDb, getTestAdapter, getTestPool } from './testkit/index.js';
import { sql } from './testkit/sql.js';

// ============================================================================
// Schema: job queue
// ============================================================================

const jobSchema = schema({
	jobs: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		status: 'string',
		priority: 'integer',
		workerId: { type: 'string', nullable: true },
	},
});

const SCHEMA = 'locking_e2e';

describe('E15 — Row-level locking', () => {
	beforeAll(async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);

		const pool = await getTestPool();
		const s = sql.ref(SCHEMA);

		// Create jobs table
		await sql`
			CREATE TABLE ${s}.jobs (
				id SERIAL PRIMARY KEY,
				status TEXT NOT NULL DEFAULT 'pending',
				priority INTEGER NOT NULL DEFAULT 0,
				worker_id TEXT
			)
		`.execute(pool);

		// Seed 5 pending jobs
		await sql`
			INSERT INTO ${s}.jobs (status, priority) VALUES
				('pending', 10),
				('pending', 20),
				('pending', 30),
				('pending', 40),
				('pending', 50)
		`.execute(pool);
	});

	afterAll(async () => {
		await dropSchema(SCHEMA);
		await closeTestDb();
	});

	// ========================================================================
	// Basic lock execution
	// ========================================================================

	it('FOR UPDATE executes without error', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: jobSchema.model, adapter });
		const scoped = orm.withSchema(SCHEMA);

		const jobs = await scoped.transaction(async (tx) => {
			return tx.select('jobs').forUpdate().all();
		});

		expect(jobs.length).toBe(5);
	});

	it('FOR SHARE executes without error', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: jobSchema.model, adapter });
		const scoped = orm.withSchema(SCHEMA);

		const jobs = await scoped.transaction(async (tx) => {
			return tx.select('jobs').forShare().all();
		});

		expect(jobs.length).toBe(5);
	});

	it('FOR UPDATE SKIP LOCKED returns all rows when none locked', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: jobSchema.model, adapter });
		const scoped = orm.withSchema(SCHEMA);

		const jobs = await scoped.transaction(async (tx) => {
			return tx.select('jobs').forUpdate().skipLocked().all();
		});

		expect(jobs.length).toBe(5);
	});

	it('reports affected row counts for UPDATE and DELETE terminals', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: jobSchema.model, adapter });
		const scoped = orm.withSchema(SCHEMA);
		const rollback = new Error('rollback affectedRows probe');

		await expect(
			scoped.transaction(async (tx) => {
				const updated = await tx
					.update('jobs')
					.set({ workerId: 'affected-rows-probe' })
					.where(eq('status', 'pending'))
					.affectedRows();
				const deleted = await tx
					.delete('jobs')
					.where(eq('workerId', 'affected-rows-probe'))
					.affectedRows();

				expect(updated).toBe(5);
				expect(deleted).toBe(5);
				throw rollback;
			}),
		).rejects.toBe(rollback);
	});

	// ========================================================================
	// Concurrent job claim (core pattern)
	// ========================================================================

	it('two concurrent workers each claim a different job', async () => {
		const pool = await getTestPool();
		const s = sql.ref(SCHEMA);

		// Reset all jobs to pending
		await sql`UPDATE ${s}.jobs SET status = 'pending', worker_id = NULL`.execute(
			pool,
		);

		// Worker function: claim highest-priority pending job
		async function claimJob(workerId: string): Promise<number | null> {
			const client = await pool.connect();
			try {
				await client.query('BEGIN');

				// SELECT ... FOR UPDATE SKIP LOCKED — concurrent-safe claim
				const result = await client.query(
					`SELECT id FROM "${SCHEMA}".jobs
					 WHERE status = 'pending'
					 ORDER BY priority DESC
					 LIMIT 1
					 FOR UPDATE SKIP LOCKED`,
				);

				if (result.rows.length === 0) {
					await client.query('ROLLBACK');
					return null;
				}

				const jobId = result.rows[0].id as number;

				// Claim the job
				await client.query(
					`UPDATE "${SCHEMA}".jobs SET status = 'running', worker_id = $1 WHERE id = $2`,
					[workerId, jobId],
				);

				await client.query('COMMIT');
				return jobId;
			} catch {
				await client.query('ROLLBACK');
				return null;
			} finally {
				client.release();
			}
		}

		// Run two workers concurrently
		const [job1, job2] = await Promise.all([
			claimJob('worker-1'),
			claimJob('worker-2'),
		]);

		// Both should have claimed a job
		expect(job1).not.toBeNull();
		expect(job2).not.toBeNull();

		// Each gets a DIFFERENT job (SKIP LOCKED prevents double-claim)
		expect(job1).not.toBe(job2);

		// Verify DB state: exactly 2 jobs are running
		const running = await sql`
			SELECT id, worker_id FROM ${s}.jobs WHERE status = 'running' ORDER BY id
		`.execute(pool);

		expect(running.rows.length).toBe(2);

		// Each worker owns exactly one job
		const workers = running.rows.map(
			(r: Record<string, unknown>) => r.worker_id,
		);
		expect(workers).toContain('worker-1');
		expect(workers).toContain('worker-2');
	});

	it('NOWAIT fails immediately when row is locked', async () => {
		const pool = await getTestPool();
		const s = sql.ref(SCHEMA);

		// Reset all jobs
		await sql`UPDATE ${s}.jobs SET status = 'pending', worker_id = NULL`.execute(
			pool,
		);

		const client1 = await pool.connect();
		const client2 = await pool.connect();

		try {
			// Worker 1: lock all rows
			await client1.query('BEGIN');
			await client1.query(`SELECT * FROM "${SCHEMA}".jobs FOR UPDATE`);

			// Worker 2: try NOWAIT — should fail immediately
			await client2.query('BEGIN');
			await expect(
				client2.query(`SELECT * FROM "${SCHEMA}".jobs FOR UPDATE NOWAIT`),
			).rejects.toThrow(/could not obtain lock/);

			await client2.query('ROLLBACK');
			await client1.query('ROLLBACK');
		} finally {
			client1.release();
			client2.release();
		}
	});

	it('lock_timeout raises a typed transaction timeout under a held lock', async () => {
		const pool = await getTestPool();
		const holder = await pool.connect();
		try {
			await holder.query('BEGIN');
			await holder.query(
				`SELECT * FROM "${SCHEMA}".jobs WHERE id = 1 FOR UPDATE`,
			);

			const adapter = await getTestAdapter();
			const error = await (async (): Promise<unknown> => {
				try {
					await adapter.transaction(
						async (tx) => {
							await tx.executeRaw(
								`SELECT * FROM "${SCHEMA}".jobs WHERE id = 1 FOR UPDATE`,
							);
						},
						{ lockTimeoutMs: 50 },
					);
				} catch (caught) {
					return caught;
				}
				throw new Error('Expected lock timeout');
			})();

			expect(error).toBeInstanceOf(PgsqlTransactionTimeoutError);
			expect((error as PgsqlTransactionTimeoutError).timeout).toBe(
				'lock_timeout',
			);
		} finally {
			await holder.query('ROLLBACK').catch(() => undefined);
			holder.release();
		}
	});

	it('AbortSignal destroys a pool-owned transaction blocked on a row lock', async () => {
		const pool = await getTestPool();
		const holder = await pool.connect();
		const adapter = await getTestAdapter();
		const controller = new AbortController();
		let abortTimer: ReturnType<typeof setTimeout> | undefined;

		try {
			await holder.query('BEGIN');
			await holder.query(
				`SELECT * FROM "${SCHEMA}".jobs WHERE id = 1 FOR UPDATE`,
			);

			abortTimer = setTimeout(() => controller.abort(), 50);
			const error = await (async (): Promise<unknown> => {
				try {
					await adapter.transaction(
						async (tx) => {
							await tx.executeRaw(
								`SELECT * FROM "${SCHEMA}".jobs WHERE id = 1 FOR UPDATE`,
							);
						},
						{ signal: controller.signal },
					);
				} catch (caught) {
					return caught;
				}
				throw new Error('Expected AbortSignal transaction abort');
			})();

			expect(error).toBeInstanceOf(PgsqlTransactionAbortSignalError);
		} finally {
			if (abortTimer !== undefined) clearTimeout(abortTimer);
			await holder.query('ROLLBACK').catch(() => undefined);
			holder.release();
		}

		await expect(
			adapter.transaction(
				async (tx) => {
					await tx.executeRaw(
						`SELECT * FROM "${SCHEMA}".jobs WHERE id = 1 FOR UPDATE`,
					);
				},
				{ lockTimeoutMs: 100 },
			),
		).resolves.toBeUndefined();
	});

	it('SKIP LOCKED returns empty when all rows are locked', async () => {
		const pool = await getTestPool();

		const client1 = await pool.connect();
		const client2 = await pool.connect();

		try {
			// Worker 1: lock all rows
			await client1.query('BEGIN');
			await client1.query(`SELECT * FROM "${SCHEMA}".jobs FOR UPDATE`);

			// Worker 2: SKIP LOCKED returns empty set
			await client2.query('BEGIN');
			const result = await client2.query(
				`SELECT * FROM "${SCHEMA}".jobs FOR UPDATE SKIP LOCKED`,
			);
			expect(result.rows.length).toBe(0);

			await client2.query('ROLLBACK');
			await client1.query('ROLLBACK');
		} finally {
			client1.release();
			client2.release();
		}
	});
});
