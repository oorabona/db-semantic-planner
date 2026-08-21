import { createHash } from 'node:crypto';
import {
	createExclusiveTransitionTarget,
	createTransitionLessor,
} from '@dbsp/core';
import type {
	ExclusiveTransitionTarget,
	TransitionLessor,
	TransitionQueryClient,
} from '@dbsp/types';
import type { Pool, PoolClient } from 'pg';
import { classifyPgWrite } from './database-writability.js';

export type PgTransitionRunLockResult<T> =
	| { readonly kind: 'acquired'; readonly value: T }
	| { readonly kind: 'busy' };

export type PgTransitionClientLease = {
	readonly client: PoolClient;
	query(
		sql: string,
		params?: unknown,
	): Promise<{
		readonly rows: readonly Record<string, unknown>[];
	}>;
	release(error?: unknown): void;
};

/**
 * The whole state set which a plan operation is never allowed to change.
 *
 * Keep this closed and named here. These settings are the complete PostgreSQL
 * execution-contract vocabulary, including the provenance-only clauses: plan
 * SQL must not be able to turn either its rendering prerequisites or its
 * reviewed session provenance into a different execution environment.
 */
const DURABLE_PLAN_OPERATION_INVARIANT_SETTINGS = [
	{
		setting: 'standard_conforming_strings',
		column: 'standard_conforming_strings',
	},
	{ setting: 'search_path', column: 'search_path' },
	{ setting: 'client_encoding', column: 'client_encoding' },
	{ setting: 'TimeZone', column: 'time_zone' },
] as const;

type DurablePlanOperationInvariantSnapshot = {
	readonly sessionUser: string;
	readonly currentUser: string;
	readonly settings: Readonly<
		Record<
			(typeof DURABLE_PLAN_OPERATION_INVARIANT_SETTINGS)[number]['column'],
			string
		>
	>;
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
		return Object.freeze({
			query: lease.query,
			release: lease.release,
		});
	});
}

/**
 * Acquire a configured PostgreSQL transition client.
 *
 * Callers that use the native adapter must pass this checked-out client with
 * `borrowedClient: true` and return it through `release()` when finished.
 */
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

/**
 * Hold a session advisory lock on the same checked-out session used for every
 * transition segment.  `pg_try_advisory_lock` makes contention an explicit
 * `busy` result rather than a hidden queue; releasing the client also releases
 * the lock if an unlock attempt itself fails.
 */
export async function withPgTransitionRunLock<T>(
	pool: Pool,
	runId: string,
	callback: (target: ExclusiveTransitionTarget) => Promise<T>,
): Promise<PgTransitionRunLockResult<T>> {
	const client = await pool.connect();
	const key = advisoryKey(runId);
	let locked = false;
	let bodyFailed = false;
	let cleanupFailure: Error | undefined;
	let deadConnectionFailure: Error | undefined;
	let value: T | undefined;
	let callbackLive = false;
	let planOperationViolatedInvariant = false;
	let leaseReleaseFailure: Error | undefined;
	const refuseAfterLeaseReleaseFailure = () => {
		if (!leaseReleaseFailure) return;
		throw new Error(
			`PostgreSQL transition session is compromised after a lease release failure: ${leaseReleaseFailure.message}`,
			{ cause: leaseReleaseFailure },
		);
	};
	const query = async (sql: string, params?: unknown) => {
		refuseAfterLeaseReleaseFailure();
		try {
			return (await client.query(sql, params as never)) as {
				readonly rows: readonly Record<string, unknown>[];
			};
		} catch (error) {
			if (isDeadPgConnectionError(error))
				deadConnectionFailure = asError(error);
			throw error;
		}
	};
	try {
		await configurePgUtf8({ query });
		const result = await query(
			'SELECT pg_catalog.pg_try_advisory_lock($1::bigint) AS locked',
			[key.toString()],
		);
		if (result.rows[0]?.locked !== true) return { kind: 'busy' };
		locked = true;
		const invariants = await captureDurablePlanOperationInvariants(client, key);
		const lessor = createTransitionLessor(async () => {
			refuseAfterLeaseReleaseFailure();
			return {
				// This channel is adapter-owned infrastructure: execution-contract
				// setup, authorization, journals, and lock cleanup are not plan SQL.
				query: (sql: string, params?: unknown) => query(sql, params),
				// Core only selects this channel for executeOperation().  Guarding
				// the origin rather than parsing SQL means every spelling reaches the
				// same invariant check, while our own SET/SHOW contract clauses do not.
				queryPlanOperation: async (sql: string, params?: unknown) => {
					refuseAfterLeaseReleaseFailure();
					try {
						await assertDurablePlanOperationInvariants(client, key, invariants);
					} catch (error) {
						// A failed check at either boundary makes this session unsafe to
						// pool, even if the final unlock happens to succeed.
						planOperationViolatedInvariant = true;
						throw error;
					}
					let result:
						| {
								readonly rows: readonly Record<string, unknown>[];
						  }
						| undefined;
					let queryFailure: unknown;
					try {
						result = await classifyPgWrite(() => query(sql, params));
					} catch (error) {
						queryFailure = error;
					}
					try {
						await assertDurablePlanOperationInvariants(client, key, invariants);
					} catch (error) {
						planOperationViolatedInvariant = true;
						throw error;
					}
					if (queryFailure) throw queryFailure;
					return result as {
						readonly rows: readonly Record<string, unknown>[];
					};
				},
				// Segment cleanup must not give back the session that owns the run lock.
				release: (error?: unknown) => {
					if (error)
						leaseReleaseFailure =
							error instanceof Error
								? error
								: new Error('transition lease reported a non-Error failure', {
										cause: error,
									});
				},
			} as TransitionQueryClient;
		});
		callbackLive = true;
		const target = createExclusiveTransitionTarget(lessor, () => callbackLive);
		value = await callback(target);
	} catch (error) {
		bodyFailed = true;
		throw error;
	} finally {
		callbackLive = false;
		// A dead backend has already released its session advisory locks, and a
		// compromised lease receives no more queries. Asking either client to unlock
		// would only mask the callback's primary outcome.
		if (locked && !deadConnectionFailure && !leaseReleaseFailure) {
			try {
				const unlock = await query(
					'SELECT pg_catalog.pg_advisory_unlock($1::bigint) AS unlocked',
					[key.toString()],
				);
				if (unlock.rows[0]?.unlocked !== true)
					cleanupFailure = new Error(
						'PostgreSQL transition run lock cleanup failed: pg_advisory_unlock did not confirm ownership',
					);
			} catch (error) {
				if (!isDeadPgConnectionError(error))
					cleanupFailure = new Error(
						`PostgreSQL transition run lock cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
					);
			}
		}
		// An unconfirmed unlock may leave a session advisory lock behind. pg-pool
		// destroys a client when release receives a truthy error, which is the only
		// safe cleanup because PostgreSQL releases session locks on disconnect.
		client.release(
			cleanupFailure ??
				deadConnectionFailure ??
				leaseReleaseFailure ??
				(planOperationViolatedInvariant
					? new Error(
							'PostgreSQL transition plan operation violated the exclusive session invariants',
						)
					: undefined),
		);
	}
	if (cleanupFailure && !bodyFailed) throw cleanupFailure;
	return { kind: 'acquired', value: value as T };
}

/** pg-pool only evicts a checked-out client when release receives a truthy error. */
export function isDeadPgConnectionError(error: unknown): boolean {
	if (
		error == null ||
		(typeof error !== 'object' && typeof error !== 'function')
	)
		return false;
	const candidate = error as {
		readonly code?: unknown;
		readonly message?: unknown;
	};
	if (
		candidate.code === '57P01' ||
		candidate.code === '57P02' ||
		candidate.code === '57P03' ||
		candidate.code === 'ECONNRESET' ||
		candidate.code === 'EPIPE' ||
		candidate.code === 'ETIMEDOUT'
	)
		return true;
	return (
		typeof candidate.message === 'string' &&
		/connection (?:terminated|ended|closed|lost)|client has encountered a connection error/iu.test(
			candidate.message,
		)
	);
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * Establish the text encoding before any caller receives a session.  The SHOW
 * is deliberately part of acquisition: SET succeeding is not proof that this
 * backend will encode future database text as UTF-8.
 */
async function configurePgUtf8(client: {
	query(
		sql: string,
		params?: readonly unknown[],
	): Promise<{
		readonly rows: readonly Record<string, unknown>[];
	}>;
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
 * Assert the properties owned by the exclusive durable session.  This is a
 * state check, not a SQL recognizer: alternative spelling, comments, compound
 * statements, and future PostgreSQL syntax all get the same answer.
 */
async function captureDurablePlanOperationInvariants(
	client: PoolClient,
	key: bigint,
): Promise<DurablePlanOperationInvariantSnapshot> {
	const row = await readDurablePlanOperationInvariants(client, key);
	if (row.runLockHeld !== true) {
		throw new Error(
			'PostgreSQL transition run lock was not held while capturing durable plan operation invariants',
		);
	}
	return {
		sessionUser: row.sessionUser,
		currentUser: row.currentUser,
		settings: row.settings,
	};
}

async function assertDurablePlanOperationInvariants(
	client: PoolClient,
	key: bigint,
	expected: DurablePlanOperationInvariantSnapshot,
): Promise<void> {
	const row = await readDurablePlanOperationInvariants(client, key);
	if (
		row.runLockHeld !== true ||
		row.sessionUser !== expected.sessionUser ||
		row.currentUser !== expected.currentUser ||
		DURABLE_PLAN_OPERATION_INVARIANT_SETTINGS.some(
			({ column }) => row.settings[column] !== expected.settings[column],
		)
	) {
		throw new Error(
			'durable plan operation may not release the run lock, change effective authority, or change execution-contract session settings',
		);
	}
}

async function readDurablePlanOperationInvariants(
	client: PoolClient,
	key: bigint,
): Promise<{
	readonly runLockHeld: boolean;
	readonly sessionUser: string;
	readonly currentUser: string;
	readonly settings: DurablePlanOperationInvariantSnapshot['settings'];
}> {
	const { classId, objectId } = advisoryLockIds(key);
	const settingColumns = DURABLE_PLAN_OPERATION_INVARIANT_SETTINGS.map(
		({ setting, column }) => `current_setting('${setting}') AS ${column}`,
	).join(',\n\t\t\t\t');
	const row = (
		await client.query(
			`SELECT
				EXISTS (
					SELECT 1
					FROM pg_catalog.pg_locks
					WHERE locktype = 'advisory'
						AND pid = pg_backend_pid()
						AND classid = $1::oid
						AND objid = $2::oid
						AND objsubid = 1
						AND granted
				) AS run_lock_held,
				session_user::text AS session_user,
				current_user::text AS current_user,
				${settingColumns}`,
			[classId, objectId],
		)
	).rows[0];
	const settings = Object.fromEntries(
		DURABLE_PLAN_OPERATION_INVARIANT_SETTINGS.map(({ column }) => [
			column,
			readDurablePlanOperationInvariantString(row, column),
		]),
	) as DurablePlanOperationInvariantSnapshot['settings'];
	return {
		runLockHeld: row?.run_lock_held === true,
		sessionUser: readDurablePlanOperationInvariantString(row, 'session_user'),
		currentUser: readDurablePlanOperationInvariantString(row, 'current_user'),
		settings,
	};
}

function readDurablePlanOperationInvariantString(
	row: Record<string, unknown> | undefined,
	column: string,
): string {
	const value = row?.[column];
	if (typeof value !== 'string')
		throw new Error(
			`PostgreSQL transition run invariant probe returned no string ${column}`,
		);
	return value;
}

function advisoryLockIds(key: bigint): {
	readonly classId: number;
	readonly objectId: number;
} {
	const unsigned = BigInt.asUintN(64, key);
	return {
		classId: Number((unsigned >> 32n) & 0xffff_ffffn),
		objectId: Number(unsigned & 0xffff_ffffn),
	};
}

function advisoryKey(runId: string): bigint {
	const bytes = createHash('sha256')
		.update('dbsp.transition.run.v1:\0')
		.update(runId)
		.digest();
	return bytes.readBigInt64BE(0);
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
