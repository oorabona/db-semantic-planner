import { createTransitionLessor } from '@dbsp/core';
import type { TransitionLessor } from '@dbsp/types';
import type { Pool, PoolClient } from 'pg';

export type PgTransitionClientLease = {
	readonly client: PoolClient;
	query(
		sql: string,
		params?: unknown,
	): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
	release(error?: unknown): void;
};

/**
 * Declare a pg Pool as a source of transition leases.
 *
 * The typed Pool argument and this explicit factory call are the declaration.
 * Neither check below infers ownership; each rejects a declaration that
 * contradicts itself.
 *
 * A pg Pool and a pg Client are structurally identical — both expose connect(),
 * query() and end(), and neither exposes release() — so the argument cannot be
 * classified on sight. What connect() returns can be: a Pool leases a
 * PoolClient, which carries release(); a Client resolves to itself, which does
 * not. The lease is therefore checked at the first acquisition, which costs one
 * connection to learn and is why the constructor cannot report it.
 *
 * This deliberately avoids `instanceof Client`, which would be sound but
 * requires importing pg at runtime. Nothing else in this package does, so the
 * compiler and the SQL renderer work without a driver, and one guard is not
 * worth spending that.
 */
export function createPgTransitionLessor(pool: Pool): TransitionLessor {
	if (
		pool != null &&
		(typeof pool === 'object' || typeof pool === 'function') &&
		typeof (pool as { readonly release?: unknown }).release === 'function'
	) {
		throw new Error(
			'createPgTransitionLessor received a checked-out pg PoolClient. ' +
				'A transition owns its lease from acquisition to release, so it needs a ' +
				'pool to lease from; there is no borrowed-client mode here. Pass the pg ' +
				'Pool the client was checked out of.',
		);
	}
	return createTransitionLessor(async () => {
		const lease = await acquirePgTransitionClient(pool);
		return Object.freeze({ query: lease.query, release: lease.release });
	});
}

/** Acquire a UTF-8-configured PostgreSQL client for direct planning paths. */
export async function acquirePgTransitionClient(
	pool: Pool,
): Promise<PgTransitionClientLease> {
	const client = await pool.connect();
	// Capture the way to close this connection before reading the member that
	// decides whether it must be closed, so a getter cannot remove the only
	// cleanup left on the very path that needs it.
	const end = readMember(client, 'end');
	const release = readMember(client, 'release');
	const query = readMember(client, 'query');
	if (typeof release !== 'function' || typeof query !== 'function') {
		if (typeof release === 'function') {
			const rejection = new Error(
				'createPgTransitionLessor acquired a malformed pg lease without query(); ' +
					'it was returned through its captured release().',
			);
			try {
				// Contained rather than awaited: pg's release() returns nothing, and
				// a promise handed back against that contract only needs a handler
				// in this turn so it cannot surface unhandled. The last-resort
				// close below follows the same policy, for the same reason.
				void Promise.resolve(release.call(client, rejection)).catch(
					() => undefined,
				);
			} catch {
				// Reporting the malformed acquisition matters more than this cleanup.
			}
			throw rejection;
		}
		// connect() opened a value with no callable release path, so end() is the
		// remaining cleanup route. Leaving it open leaks a socket on every repeat.
		endLeakedConnection(client, end);
		throw new Error(
			'createPgTransitionLessor was given a pg Client rather than a pg Pool: ' +
				'connect() returned the connection itself without release(), so no ' +
				'acquired lease could be returned. Pass a pg Pool.',
		);
	}
	try {
		await configurePgUtf8({
			query: (sql, params) => query.call(client, sql, params),
		});
	} catch (error) {
		try {
			release.call(
				client,
				error instanceof Error ? error : new Error(String(error)),
			);
		} catch {
			// The UTF-8 acquisition failure remains the useful result.
		}
		throw error;
	}
	return Object.freeze({
		client,
		query: (sql: string, params?: unknown) => query.call(client, sql, params),
		release: (error?: unknown) => release.call(client, error),
	});
}

async function configurePgUtf8(client: {
	query(
		sql: string,
		params?: readonly unknown[],
	): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}): Promise<void> {
	await client.query("SET client_encoding TO 'UTF8'");
	const value = String(
		(await client.query('SHOW client_encoding')).rows[0]?.client_encoding ?? '',
	);
	if (value !== 'UTF8')
		throw new Error(
			`PostgreSQL client_encoding expected "UTF8", observed ${JSON.stringify(value || 'no value')}`,
		);
}

/**
 * Close a connection opened by a failed acquisition, best effort. The failure
 * being reported is the caller's mistake; a cleanup failure on top of it must
 * not replace that message with a less useful one.
 *
 * Started, not awaited, on the same policy as every other cleanup here. Waiting
 * would hand an unbounded delay to the thing that already misbehaved: a broken
 * socket, or an `end()` that simply never settles, would hold `acquire()` open
 * forever instead of reporting the caller's mistake. Nothing reads the outcome
 * either way, so waiting for it buys nothing it could act on.
 */
function endLeakedConnection(client: unknown, end: unknown): void {
	if (typeof end !== 'function') {
		return;
	}
	try {
		void Promise.resolve(end.call(client)).catch(() => undefined);
	} catch {
		// Reporting the caller's mistake matters more than this cleanup.
	}
}

/**
 * Read one member, treating a member that throws on read as absent.
 *
 * Inspecting a connection this factory just opened must not throw past the only
 * code that can close it — the leak this guard exists to prevent would then
 * happen on the guard's own path.
 */
function readMember(
	value: unknown,
	member: 'release' | 'end' | 'query',
): unknown {
	if (
		value == null ||
		(typeof value !== 'object' && typeof value !== 'function')
	) {
		return undefined;
	}
	try {
		return (value as Record<string, unknown>)[member];
	} catch {
		return undefined;
	}
}
