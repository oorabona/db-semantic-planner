import { describe, expect, it, vi } from 'vitest';
import {
	acquireTransitionLease,
	createTransitionLessor,
	isTransitionLessor,
	type TransitionLease,
} from './transition-lessor.js';

describe('transition lessors', () => {
	it('mints a frozen, nominal lessor', async () => {
		const acquire = vi.fn(async () => ({
			query: async () => ({ rows: [] }),
			release: vi.fn(),
		}));
		const lessor = createTransitionLessor(acquire);

		expect(Object.isFrozen(lessor)).toBe(true);
		expect(isTransitionLessor(lessor)).toBe(true);
		await lessor.acquire();
		expect(acquire).toHaveBeenCalledOnce();
	});

	it('rejects a foreign protocol version even when it carries the global brand', () => {
		const foreign = { acquire: vi.fn() };
		Object.defineProperty(foreign, Symbol.for('dbsp.transition.lessor'), {
			value: { protocolVersion: 2 },
		});

		expect(isTransitionLessor(foreign)).toBe(false);
	});

	it('checks every acquisition from a forged declared lessor and hides release', async () => {
		const forged = {
			acquire: vi.fn(async () => ({ query: vi.fn() })),
		};
		Object.defineProperty(forged, Symbol.for('dbsp.transition.lessor'), {
			value: { protocolVersion: 1 },
		});

		await expect(acquireTransitionLease(forged as never)).rejects.toThrow(
			'must acquire a lease exposing query() and release()',
		);

		const raw = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
		forged.acquire.mockResolvedValue(raw);
		const lease = await acquireTransitionLease(forged as never);
		expect(Object.isFrozen(lease)).toBe(true);
		expect(Object.isFrozen(lease.session)).toBe(true);
		expect('release' in lease.session).toBe(false);
		await lease.session.query('SELECT 1');
		expect(raw.query).toHaveBeenCalledWith('SELECT 1', undefined);
	});

	it.each([
		['neither member', {}],
		['no release', { query: vi.fn() }],
		['no query', { release: vi.fn() }],
		['not an object', 'connected'],
	])('refuses an acquisition returning %s', async (_label, acquired) => {
		const lessor = createTransitionLessor(async () => acquired as never);

		await expect(acquireTransitionLease(lessor)).rejects.toThrow(
			'must acquire a lease exposing query() and release()',
		);
	});

	it('gives back what a rejected acquisition can still give back', async () => {
		// The rejection never reaches a caller, so no finally upstream can recover
		// this lease. Repeated in a loop, a malformed acquisition would otherwise
		// drain the pool it came from.
		const release = vi.fn();
		const lessor = createTransitionLessor(async () => ({ release }) as never);

		await expect(acquireTransitionLease(lessor)).rejects.toThrow(
			'must acquire a lease exposing query() and release()',
		);
		expect(release).toHaveBeenCalledOnce();
		expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
	});

	it('still reports the malformed acquisition when giving it back fails', async () => {
		const lessor = createTransitionLessor(
			async () =>
				({
					release: () => {
						throw new Error('already destroyed');
					},
				}) as never,
		);

		await expect(acquireTransitionLease(lessor)).rejects.toThrow(
			'must acquire a lease exposing query() and release()',
		);
	});

	it('rejects a throwing query getter and returns the recoverable lease once', async () => {
		const release = vi.fn();
		let queryReads = 0;
		let releaseReads = 0;
		const acquisition = {};
		Object.defineProperties(acquisition, {
			query: {
				get: () => {
					queryReads += 1;
					throw new Error('query getter failed');
				},
			},
			release: {
				get: () => {
					releaseReads += 1;
					return release;
				},
			},
		});
		const lessor = createTransitionLessor(async () => acquisition as never);

		await expect(acquireTransitionLease(lessor)).rejects.toThrow(
			'must acquire a lease exposing query() and release()',
		);
		expect(queryReads).toBe(1);
		expect(releaseReads).toBe(1);
		expect(release).toHaveBeenCalledOnce();
		expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
	});

	it('rejects a throwing release getter without exposing its error', async () => {
		let queryReads = 0;
		let releaseReads = 0;
		const acquisition = {};
		Object.defineProperties(acquisition, {
			query: {
				get: () => {
					queryReads += 1;
					return vi.fn();
				},
			},
			release: {
				get: () => {
					releaseReads += 1;
					throw new Error('release getter failed');
				},
			},
		});
		const lessor = createTransitionLessor(async () => acquisition as never);

		await expect(acquireTransitionLease(lessor)).rejects.toThrow(
			'must acquire a lease exposing query() and release()',
		);
		expect(queryReads).toBe(1);
		expect(releaseReads).toBe(1);
	});

	it('captures the way back before reading any other member', async () => {
		const release = vi.fn();
		const reads: string[] = [];
		const acquisition = {};
		Object.defineProperties(acquisition, {
			query: {
				get: () => {
					reads.push('query');
					// A getter is caller code. This one removes the only way to give
					// the lease back — which only fails if it is read first.
					Reflect.deleteProperty(acquisition, 'release');
					return undefined;
				},
			},
			release: {
				configurable: true,
				get: () => {
					reads.push('release');
					return release;
				},
			},
		});
		const lessor = createTransitionLessor(async () => acquisition as never);

		await expect(acquireTransitionLease(lessor)).rejects.toThrow(
			'must acquire a lease exposing query() and release()',
		);
		expect(reads).toEqual(['release', 'query']);
		expect(release).toHaveBeenCalledOnce();
	});

	it('captures a stateful acquisition once at the runtime boundary', async () => {
		const release = vi.fn();
		const query = vi.fn(async () => ({ rows: [] }));
		let releaseReads = 0;
		const acquisition = {};
		Object.defineProperties(acquisition, {
			query: { get: () => query },
			release: {
				get: () => {
					releaseReads += 1;
					if (releaseReads === 1) {
						return release;
					}
					throw new Error('release getter read twice');
				},
			},
		});
		const lessor = createTransitionLessor(async () => acquisition as never);

		const lease = await acquireTransitionLease(lessor);
		await lease.session.query('SELECT 1');
		await lease.release();

		expect(releaseReads).toBe(1);
		expect(query).toHaveBeenCalledWith('SELECT 1', undefined);
		expect(release).toHaveBeenCalledWith();
	});
});

describe('transition lease release', () => {
	it('rejects queries after the lease was given back without calling the client', async () => {
		const query = vi.fn(async () => ({ rows: [] }));
		const lease = await acquireTransitionLease(
			createTransitionLessor(async () => ({ query, release: vi.fn() })),
		);

		await lease.release();

		await expect(lease.session.query('SELECT 1')).rejects.toThrow(
			'lease was already given back',
		);
		expect(query).not.toHaveBeenCalled();
	});

	it('closes the query capability before calling release', async () => {
		const query = vi.fn(async () => ({ rows: [] }));
		let lease: Awaited<ReturnType<typeof acquireTransitionLease>>;
		let queryDuringRelease: Promise<unknown> | undefined;
		const release = vi.fn(() => {
			queryDuringRelease = lease.session.query('SELECT 1');
		});
		lease = await acquireTransitionLease(
			createTransitionLessor(async () => ({ query, release })),
		);

		await lease.release();

		await expect(queryDuringRelease).rejects.toThrow(
			'lease was already given back',
		);
		expect(query).not.toHaveBeenCalled();
	});

	it('calls release only once when it is called twice', async () => {
		const release = vi.fn();
		const lease = await acquireTransitionLease(
			createTransitionLessor(async () => ({ query: vi.fn(), release })),
		);

		await lease.release();
		await lease.release();

		expect(release).toHaveBeenCalledOnce();
	});

	it('calls a throwing release only once when it is called twice', async () => {
		const release = vi.fn(() => {
			throw new Error('connection already destroyed');
		});
		const lease = await acquireTransitionLease(
			createTransitionLessor(async () => ({ query: vi.fn(), release })),
		);

		await expect(lease.release()).resolves.toBeUndefined();
		await expect(lease.release()).resolves.toBeUndefined();
		expect(release).toHaveBeenCalledOnce();
	});

	it('calls release only once when the driver releases from its own release', async () => {
		let lease: TransitionLease | undefined;
		// The driver gives the connection back from inside its own release
		// callback, so the second call arrives before the first one returned.
		const release = vi.fn(() => {
			void lease?.release();
		});
		lease = await acquireTransitionLease(
			createTransitionLessor(async () => ({ query: vi.fn(), release })),
		);

		await lease.release();

		expect(release).toHaveBeenCalledOnce();
	});

	it('settles when the driver hands back the release it was given', async () => {
		// Handing back the promise it was just given satisfies the void-declared
		// contract. Answering a second release with the one already in flight
		// would make that release wait on itself; answering with a settled promise
		// is what keeps it from hanging every consumer's cleanup.
		let lease: TransitionLease | undefined;
		const release = vi.fn(() => lease?.release());
		lease = await acquireTransitionLease(
			createTransitionLessor(async () => ({
				query: vi.fn(),
				release: release as never,
			})),
		);

		await expect(
			Promise.race([
				lease.release().then(() => 'settled'),
				new Promise((resolve) => setTimeout(() => resolve('hung'), 50)),
			]),
		).resolves.toBe('settled');
		expect(release).toHaveBeenCalledOnce();
	});

	it('keeps the first release failure when later releases disagree', async () => {
		const release = vi.fn();
		const firstError = new Error('first failure');
		const laterError = new Error('later failure');
		const lease = await acquireTransitionLease(
			createTransitionLessor(async () => ({ query: vi.fn(), release })),
		);

		await lease.release({ error: firstError });
		await lease.release({ error: laterError });

		expect(release).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledWith(firstError);
	});

	it('reports the failure to release() when one is given', async () => {
		const release = vi.fn();
		const error = new Error('step failed');
		const lease = await acquireTransitionLease(
			createTransitionLessor(async () => ({ query: vi.fn(), release })),
		);

		await lease.release({ error });

		expect(release).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledWith(error);
	});

	it.each([
		['undefined', undefined],
		['null', null],
		['an empty string', ''],
		['zero', 0],
		['false', false],
	])('carries a failure of %s in a truthy error so the session is destroyed', async (_label, thrown) => {
		// pg decides between destroying a session and pooling it by testing this
		// argument for truthiness, not for presence. A falsy value released as-is
		// returns a poisoned session to the pool for reuse.
		const release = vi.fn();
		const lease = await acquireTransitionLease(
			createTransitionLessor(async () => ({ query: vi.fn(), release })),
		);

		await lease.release({ error: thrown });

		const [argument] = release.mock.calls[0] ?? [];
		expect(release).toHaveBeenCalledOnce();
		expect(argument).toBeTruthy();
		expect(argument).toBeInstanceOf(Error);
		expect((argument as Error).cause).toBe(thrown);
	});

	it('releases without an argument when there is no failure', async () => {
		const release = vi.fn();
		const lease = await acquireTransitionLease(
			createTransitionLessor(async () => ({ query: vi.fn(), release })),
		);

		await lease.release();

		expect(release).toHaveBeenCalledWith();
	});

	it('settles even when the driver returns a promise that never does', async () => {
		// A release() declared to return void is called for its effect. Awaiting
		// whatever it hands back instead would let a driver hold the engine's
		// cleanup open for as long as it likes.
		const release = vi.fn(() => new Promise<void>(() => undefined));
		const lease = await acquireTransitionLease(
			createTransitionLessor(async () => ({
				query: vi.fn(),
				release: release as never,
			})),
		);

		await expect(
			Promise.race([
				lease.release().then(() => 'settled'),
				new Promise((resolve) => setTimeout(() => resolve('hung'), 50)),
			]),
		).resolves.toBe('settled');
		expect(release).toHaveBeenCalledOnce();
	});

	it('contains a rejecting async release instead of awaiting it', async () => {
		// release() is declared void-returning, which TypeScript lets an async
		// implementation satisfy. Such a rejection must not escape the caller's
		// try/finally as an unhandled rejection — but containing it is what does
		// that, not awaiting it: the engine's outcome does not wait on cleanup.
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			const release = vi.fn(async () => {
				await Promise.resolve();
				throw new Error('connection already destroyed');
			});
			const lease = await acquireTransitionLease(
				createTransitionLessor(async () => ({
					query: vi.fn(),
					release: release as never,
				})),
			);

			await expect(lease.release()).resolves.toBeUndefined();
			// Let the rejection reach whatever handler it has, or none.
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(unhandled).toEqual([]);
			expect(release).toHaveBeenCalledOnce();
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});
});
