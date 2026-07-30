import { Client, Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createPgTransitionLessor } from './lessor.js';

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
