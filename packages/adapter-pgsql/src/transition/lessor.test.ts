import {
	acquireExclusiveTransitionLease,
	planOperationSession,
} from '@dbsp/core';
import { markTransitionClientCompromised } from '@dbsp/core/internal';
import { Client, Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { evaluatePgExecutionContract } from './execution-contract.js';
import {
	createPgTransitionLessor,
	isDeadPgConnectionError,
	withPgTransitionRunLock,
} from './lessor.js';

describe('createPgTransitionLessor', () => {
	it.each([
		[{ code: 'ECONNRESET' }, true],
		[{ code: 'EPIPE' }, true],
		[{ code: 'ETIMEDOUT' }, true],
		[{ code: '57P01' }, true],
		[{ code: '57P02' }, true],
		[{ code: '57P03' }, true],
		[{ code: '40001', message: 'could not serialize access' }, false],
		[{ code: '23505', message: 'duplicate key value' }, false],
	])(
		'classifies dead PostgreSQL connections conservatively: %o',
		(error, dead) => {
			expect(isDeadPgConnectionError(error)).toBe(dead);
		},
	);

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
	it('evicts the physical client when a marked lease is abandoned by a failing callback', async () => {
		const callbackFailure = new Error(
			'callback failed after marking its lease',
		);
		const client = {
			query: vi.fn(async (sql: string) => {
				if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
				if (sql === 'SHOW client_encoding')
					return { rows: [{ client_encoding: 'UTF8' }] };
				if (sql.includes('pg_try_advisory_lock'))
					return { rows: [{ locked: true }] };
				if (sql.includes('FROM pg_catalog.pg_locks')) {
					return {
						rows: [
							{
								run_lock_held: true,
								session_user: 'dbsp',
								current_user: 'dbsp',
								standard_conforming_strings: 'on',
								search_path: 'public',
								client_encoding: 'UTF8',
								time_zone: 'Etc/UTC',
							},
						],
					};
				}
				if (sql.includes('pg_advisory_unlock'))
					return { rows: [{ unlocked: true }] };
				return { rows: [] };
			}),
			release: vi.fn(),
		};
		const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

		await expect(
			withPgTransitionRunLock(
				pool,
				'run:abandoned-compromised-lease',
				async (target) => {
					const lease = await acquireExclusiveTransitionLease(target);
					markTransitionClientCompromised(lease.session);
					throw callbackFailure;
				},
			),
		).rejects.toBe(callbackFailure);

		expect(client.release).toHaveBeenCalledWith(expect.any(Error));
		expect(
			client.query.mock.calls.some(([sql]) =>
				String(sql).includes('pg_advisory_unlock'),
			),
		).toBe(false);
	});

	it('evicts a lock-owned client when an exclusive lease is marked compromised', async () => {
		const client = {
			query: vi.fn(async (sql: string) => {
				if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
				if (sql === 'SHOW client_encoding')
					return { rows: [{ client_encoding: 'UTF8' }] };
				if (sql.includes('pg_try_advisory_lock'))
					return { rows: [{ locked: true }] };
				if (sql.includes('FROM pg_catalog.pg_locks')) {
					return {
						rows: [
							{
								run_lock_held: true,
								session_user: 'dbsp',
								current_user: 'dbsp',
								standard_conforming_strings: 'on',
								search_path: 'public',
								client_encoding: 'UTF8',
								time_zone: 'Etc/UTC',
							},
						],
					};
				}
				if (sql.includes('pg_advisory_unlock'))
					return { rows: [{ unlocked: true }] };
				return { rows: [] };
			}),
			release: vi.fn(),
		};
		const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

		await expect(
			withPgTransitionRunLock(pool, 'run:compromised-lease', async (target) => {
				const compromisedLease = await acquireExclusiveTransitionLease(target);
				const siblingLease = await acquireExclusiveTransitionLease(target);
				markTransitionClientCompromised(compromisedLease.session);
				await expect(
					compromisedLease.session.query('SELECT same lease after compromise'),
				).rejects.toThrow(
					'transition execution marked its leased client compromised',
				);
				await expect(
					siblingLease.session.query('SELECT ordinary after compromise'),
				).rejects.toThrow(
					'transition execution marked its leased client compromised',
				);
				await expect(
					planOperationSession(siblingLease.session).query(
						'SELECT plan operation after compromise',
					),
				).rejects.toThrow(
					'transition execution marked its leased client compromised',
				);
				await compromisedLease.release();
				await expect(acquireExclusiveTransitionLease(target)).rejects.toThrow(
					'PostgreSQL transition session is compromised after a lease release failure',
				);
				await siblingLease.release();
			}),
		).resolves.toEqual({ kind: 'acquired', value: undefined });
		expect(client.release).toHaveBeenCalledWith(expect.any(Error));
		expect(client.query).not.toHaveBeenCalledWith(
			'SELECT same lease after compromise',
			undefined,
		);
		expect(client.query).not.toHaveBeenCalledWith(
			'SELECT ordinary after compromise',
			undefined,
		);
		expect(client.query).not.toHaveBeenCalledWith(
			'SELECT plan operation after compromise',
			undefined,
		);
		expect(
			client.query.mock.calls.some(([sql]) =>
				String(sql).includes('pg_advisory_unlock'),
			),
		).toBe(false);
	});

	it('keeps the first lease failure at gateways and physical release', async () => {
		const firstFailure = new Error('first lease failure');
		const secondFailure = new Error('second lease failure');
		const client = {
			query: vi.fn(async (sql: string) => {
				if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
				if (sql === 'SHOW client_encoding')
					return { rows: [{ client_encoding: 'UTF8' }] };
				if (sql.includes('pg_try_advisory_lock'))
					return { rows: [{ locked: true }] };
				if (sql.includes('FROM pg_catalog.pg_locks')) {
					return {
						rows: [
							{
								run_lock_held: true,
								session_user: 'dbsp',
								current_user: 'dbsp',
								standard_conforming_strings: 'on',
								search_path: 'public',
								client_encoding: 'UTF8',
								time_zone: 'Etc/UTC',
							},
						],
					};
				}
				if (sql.includes('pg_advisory_unlock'))
					return { rows: [{ unlocked: true }] };
				return { rows: [] };
			}),
			release: vi.fn(),
		};
		const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

		await expect(
			withPgTransitionRunLock(
				pool,
				'run:first-lease-failure',
				async (target) => {
					const firstLease = await acquireExclusiveTransitionLease(target);
					const secondLease = await acquireExclusiveTransitionLease(target);
					const gatewayLease = await acquireExclusiveTransitionLease(target);
					await firstLease.release({ error: firstFailure });
					await expect(
						secondLease.session.query('SELECT blocked'),
					).rejects.toThrow(
						'PostgreSQL transition session is compromised after a lease release failure',
					);
					await secondLease.release({ error: secondFailure });
					await expect(
						gatewayLease.session.query('SELECT still blocked'),
					).rejects.toThrow(
						'PostgreSQL transition session is compromised after a lease release failure',
					);
					await gatewayLease.release();
				},
			),
		).resolves.toEqual({ kind: 'acquired', value: undefined });

		expect(client.release).toHaveBeenCalledWith(firstFailure);
	});

	it('keeps a lease failure at physical release when a later query records a dead connection', async () => {
		const firstFailure = new Error('first lease failure');
		const dead = Object.assign(new Error('backend died later'), {
			code: '57P01',
		});
		let rejectDeadQuery: ((reason: unknown) => void) | undefined;
		const client = {
			query: vi.fn(async (sql: string) => {
				if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
				if (sql === 'SHOW client_encoding')
					return { rows: [{ client_encoding: 'UTF8' }] };
				if (sql.includes('pg_try_advisory_lock'))
					return { rows: [{ locked: true }] };
				if (sql.includes('FROM pg_catalog.pg_locks')) {
					return {
						rows: [
							{
								run_lock_held: true,
								session_user: 'dbsp',
								current_user: 'dbsp',
								standard_conforming_strings: 'on',
								search_path: 'public',
								client_encoding: 'UTF8',
								time_zone: 'Etc/UTC',
							},
						],
					};
				}
				if (sql === 'SELECT dead after lease failure')
					return new Promise<never>((_resolve, reject) => {
						rejectDeadQuery = reject;
					});
				return { rows: [] };
			}),
			release: vi.fn(),
		};
		const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

		await expect(
			withPgTransitionRunLock(
				pool,
				'run:first-failure-wins-dead',
				async (target) => {
					const lease = await acquireExclusiveTransitionLease(target);
					const deadQuery = lease.session.query(
						'SELECT dead after lease failure',
					);
					await lease.release({ error: firstFailure });
					rejectDeadQuery?.(dead);
					await expect(deadQuery).rejects.toBe(dead);
				},
			),
		).resolves.toEqual({ kind: 'acquired', value: undefined });

		expect(client.release).toHaveBeenCalledWith(firstFailure);
	});

	it('evicts the physical client when a wrapper is marked while lock cleanup is pending', async () => {
		let resolveUnlock:
			| ((value: { rows: readonly Record<string, unknown>[] }) => void)
			| undefined;
		let unlockStarted: (() => void) | undefined;
		const unlockPending = new Promise<void>((resolve) => {
			unlockStarted = resolve;
		});
		const client = {
			query: vi.fn(async (sql: string) => {
				if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
				if (sql === 'SHOW client_encoding')
					return { rows: [{ client_encoding: 'UTF8' }] };
				if (sql.includes('pg_try_advisory_lock'))
					return { rows: [{ locked: true }] };
				if (sql.includes('FROM pg_catalog.pg_locks')) {
					return {
						rows: [
							{
								run_lock_held: true,
								session_user: 'dbsp',
								current_user: 'dbsp',
								standard_conforming_strings: 'on',
								search_path: 'public',
								client_encoding: 'UTF8',
								time_zone: 'Etc/UTC',
							},
						],
					};
				}
				if (sql.includes('pg_advisory_unlock')) {
					unlockStarted?.();
					return new Promise((resolve) => {
						resolveUnlock = resolve;
					});
				}
				return { rows: [] };
			}),
			release: vi.fn(),
		};
		const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
		let lease:
			| Awaited<ReturnType<typeof acquireExclusiveTransitionLease>>
			| undefined;

		const run = withPgTransitionRunLock(
			pool,
			'run:mark-during-unlock',
			async (target) => {
				lease = await acquireExclusiveTransitionLease(target);
			},
		);
		await unlockPending;
		if (!lease) throw new Error('exclusive lease was not acquired');
		markTransitionClientCompromised(lease.session);
		resolveUnlock?.({ rows: [{ unlocked: true }] });

		await expect(run).resolves.toEqual({ kind: 'acquired', value: undefined });
		expect(client.release).toHaveBeenCalledWith(expect.any(Error));
	});

	it('evicts the client when its release getter marks the lease', async () => {
		let lease:
			| Awaited<ReturnType<typeof acquireExclusiveTransitionLease>>
			| undefined;
		const release = vi.fn();
		let releaseReads = 0;
		const client = {
			query: vi.fn(async (sql: string) => {
				if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
				if (sql === 'SHOW client_encoding')
					return { rows: [{ client_encoding: 'UTF8' }] };
				if (sql.includes('pg_try_advisory_lock'))
					return { rows: [{ locked: true }] };
				if (sql.includes('FROM pg_catalog.pg_locks')) {
					return {
						rows: [
							{
								run_lock_held: true,
								session_user: 'dbsp',
								current_user: 'dbsp',
								standard_conforming_strings: 'on',
								search_path: 'public',
								client_encoding: 'UTF8',
								time_zone: 'Etc/UTC',
							},
						],
					};
				}
				if (sql.includes('pg_advisory_unlock'))
					return { rows: [{ unlocked: true }] };
				return { rows: [] };
			}),
		};
		Object.defineProperty(client, 'release', {
			get: () => {
				releaseReads += 1;
				if (releaseReads === 1 && lease)
					markTransitionClientCompromised(lease.session);
				return release;
			},
		});
		const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

		await expect(
			withPgTransitionRunLock(
				pool,
				'run:release-getter-mark',
				async (target) => {
					lease = await acquireExclusiveTransitionLease(target);
				},
			),
		).resolves.toEqual({ kind: 'acquired', value: undefined });

		expect(releaseReads).toBe(1);
		expect(release).toHaveBeenCalledWith(expect.any(Error));
	});

	it('wraps a hostile lease failure without coercing it before evicting the client', async () => {
		const hostile = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error('hostile prototype lookup');
				},
			},
		);
		const client = {
			query: vi.fn(async (sql: string) => {
				if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
				if (sql === 'SHOW client_encoding')
					return { rows: [{ client_encoding: 'UTF8' }] };
				if (sql.includes('pg_try_advisory_lock'))
					return { rows: [{ locked: true }] };
				if (sql.includes('FROM pg_catalog.pg_locks')) {
					return {
						rows: [
							{
								run_lock_held: true,
								session_user: 'dbsp',
								current_user: 'dbsp',
								standard_conforming_strings: 'on',
								search_path: 'public',
								client_encoding: 'UTF8',
								time_zone: 'Etc/UTC',
							},
						],
					};
				}
				if (sql.includes('pg_advisory_unlock'))
					return { rows: [{ unlocked: true }] };
				return { rows: [] };
			}),
			release: vi.fn(),
		};
		const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

		await expect(
			withPgTransitionRunLock(
				pool,
				'run:hostile-lease-failure',
				async (target) => {
					const lease = await acquireExclusiveTransitionLease(target);
					await lease.release({ error: hostile });
				},
			),
		).resolves.toEqual({ kind: 'acquired', value: undefined });

		const [releaseFailure] = client.release.mock.calls[0] ?? [];
		expect(releaseFailure).toBeInstanceOf(Error);
		expect((releaseFailure as Error).message).toBe(
			'transition lease reported a non-Error failure',
		);
		expect((releaseFailure as Error).cause).toBe(hostile);
	});

	it('refuses later gateway queries without reading a hostile failure message', async () => {
		const failure = new Error('unused');
		let messageReads = 0;
		Object.defineProperty(failure, 'message', {
			get: () => {
				messageReads += 1;
				throw new Error('hostile message lookup');
			},
		});
		const client = {
			query: vi.fn(async (sql: string) => {
				if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
				if (sql === 'SHOW client_encoding')
					return { rows: [{ client_encoding: 'UTF8' }] };
				if (sql.includes('pg_try_advisory_lock'))
					return { rows: [{ locked: true }] };
				if (sql.includes('FROM pg_catalog.pg_locks')) {
					return {
						rows: [
							{
								run_lock_held: true,
								session_user: 'dbsp',
								current_user: 'dbsp',
								standard_conforming_strings: 'on',
								search_path: 'public',
								client_encoding: 'UTF8',
								time_zone: 'Etc/UTC',
							},
						],
					};
				}
				return { rows: [] };
			}),
			release: vi.fn(),
		};
		const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

		await expect(
			withPgTransitionRunLock(
				pool,
				'run:hostile-failure-message',
				async (target) => {
					const failedLease = await acquireExclusiveTransitionLease(target);
					const gatewayLease = await acquireExclusiveTransitionLease(target);
					await failedLease.release({ error: failure });
					const refusal = await gatewayLease.session
						.query('SELECT blocked')
						.catch((error: unknown) => error);
					expect(refusal).toMatchObject({
						message:
							'PostgreSQL transition session is compromised after a lease release failure',
						cause: failure,
					});
					await gatewayLease.release();
				},
			),
		).resolves.toEqual({ kind: 'acquired', value: undefined });

		expect(messageReads).toBe(0);
	});

	it('preserves a callback recovery result when the pool release throws', async () => {
		const client = {
			query: vi.fn(async (sql: string) => {
				if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
				if (sql === 'SHOW client_encoding')
					return { rows: [{ client_encoding: 'UTF8' }] };
				if (sql.includes('pg_try_advisory_lock'))
					return { rows: [{ locked: true }] };
				if (sql.includes('FROM pg_catalog.pg_locks')) {
					return {
						rows: [
							{
								run_lock_held: true,
								session_user: 'dbsp',
								current_user: 'dbsp',
								standard_conforming_strings: 'on',
								search_path: 'public',
								client_encoding: 'UTF8',
								time_zone: 'Etc/UTC',
							},
						],
					};
				}
				if (sql.includes('pg_advisory_unlock'))
					return { rows: [{ unlocked: true }] };
				return { rows: [] };
			}),
			release: vi.fn(() => {
				throw new Error('pool release failed');
			}),
		};
		const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

		await expect(
			withPgTransitionRunLock(pool, 'run:throwing-release', async () => ({
				kind: 'recovery-required' as const,
				claimId: 'open-claim',
			})),
		).resolves.toEqual({
			kind: 'acquired',
			value: { kind: 'recovery-required', claimId: 'open-claim' },
		});
	});

	it('preserves the primary result and skips unlock after the locked backend dies', async () => {
		const dead = Object.assign(
			new Error(
				'Client has encountered a connection error and is not queryable',
			),
			{ code: '57P01' },
		);
		let unlockAttempts = 0;
		const client = {
			query: vi.fn(async (sql: string) => {
				if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
				if (sql === 'SHOW client_encoding')
					return { rows: [{ client_encoding: 'UTF8' }] };
				if (sql.includes('pg_try_advisory_lock'))
					return { rows: [{ locked: true }] };
				if (sql.includes('FROM pg_catalog.pg_locks')) {
					return {
						rows: [
							{
								run_lock_held: true,
								session_user: 'dbsp',
								current_user: 'dbsp',
								standard_conforming_strings: 'on',
								search_path: 'public',
								client_encoding: 'UTF8',
								time_zone: 'Etc/UTC',
							},
						],
					};
				}
				if (sql === 'SELECT force_backend_death') throw dead;
				if (sql.includes('pg_advisory_unlock')) {
					unlockAttempts += 1;
					return { rows: [{ unlocked: true }] };
				}
				return { rows: [] };
			}),
			release: vi.fn(),
		};
		const pool = {
			connect: vi.fn(async () => client),
		} as unknown as Pool;

		await expect(
			withPgTransitionRunLock(pool, 'run:dead-backend', async (target) => {
				const lease = await acquireExclusiveTransitionLease(target);
				try {
					await planOperationSession(lease.session).query(
						'SELECT force_backend_death',
					);
				} catch (error) {
					expect(error).toBe(dead);
					return { kind: 'outcome-recovery-required' as const };
				} finally {
					await lease.release();
				}
			}),
		).resolves.toEqual({
			kind: 'acquired',
			value: { kind: 'outcome-recovery-required' },
		});
		expect(unlockAttempts).toBe(0);
		expect(client.release).toHaveBeenCalledWith(dead);
	});

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
	])(
		'mutation: returning the lock-owning client after pg_advisory_unlock $name lets the pool hand out a live lock',
		async ({ unlock }) => {
			const first = {
				query: vi.fn(async (sql: string) => {
					if (sql === 'SHOW client_encoding')
						return { rows: [{ client_encoding: 'UTF8' }] };
					if (sql.includes('pg_try_advisory_lock'))
						return { rows: [{ locked: true }] };
					if (sql.includes('FROM pg_catalog.pg_locks'))
						return {
							rows: [
								{
									run_lock_held: true,
									session_user: 'dbsp',
									current_user: 'dbsp',
									standard_conforming_strings: 'on',
									search_path: '"$user", public',
									client_encoding: 'UTF8',
									time_zone: 'Etc/UTC',
								},
							],
						};
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
		},
	);
});

describe('withPgTransitionRunLock statement origin', () => {
	function lockedPool() {
		let lockHeld = true;
		let encoding = 'UTF8';
		const sessionUser = 'dbsp';
		let currentUser = 'dbsp';
		let standardConformingStrings = 'on';
		const searchPath = '"$user", public';
		const timeZone = 'Etc/UTC';
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
						rows: [
							{
								run_lock_held: lockHeld,
								session_user: sessionUser,
								current_user: currentUser,
								standard_conforming_strings: standardConformingStrings,
								search_path: searchPath,
								client_encoding: encoding,
								time_zone: timeZone,
							},
						],
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
				if (sql === "SET client_encoding TO 'LATIN1'") {
					encoding = 'LATIN1';
					return { rows: [] };
				}
				if (sql === 'SET ROLE dbsp_member') {
					currentUser = 'dbsp_member';
					return { rows: [] };
				}
				if (sql === "SET standard_conforming_strings TO 'off'") {
					standardConformingStrings = 'off';
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

	it('does not send an in-flight plan operation post-probe after a sibling lease failure', async () => {
		const { client, pool } = lockedPool();
		const originalQuery = client.query.getMockImplementation()!;
		let invariantProbeCount = 0;
		let operationStarted: () => void;
		const started = new Promise<void>((resolve) => {
			operationStarted = resolve;
		});
		let finishOperation: () => void;
		const operationFinished = new Promise<{ rows: [] }>((resolve) => {
			finishOperation = () => resolve({ rows: [] });
		});
		client.query.mockImplementation(async (sql: string) => {
			if (sql.includes('FROM pg_catalog.pg_locks')) invariantProbeCount += 1;
			if (sql === 'SELECT suspended plan operation') {
				operationStarted();
				return operationFinished;
			}
			return originalQuery(sql);
		});

		await withPgTransitionRunLock(
			pool,
			'run:in-flight-post-probe',
			async (target) => {
				const operationLease = await acquireExclusiveTransitionLease(target);
				const siblingLease = await acquireExclusiveTransitionLease(target);
				try {
					const operation = planOperationSession(operationLease.session).query(
						'SELECT suspended plan operation',
					);
					await started;
					await siblingLease.release({
						error: new Error('sibling lease failed'),
					});
					finishOperation();
					await expect(operation).rejects.toThrow(
						'PostgreSQL transition session is compromised after a lease release failure',
					);
				} finally {
					await operationLease.release();
				}
				return undefined;
			},
		);

		expect(invariantProbeCount).toBe(2);
	});

	it('mutation: a plan operation issuing pg_advisory_unlock_all is refused and its connection is destroyed', async () => {
		const { client, pool } = lockedPool();
		let failure: unknown;

		await expect(
			withPgTransitionRunLock(pool, 'run:plan-unlock', async (target) => {
				const lease = await acquireExclusiveTransitionLease(target);
				try {
					await planOperationSession(lease.session).query(
						'SELECT pg_catalog.pg_advisory_unlock_all()',
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
			'durable plan operation may not release the run lock, change effective authority, or change execution-contract session settings',
		);
		expect(client.release).toHaveBeenCalledWith(expect.any(Error));
	});

	it('mutation: a plan operation issuing SET ROLE to a member role is refused and its connection is destroyed', async () => {
		const { client, pool } = lockedPool();
		let failure: unknown;

		await withPgTransitionRunLock(pool, 'run:plan-role', async (target) => {
			const lease = await acquireExclusiveTransitionLease(target);
			try {
				await planOperationSession(lease.session).query('SET ROLE dbsp_member');
			} catch (error) {
				failure = error;
			} finally {
				await lease.release();
			}
			return undefined;
		});

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe(
			'durable plan operation may not release the run lock, change effective authority, or change execution-contract session settings',
		);
		expect(client.release).toHaveBeenCalledWith(expect.any(Error));
	});

	it('mutation: a plan operation SET on a contract-declared setting is refused and its connection is destroyed', async () => {
		const { client, pool } = lockedPool();
		let failure: unknown;

		await withPgTransitionRunLock(pool, 'run:plan-encoding', async (target) => {
			const lease = await acquireExclusiveTransitionLease(target);
			try {
				await planOperationSession(lease.session).query(
					"SET standard_conforming_strings TO 'off'",
				);
			} catch (error) {
				failure = error;
			} finally {
				await lease.release();
			}
			return undefined;
		});

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe(
			'durable plan operation may not release the run lock, change effective authority, or change execution-contract session settings',
		);
		expect(client.release).toHaveBeenCalledWith(expect.any(Error));
	});

	it.each(["SET NAMES 'LATIN1'", "SET client_encoding TO 'LATIN1'"])(
		'mutation: a plan operation using %s violates the encoding invariant and closes the run',
		async (statement) => {
			const { client, pool } = lockedPool();
			let failure: unknown;

			await withPgTransitionRunLock(
				pool,
				'run:plan-encoding-spelling',
				async (target) => {
					const lease = await acquireExclusiveTransitionLease(target);
					try {
						await planOperationSession(lease.session).query(statement);
					} catch (error) {
						failure = error;
					} finally {
						await lease.release();
					}
					return undefined;
				},
			);

			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toBe(
				'durable plan operation may not release the run lock, change effective authority, or change execution-contract session settings',
			);
			expect(client.release).toHaveBeenCalledWith(expect.any(Error));
		},
	);

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
						'durable plan operation may not release the run lock, change effective authority, or change execution-contract session settings',
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
