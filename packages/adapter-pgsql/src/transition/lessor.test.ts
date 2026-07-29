import {
	acquireExclusiveTransitionLease,
	planOperationSession,
} from '@dbsp/core';
import { Client, Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { evaluatePgExecutionContract } from './execution-contract.js';
import { createPgTransitionLessor, withPgTransitionRunLock } from './lessor.js';

describe('createPgTransitionLessor', () => {
	it('uses the pool acquisition function through the core-minted lessor', async () => {
		const client = {
			query: vi.fn(async (sql: string) =>
				sql === 'SHOW client_encoding'
					? { rows: [{ client_encoding: 'UTF8' }] }
					: { rows: [] },
			),
			release: vi.fn(),
		};
		const pool = new Pool();
		const connect = vi.fn(async () => client);
		Object.defineProperty(pool, 'connect', { value: connect });
		const lessor = createPgTransitionLessor(pool);

		const lease = await lessor.acquire();
		expect(lease).not.toBe(client);
		expect(Object.isFrozen(lease)).toBe(true);
		await lease.query('SELECT 1');
		lease.release();
		expect(client.query.mock.calls.slice(0, 2)).toEqual([
			["SET client_encoding TO 'UTF8'", undefined],
			['SHOW client_encoding', undefined],
		]);
		expect(client.query).toHaveBeenCalledWith('SELECT 1', undefined);
		expect(client.query.mock.calls.slice(0, 2)).toEqual([
			["SET client_encoding TO 'UTF8'", undefined],
			['SHOW client_encoding', undefined],
		]);
		expect(client.release).toHaveBeenCalledWith(undefined);
		expect(connect).toHaveBeenCalledOnce();
		await pool.end();
	});

	it('refuses a real pg Client made to represent a checked-out client', () => {
		const client = new Client();
		Object.defineProperty(client, 'release', { value: vi.fn() });

		expect(() => createPgTransitionLessor(client as never)).toThrow(
			'received a checked-out pg PoolClient',
		);
	});

	it('refuses a pg Client at acquisition, where connect() resolves to itself', async () => {
		// A Pool and a Client are structurally identical, so the constructor cannot
		// tell them apart. What connect() returns can: a Client resolves to itself,
		// with no release() to give the lease back.
		const client = new Client();
		const end = vi.fn(async () => {});
		Object.defineProperty(client, 'connect', {
			value: vi.fn(async () => client),
		});
		Object.defineProperty(client, 'end', { value: end });
		const lessor = createPgTransitionLessor(client as never);

		await expect(lessor.acquire()).rejects.toThrow(
			'was given a pg Client rather than a pg Pool',
		);
		// connect() opened the connection, and the rejected value has no release()
		// to give it back with, so repeating the mistake would leak one socket a time.
		expect(end).toHaveBeenCalledOnce();
	});

	it('still reports the caller mistake when closing the connection fails', async () => {
		const client = new Client();
		Object.defineProperty(client, 'connect', {
			value: vi.fn(async () => client),
		});
		Object.defineProperty(client, 'end', {
			value: vi.fn(async () => {
				throw new Error('socket already gone');
			}),
		});
		const lessor = createPgTransitionLessor(client as never);

		await expect(lessor.acquire()).rejects.toThrow(
			'was given a pg Client rather than a pg Pool',
		);
	});

	it('reports the caller mistake without waiting for a close that never ends', async () => {
		// The thing that already misbehaved must not be handed an unbounded delay:
		// a broken socket, or an end() that simply never settles, would otherwise
		// hold acquire() open forever instead of naming the caller's mistake.
		const client = new Client();
		Object.defineProperty(client, 'connect', {
			value: vi.fn(async () => client),
		});
		const end = vi.fn(() => new Promise<void>(() => undefined));
		Object.defineProperty(client, 'end', { value: end });
		const lessor = createPgTransitionLessor(client as never);

		await expect(
			Promise.race([
				lessor.acquire().catch((error: unknown) => error),
				new Promise((resolve) => setTimeout(() => resolve('hung'), 50)),
			]),
		).resolves.toBeInstanceOf(Error);
		expect(end).toHaveBeenCalledOnce();
	});

	it('closes a connection whose release getter rejects the acquisition guard', async () => {
		const end = vi.fn(async () => {});
		const client = { end };
		Object.defineProperty(client, 'release', {
			get: () => {
				throw new Error('release getter failed');
			},
		});
		const pool = {
			connect: vi.fn(async () => client),
		};
		const lessor = createPgTransitionLessor(pool as never);

		await expect(lessor.acquire()).rejects.toThrow(
			'was given a pg Client rather than a pg Pool',
		);
		expect(end).toHaveBeenCalledOnce();
	});

	it('captures end() before reading the member that decides to close', async () => {
		const end = vi.fn(async () => {});
		const client = { end };
		Object.defineProperty(client, 'release', {
			get: () => {
				// A getter is caller code. This one removes the only cleanup left on
				// the very path that needs it — which only fails if end() is read after.
				Reflect.deleteProperty(client, 'end');
				return undefined;
			},
		});
		const pool = { connect: vi.fn(async () => client) };
		const lessor = createPgTransitionLessor(pool as never);

		await expect(lessor.acquire()).rejects.toThrow(
			'was given a pg Client rather than a pg Pool',
		);
		expect(end).toHaveBeenCalledOnce();
	});

	it('forwards through members captured once across the whole lease lifecycle', async () => {
		const reads: string[] = [];
		const end = vi.fn(async () => {});
		const release = vi.fn();
		const query = vi.fn(async (sql: string) =>
			sql === 'SHOW client_encoding'
				? { rows: [{ client_encoding: 'UTF8' }] }
				: { rows: [] },
		);
		let releaseReads = 0;
		let queryReads = 0;
		const client = {} as Record<string, unknown>;
		Object.defineProperties(client, {
			end: {
				get: () => {
					reads.push('end');
					return end;
				},
			},
			release: {
				get: () => {
					releaseReads += 1;
					reads.push('release');
					if (releaseReads === 1) {
						return release;
					}
					throw new Error('release getter read after acquisition');
				},
			},
			query: {
				get: () => {
					queryReads += 1;
					reads.push('query');
					if (queryReads === 1) {
						return query;
					}
					throw new Error('query getter read after acquisition');
				},
			},
		});
		const lessor = createPgTransitionLessor({
			connect: vi.fn(async () => client),
		} as never);

		const lease = await lessor.acquire();
		expect(reads).toEqual(['end', 'release', 'query']);
		expect(lease).not.toBe(client);
		expect(Object.isFrozen(lease)).toBe(true);
		await lease.query('SELECT 1');
		lease.release();
		expect(query).toHaveBeenCalledWith('SELECT 1', undefined);
		expect(release).toHaveBeenCalledWith(undefined);
		expect(queryReads).toBe(1);
		expect(releaseReads).toBe(1);
		expect(reads).toEqual(['end', 'release', 'query']);
		expect(end).not.toHaveBeenCalled();
	});

	it('returns a malformed acquisition through its captured release()', async () => {
		const reads: string[] = [];
		const end = vi.fn(async () => {});
		const release = vi.fn();
		const client = {} as Record<string, unknown>;
		Object.defineProperties(client, {
			end: {
				get: () => {
					reads.push('end');
					return end;
				},
			},
			release: {
				get: () => {
					reads.push('release');
					return release;
				},
			},
			query: {
				get: () => {
					reads.push('query');
					return undefined;
				},
			},
		});
		const lessor = createPgTransitionLessor({
			connect: vi.fn(async () => client),
		} as never);

		await expect(lessor.acquire()).rejects.toThrow(
			'acquired a malformed pg lease without query()',
		);
		expect(reads).toEqual(['end', 'release', 'query']);
		expect(release).toHaveBeenCalledOnce();
		expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
		expect(end).not.toHaveBeenCalled();
	});

	it('closes a malformed acquisition with no release through end()', async () => {
		const end = vi.fn(async () => {});
		const lessor = createPgTransitionLessor({
			connect: vi.fn(async () => ({ query: vi.fn(), end })),
		} as never);

		await expect(lessor.acquire()).rejects.toThrow(
			'was given a pg Client rather than a pg Pool',
		);
		expect(end).toHaveBeenCalledOnce();
	});
});

describe('withPgTransitionRunLock cleanup', () => {
	it.each([
		{
			name: 'returns false',
			unlock: async () => ({ rows: [{ unlocked: false }] }),
		},
		{
			name: 'throws',
			unlock: async () => {
				throw new Error('unlock transport failed');
			},
		},
	])('mutation: returning the lock-owning client after pg_advisory_unlock $name lets the pool hand out a live lock', async ({
		unlock,
	}) => {
		const first = {
			query: vi.fn(async (sql: string) => {
				if (sql === 'SHOW client_encoding')
					return { rows: [{ client_encoding: 'UTF8' }] };
				if (sql.includes('pg_try_advisory_lock'))
					return { rows: [{ locked: true }] };
				if (sql.includes('pg_advisory_unlock')) return unlock();
				return { rows: [] };
			}),
			release: vi.fn(),
		};
		const replacement = { query: vi.fn(), release: vi.fn() };
		let destroyed = false;
		const pool = {
			connect: vi.fn(async () => (destroyed ? replacement : first)),
		} as unknown as Pool;
		first.release.mockImplementation((error?: unknown) => {
			destroyed = Boolean(error);
		});

		await expect(
			withPgTransitionRunLock(pool, 'run:cleanup', async () => 'done'),
		).rejects.toThrow('lock cleanup failed');
		expect(first.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
		expect(await pool.connect()).toBe(replacement);
	});
});

describe('withPgTransitionRunLock statement origin', () => {
	function lockedPool() {
		let lockHeld = true;
		let encoding = 'UTF8';
		const client = {
			query: vi.fn(async (sql: string) => {
				if (sql === "SET client_encoding TO 'UTF8'") {
					encoding = 'UTF8';
					return { rows: [] };
				}
				if (sql === 'SHOW client_encoding')
					return { rows: [{ client_encoding: encoding }] };
				if (sql.includes('pg_try_advisory_lock'))
					return { rows: [{ locked: true }] };
				if (sql.includes('FROM pg_catalog.pg_locks')) {
					return {
						rows: [{ run_lock_held: lockHeld, client_encoding: encoding }],
					};
				}
				if (sql.includes('pg_advisory_unlock')) {
					const unlocked = lockHeld;
					lockHeld = false;
					return { rows: [{ unlocked }] };
				}
				if (sql.includes('pg_catalog.pg_advisory_unlock')) {
					lockHeld = false;
					return { rows: [] };
				}
				if (sql === "SET NAMES 'LATIN1'") {
					encoding = 'LATIN1';
					return { rows: [] };
				}
				return { rows: [] };
			}),
			release: vi.fn(),
		};
		return {
			client,
			pool: { connect: vi.fn(async () => client) } as unknown as Pool,
		};
	}

	it('allows the contract client_encoding set-and-verify on the durable infrastructure channel', async () => {
		const { pool } = lockedPool();
		let evaluation: Awaited<ReturnType<typeof evaluatePgExecutionContract>>;

		await withPgTransitionRunLock(
			pool,
			'run:contract-setting',
			async (target) => {
				const lease = await acquireExclusiveTransitionLease(target);
				try {
					evaluation = await evaluatePgExecutionContract(lease.session, {
						version: 1,
						requirements: [
							{
								kind: 'postgresql.session-setting',
								mode: 'set-and-verify',
								setting: 'client_encoding',
								value: 'UTF8',
							},
						],
					});
				} finally {
					await lease.release();
				}
				return undefined;
			},
		);

		expect(evaluation!).toEqual({ ok: true });
	});

	it('mutation: a plan operation releasing the run lock is refused by the operation-origin invariant check', async () => {
		const { pool } = lockedPool();
		let failure: unknown;

		await expect(
			withPgTransitionRunLock(pool, 'run:plan-unlock', async (target) => {
				const lease = await acquireExclusiveTransitionLease(target);
				try {
					await planOperationSession(lease.session).query(
						'SELECT pg_catalog.pg_advisory_unlock(1)',
					);
				} catch (error) {
					failure = error;
				} finally {
					await lease.release();
				}
				return undefined;
			}),
		).rejects.toThrow('lock cleanup failed');

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe(
			'durable plan operation may not release the run lock or change client_encoding',
		);
	});

	it('mutation: an alternative encoding spelling from a plan operation is refused without SQL text matching', async () => {
		const { client, pool } = lockedPool();
		let failure: unknown;

		await withPgTransitionRunLock(pool, 'run:plan-encoding', async (target) => {
			const lease = await acquireExclusiveTransitionLease(target);
			try {
				await planOperationSession(lease.session).query("SET NAMES 'LATIN1'");
			} catch (error) {
				failure = error;
			} finally {
				await lease.release();
			}
			return undefined;
		});

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe(
			'durable plan operation may not release the run lock or change client_encoding',
		);
		expect(client.release).toHaveBeenCalledWith(expect.any(Error));
	});

	it('mutation: a pre-query invariant violation must discard the session even when cleanup unlocks', async () => {
		const { client, pool } = lockedPool();

		await withPgTransitionRunLock(
			pool,
			'run:pre-query-violation',
			async (target) => {
				const lease = await acquireExclusiveTransitionLease(target);
				try {
					// This ordinary channel mutation models a violation already present
					// when the operation channel reaches its pre-query assertion.
					await lease.session.query("SET NAMES 'LATIN1'");
					await expect(
						planOperationSession(lease.session).query('SELECT 1'),
					).rejects.toThrow(
						'durable plan operation may not release the run lock or change client_encoding',
					);
				} finally {
					await lease.release();
				}
				return undefined;
			},
		);

		expect(client.query).not.toHaveBeenCalledWith('SELECT 1', undefined);
		expect(client.release).toHaveBeenCalledWith(expect.any(Error));
	});
});
