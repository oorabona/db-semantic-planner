import type {
	ExclusiveTransitionTarget,
	PlanAssessment,
	SemanticArtifactRef,
	TransitionLessor,
	TransitionQueryClient,
	TransitionSessionClient,
} from '@dbsp/types';

const TRANSITION_LESSOR_BRAND = Symbol.for('dbsp.transition.lessor');
const TRANSITION_LESSOR_PROTOCOL_VERSION = 1;
export const TRANSITION_LESSOR_REJECTION =
	'transition target must be a core-minted lessor';

type LessorBrand = {
	readonly protocolVersion: number;
};

/**
 * Every lease is checked here, once, at the runtime acquisition boundary. The
 * brand says the caller declared a source of leases; this captures the members
 * the engine will use before it relies on that declaration.
 *
 * A rejected acquisition never reaches a caller, so no `finally` upstream can
 * recover it. An acquisition without a usable `query()`/`release()` pair cannot
 * be used; when this boundary captured a callable `release()`, it uses that
 * path before rejecting. Otherwise, an adapter that opened a real connection
 * to acquire must close its own failure before returning, the way
 * createPgTransitionLessor does.
 */
type CapturedLease = {
	readonly raw: unknown;
	readonly query: (...args: readonly unknown[]) => unknown;
	readonly queryPlanOperation:
		| ((...args: readonly unknown[]) => unknown)
		| undefined;
	readonly release: (...args: readonly unknown[]) => unknown;
};

async function captureLease(value: unknown): Promise<CapturedLease> {
	const { query, queryPlanOperation, release } = leaseMembers(value);
	if (typeof query !== 'function' || typeof release !== 'function') {
		const rejection = new Error(
			'A transition lessor must acquire a lease exposing query() and release(). ' +
				'This acquisition returned an unusable member pair.',
		);
		releaseMalformedAcquisition(value, release, rejection);
		throw rejection;
	}
	return {
		raw: value,
		query: query as CapturedLease['query'],
		queryPlanOperation:
			typeof queryPlanOperation === 'function'
				? (queryPlanOperation as NonNullable<
						CapturedLease['queryPlanOperation']
					>)
				: undefined,
		release: release as CapturedLease['release'],
	};
}

/** A core-owned lease: packs receive its session, while core retains release. */
export type TransitionLease = {
	readonly session: TransitionSessionClient;
	readonly release: (failure?: TransitionLeaseFailure) => Promise<void>;
};

const planOperationQueries = new WeakMap<
	object,
	(sql: string, params?: unknown) => Promise<unknown>
>();
const compromisedTransitionSessions = new WeakSet<object>();

/**
 * Outcome code may poison the current lease when a transport or protocol fault
 * leaves its backend unsafe for reuse. The release boundary consumes this bit
 * and returns the client with a truthy error so pg destroys it.
 */
export function markTransitionClientCompromised(
	session: TransitionSessionClient,
): void {
	compromisedTransitionSessions.add(session as object);
}

/**
 * Mint the session passed to an operation's executeOperation() method.
 *
 * The returned client has the same narrow query surface as a normal session,
 * but its provenance is carried by the lease channel selected here, not by
 * recognizing the SQL text.  A pack never receives the unwrapped session.
 */
export function planOperationSession(
	session: TransitionSessionClient,
): TransitionSessionClient {
	const query = planOperationQueries.get(session as object);
	if (!query) return session;
	return Object.freeze({
		query: (sql: string, params?: unknown) => query(sql, params),
	}) as TransitionSessionClient;
}

type ExclusiveTargetState = {
	readonly target: TransitionLessor;
	readonly isLive: () => boolean;
};

const exclusiveTargets = new WeakMap<object, ExclusiveTargetState>();

/**
 * Mint a durable target from an adapter-held exclusive lease.
 *
 * The adapter owns the liveness closure.  Core retains the only lookup table,
 * so a durable caller cannot substitute a generic lessor or retain a target
 * after the adapter callback has finished.
 */
export function createExclusiveTransitionTarget(
	target: TransitionLessor,
	isLive: () => boolean,
): ExclusiveTransitionTarget {
	if (!isTransitionLessor(target)) {
		throw new Error(
			'exclusive transition target requires a core-minted lessor',
		);
	}
	const exclusive = Object.freeze({});
	exclusiveTargets.set(exclusive, { target, isLive });
	return exclusive as ExclusiveTransitionTarget;
}

/** Recognize a core-minted exclusive durable target. */
export function isExclusiveTransitionTarget(
	value: unknown,
): value is ExclusiveTransitionTarget {
	return (
		value != null &&
		(typeof value === 'object' || typeof value === 'function') &&
		exclusiveTargets.has(value as object)
	);
}

/** Acquire the callback-live lease underlying a durable execution target. */
export async function acquireExclusiveTransitionLease(
	target: ExclusiveTransitionTarget,
): Promise<TransitionLease> {
	const state = exclusiveTargets.get(target as object);
	if (!state?.isLive()) {
		throw new Error(
			'exclusive transition target is only valid while its adapter lock callback is running',
		);
	}
	const lease = await acquireTransitionLease(state.target);
	if (!state.isLive()) {
		await lease.release({
			error: new Error(
				'exclusive transition target ended while acquiring its lease',
			),
		});
		throw new Error(
			'exclusive transition target ended while acquiring its lease',
		);
	}
	return lease;
}

/** A non-executing transition read may use either normal or exclusive access. */
export type TransitionReadTarget = TransitionLessor | ExclusiveTransitionTarget;

export function acquireTransitionTargetLease(
	target: TransitionReadTarget,
): Promise<TransitionLease> {
	return isTransitionLessor(target)
		? acquireTransitionLease(target)
		: acquireExclusiveTransitionLease(target);
}

/**
 * Cross the engine's acquisition boundary.
 *
 * A lessor brand is a declaration, not a security boundary, so every
 * acquisition is checked here even when a caller forged that declaration.
 */
export async function acquireTransitionLease(
	target: TransitionLessor,
): Promise<TransitionLease> {
	const captured = await captureLease(await target.acquire());
	const { raw, query, release } = captured;
	/**
	 * One bit, set before any driver code runs. The driver's `release()` is
	 * called synchronously, so a driver that re-enters — or a consumer who wires
	 * one to — observes this state rather than the state before it.
	 */
	let closed = false;
	const session = Object.freeze({
		query: (sql: string, params?: unknown) => {
			// The connection may already belong to another borrower, so this must
			// not reach the driver. Rejecting rather than throwing keeps the
			// contract a promise for a caller who only attaches a handler.
			if (closed) {
				return Promise.reject(
					new Error('transition lease was already given back'),
				);
			}
			return query.call(raw, sql, params);
		},
	}) as TransitionSessionClient;
	if (captured.queryPlanOperation) {
		planOperationQueries.set(session as object, (sql, params) =>
			Promise.resolve(
				captured.queryPlanOperation?.call(captured.raw, sql, params),
			),
		);
	}
	/**
	 * Give this lease back. pg destroys a session released with an error instead
	 * of pooling it, so the failure is passed through rather than dropped.
	 *
	 * Giving a lease back happens once. A second call is inert and answers with
	 * a settled promise, so the failure the first caller reported is the one pg
	 * sees, and a release that throws still leaves the lease closed. It is
	 * deliberately not answered with the release already in flight: a driver
	 * that hands that promise back as its own return value would make the
	 * release wait on itself, forever, and hang every consumer's cleanup.
	 *
	 * #403: a cleanup failure must not mask the outcome the caller already
	 * holds.
	 *
	 * The engine does not wait for cleanup either. `release` is declared to
	 * return void — pg's returns nothing — but TypeScript lets an implementation
	 * hand back a promise, so one is contained rather than awaited. Containment
	 * is what keeps a rejection from surfacing unhandled after the call that
	 * owned it returned; not awaiting is what keeps a promise the driver
	 * invented outside the contract, and may never settle, from holding the
	 * engine open.
	 */
	const releaseLease = (failure?: TransitionLeaseFailure): Promise<void> => {
		if (closed) {
			return Promise.resolve();
		}
		closed = true;
		try {
			const effectiveFailure =
				failure ??
				(compromisedTransitionSessions.has(session as object)
					? {
							error: new Error(
								'transition execution marked its leased client compromised',
							),
						}
					: undefined);
			const returned: unknown = effectiveFailure
				? release.call(raw, releaseArgument(effectiveFailure))
				: release.call(raw);
			void Promise.resolve(returned).catch(() => undefined);
		} catch {
			// A cleanup failure must not mask the outcome the caller already holds.
		}
		return Promise.resolve();
	};
	return Object.freeze({
		session,
		release: releaseLease,
	});
}

/**
 * Read both members once, treating a member that throws on read as absent.
 *
 * Inspecting the acquisition is itself part of the acquisition boundary: a
 * getter that throws must produce a rejection this function can still clean up
 * after, not an exception thrown past the only code holding the lease. `release`
 * is read first and separately, so a lease whose `query` is what misbehaves can
 * still be given back.
 */
function leaseMembers(value: unknown): {
	readonly query: unknown;
	readonly queryPlanOperation: unknown;
	readonly release: unknown;
} {
	if (
		value == null ||
		(typeof value !== 'object' && typeof value !== 'function')
	) {
		return {
			query: undefined,
			queryPlanOperation: undefined,
			release: undefined,
		};
	}
	// Capture the way back before reading anything else: a getter is caller code,
	// and one that runs first could remove the member this boundary needs to give
	// the lease back.
	const release = readMember(value, 'release');
	return {
		query: readMember(value, 'query'),
		queryPlanOperation: readMember(value, 'queryPlanOperation'),
		release,
	};
}

function readMember(
	value: object,
	member: 'query' | 'queryPlanOperation' | 'release',
): unknown {
	try {
		return (value as Record<string, unknown>)[member];
	} catch {
		return undefined;
	}
}

/**
 * Give back what a rejected acquisition holds, when it can be given back.
 *
 * Contained rather than awaited, on the same policy as a lease's own release: a
 * `release()` declared to return void is called for its effect, and a promise
 * returned against that contract gets a handler in this turn so it cannot
 * surface unhandled.
 */
function releaseMalformedAcquisition(
	value: unknown,
	release: unknown,
	rejection: Error,
): void {
	if (typeof release !== 'function') {
		return;
	}
	try {
		void Promise.resolve(release.call(value, rejection)).catch(() => undefined);
	} catch {
		// Reporting the malformed acquisition matters more than this cleanup.
	}
}

/**
 * Mint a declared source of transition leases.
 *
 * This declares a source of leases; it does not inspect individual
 * acquisitions. Every acquisition crosses `acquireTransitionLease`, the
 * runtime boundary that validates and captures it exactly once.
 *
 * The wrapper is allocated and frozen by core. Its non-writable,
 * non-configurable `Symbol.for('dbsp.transition.lessor')` brand carries this
 * protocol version, so independently installed incompatible core versions do
 * not accept one another's lessors. The global symbol is intentionally not a
 * security boundary: code already running in this realm can forge it. This
 * protects callers from passing the wrong connection object by accident.
 */
export function createTransitionLessor(
	acquire: () => Promise<TransitionQueryClient>,
): TransitionLessor {
	const lessor = { acquire };
	Object.defineProperty(lessor, TRANSITION_LESSOR_BRAND, {
		value: Object.freeze({
			protocolVersion: TRANSITION_LESSOR_PROTOCOL_VERSION,
		}),
		writable: false,
		configurable: false,
	});
	return Object.freeze(lessor) as TransitionLessor;
}

/**
 * Recognize a core-minted transition lessor. The shape check only rejects a
 * contradictory declaration (a branded object without acquire()); the brand
 * and protocol version are the declaration.
 */
export function isTransitionLessor(value: unknown): value is TransitionLessor {
	try {
		if (
			value == null ||
			(typeof value !== 'object' && typeof value !== 'function') ||
			Array.isArray(value)
		) {
			return false;
		}
		const brand = (value as Record<symbol, unknown>)[TRANSITION_LESSOR_BRAND];
		return (
			brand != null &&
			typeof brand === 'object' &&
			(brand as LessorBrand).protocolVersion ===
				TRANSITION_LESSOR_PROTOCOL_VERSION &&
			typeof (value as { readonly acquire?: unknown }).acquire === 'function'
		);
	} catch {
		return false;
	}
}

/**
 * Carries the error that ended a lease's use. Its presence — not the value it
 * holds — is what says the lease is being returned after a failure.
 */
export type TransitionLeaseFailure = { readonly error: unknown };

/** Raised in place of a falsy thrown value, so the session is still destroyed. */
export class TransitionLeaseFailureError extends Error {
	constructor(cause: unknown) {
		super('transition lease released after a failure', { cause });
		this.name = 'TransitionLeaseFailureError';
	}
}

/**
 * The value handed to `release()` when a lease is returned after a failure.
 *
 * pg decides whether to destroy a session or pool it by testing this argument
 * for truthiness, not for presence, so `throw undefined` — or `''`, `0`,
 * `false`, `null` — would release a poisoned session back into the pool for
 * reuse. A falsy failure is therefore carried inside a real Error, which keeps
 * the original value reachable as its `cause`.
 */
function releaseArgument(failure: TransitionLeaseFailure): unknown {
	return failure.error
		? failure.error
		: new TransitionLeaseFailureError(failure.error);
}

/** Builds the uniform entry-point result for an undeclared transition lessor. */
export function transitionLessorRejectionAssessment(
	artifact: SemanticArtifactRef,
	lifecycle: PlanAssessment['lifecycle'] = 'planned',
): PlanAssessment {
	return {
		decision: 'blocked',
		assurance: 'unproven',
		lifecycle,
		continuation: 'human-intervention-required',
		reasons: [
			{
				code: 'context-mismatch',
				artifact,
				fact: {
					key: 'transition-lessor',
					value: TRANSITION_LESSOR_REJECTION,
				},
				scope: [],
			},
		],
	};
}
