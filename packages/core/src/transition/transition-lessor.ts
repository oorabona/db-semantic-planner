import type {
	ExclusiveTransitionTarget,
	PlanAssessment,
	SemanticArtifactRef,
	TransitionLessor,
	TransitionQueryClient,
	TransitionSessionClient,
} from '@dbsp/types';

const TRANSITION_LESSOR_BRAND = Symbol.for('dbsp.transition.lessor');
const TRANSITION_LESSOR_PROTOCOL_VERSION = 2;
export const TRANSITION_LESSOR_REJECTION =
	'transition target must be a core-minted lessor';
const TRANSITION_LESSOR_REJECTION_DETAIL =
	'The supplied transition target was refused because it is not a core-minted protocol-v2 lessor carrying a revocation capability.';

type LessorBrand = {
	readonly protocolVersion: number;
	readonly revocation: TransitionSessionRevocationPropagation;
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

/** A lessor declared by a caller did not uphold the lease contract. */
class TransitionLessorContractRejection extends Error {
	constructor(detail: string) {
		super(detail);
		this.name = 'TransitionLessorContractRejection';
	}
}

async function captureLease(value: unknown): Promise<CapturedLease> {
	const { query, queryPlanOperation, release } = leaseMembers(value);
	if (typeof query !== 'function' || typeof release !== 'function') {
		const rejection = new TransitionLessorContractRejection(
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

/** Return the safe operator-facing detail for a rejected lease contract. */
export function transitionLessorRejectionDetail(
	error: unknown,
): string | undefined {
	try {
		return error instanceof TransitionLessorContractRejection
			? error.message
			: undefined;
	} catch {
		return undefined;
	}
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
/**
 * A brand transports this narrow peer hook across compatible core instances.
 * It is not this instance's authority: it is always invoked with the raw
 * physical client as its receiver, after this core has set its own latch.
 */
type TransitionSessionRevocationPropagation = Readonly<{
	compromise(): void;
	isCompromised(): boolean;
}>;

type TransitionSessionRevocationLatch = {
	compromised: boolean;
};

type TransitionSessionRevocationCapability = Readonly<{
	compromise(): void;
	isCompromised(): boolean;
}>;

const transitionSessionRevocations = new WeakMap<
	object,
	TransitionSessionRevocationCapability
>();
const transitionSessionLatches = new WeakMap<
	object,
	TransitionSessionRevocationLatch
>();
const physicalSessionRevocationLatches = new WeakMap<
	object,
	TransitionSessionRevocationLatch
>();
type RemintedLessorState = {
	readonly latch: TransitionSessionRevocationLatch;
	readonly revocation: TransitionSessionRevocationCapability;
};

const remintedLessorStates = new WeakMap<object, RemintedLessorState>();

function mintTransitionSessionRevocationLatch(): TransitionSessionRevocationLatch {
	return { compromised: false };
}

/** Mint or resolve this core's one authoritative latch for a raw client. */
function resolvePhysicalSessionRevocationLatch(
	physicalSession: object,
): TransitionSessionRevocationLatch {
	const existing = physicalSessionRevocationLatches.get(physicalSession);
	if (existing) return existing;
	const latch = mintTransitionSessionRevocationLatch();
	physicalSessionRevocationLatches.set(physicalSession, latch);
	return latch;
}

/**
 * Build the cross-instance side of a brand. Its receiver is intentionally the
 * physical session, so a lessor never has one broad revocation bit for all of
 * its pool clients.
 */
function mintTransitionSessionRevocationPropagation(): TransitionSessionRevocationPropagation {
	return Object.freeze({
		compromise(this: unknown): void {
			if (!isObject(this)) return;
			resolvePhysicalSessionRevocationLatch(this).compromised = true;
		},
		isCompromised(this: unknown): boolean {
			return (
				isObject(this) &&
				resolvePhysicalSessionRevocationLatch(this).compromised
			);
		},
	});
}

/**
 * Wrap a core-local latch with optional cross-instance propagation. The local
 * state is authoritative and changes before any peer code can run.
 */
function mintTransitionSessionRevocation(
	latch: TransitionSessionRevocationLatch,
	physicalSession: object,
	propagation: TransitionSessionRevocationPropagation,
): TransitionSessionRevocationCapability {
	return Object.freeze({
		compromise(): void {
			latch.compromised = true;
			try {
				propagation.compromise.call(physicalSession);
			} catch {
				// A foreign brand can add compromise, but it can never block this mark.
			}
		},
		isCompromised(): boolean {
			if (latch.compromised) return true;
			try {
				return propagation.isCompromised.call(physicalSession) === true;
			} catch {
				// A throwing peer is not evidence that this core's clean latch is dirty.
				return false;
			}
		},
	});
}

function revocationForTransitionSession(
	session: TransitionSessionClient,
): TransitionSessionRevocationCapability {
	const revocation = transitionSessionRevocations.get(session as object);
	if (!revocation)
		throw new Error(
			'transition session was not minted by the transition lessor',
		);
	return revocation;
}

function latchForTransitionSession(
	session: TransitionSessionClient,
): TransitionSessionRevocationLatch {
	const latch = transitionSessionLatches.get(session as object);
	if (!latch)
		throw new Error(
			'transition session was not minted by the transition lessor',
		);
	return latch;
}

function mintTransitionSession(
	revocation: TransitionSessionRevocationCapability,
	latch: TransitionSessionRevocationLatch,
	query: (
		session: TransitionSessionClient,
		sql: string,
		params?: unknown,
	) => unknown,
): TransitionSessionClient {
	const session = Object.freeze({
		query: (sql: string, params?: unknown) => query(session, sql, params),
	}) as TransitionSessionClient;
	transitionSessionRevocations.set(session as object, revocation);
	transitionSessionLatches.set(session as object, latch);
	return session;
}

function transitionSessionIsCompromised(
	session: TransitionSessionClient,
): boolean {
	return revocationForTransitionSession(session).isCompromised();
}

/**
 * Read the revocation bit carried by a physical lease source.
 *
 * This is deliberately a boolean-only adapter seam: adapters retain the
 * physical lease through its final release, while core retains the token and
 * every logical wrapper that shares it. An unwrapped source has not been
 * leased, so it cannot have been marked compromised.
 */
export function transitionPhysicalSessionIsCompromised(
	physicalSession: object,
): boolean {
	return (
		physicalSessionRevocationLatches.get(physicalSession)?.compromised === true
	);
}

function compromisedTransitionSessionError(): Error {
	return new Error('transition execution marked its leased client compromised');
}

/**
 * Outcome code may poison the current lease when a transport or protocol fault
 * leaves its backend unsafe for reuse. The release boundary consumes this bit
 * and returns the client with a truthy error so pg destroys it.
 */
export function markTransitionClientCompromised(
	session: TransitionSessionClient,
): void {
	revocationForTransitionSession(session).compromise();
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
	const revocation = revocationForTransitionSession(session);
	const latch = latchForTransitionSession(session);
	return mintTransitionSession(
		revocation,
		latch,
		(planSession, sql, params) => {
			if (transitionSessionIsCompromised(planSession)) {
				return Promise.reject(compromisedTransitionSessionError());
			}
			return query(sql, params);
		},
	);
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
	if (!isTransitionLessor(target)) {
		throw new Error(TRANSITION_LESSOR_REJECTION);
	}
	const captured = await captureLease(await target.acquire());
	const { raw, query, release } = captured;
	const physicalSession = raw as object;
	const reminted = remintedLessorStates.get(target as object);
	const latch =
		reminted?.latch ?? resolvePhysicalSessionRevocationLatch(physicalSession);
	if (reminted) {
		physicalSessionRevocationLatches.set(physicalSession, reminted.latch);
	}
	const revocation =
		reminted?.revocation ??
		mintTransitionSessionRevocation(
			latch,
			physicalSession,
			lessorBrand(target).revocation,
		);
	/**
	 * One bit, set before any driver code runs. The driver's `release()` is
	 * called synchronously, so a driver that re-enters — or a consumer who wires
	 * one to — observes this state rather than the state before it.
	 */
	let closed = false;
	const session = mintTransitionSession(
		revocation,
		latch,
		(leasedSession, sql, params) => {
			// The connection may already belong to another borrower, so this must
			// not reach the driver. Rejecting rather than throwing keeps the
			// contract a promise for a caller who only attaches a handler.
			if (closed) {
				return Promise.reject(
					new Error('transition lease was already given back'),
				);
			}
			if (transitionSessionIsCompromised(leasedSession)) {
				return Promise.reject(compromisedTransitionSessionError());
			}
			return query.call(raw, sql, params);
		},
	);
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
				(transitionSessionIsCompromised(session)
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
	return mintTransitionLessor(acquire);
}

/**
 * Remint a lessor that can only ever borrow a session core already minted.
 *
 * This intentionally is not re-exported through either core barrel: durable
 * execution needs it to pin a preflight lease, while callers must never retain
 * or supply the revocation capability themselves.
 */
export function remintTransitionLessorFromSession(
	session: TransitionSessionClient,
	acquire: () => Promise<TransitionQueryClient>,
): TransitionLessor {
	return mintTransitionLessor(acquire, {
		latch: latchForTransitionSession(session),
		revocation: revocationForTransitionSession(session),
	});
}

function mintTransitionLessor(
	acquire: () => Promise<TransitionQueryClient>,
	reminted?: RemintedLessorState,
): TransitionLessor {
	const lessor = { acquire };
	Object.defineProperty(lessor, TRANSITION_LESSOR_BRAND, {
		value: Object.freeze({
			protocolVersion: TRANSITION_LESSOR_PROTOCOL_VERSION,
			revocation:
				reminted?.revocation ?? mintTransitionSessionRevocationPropagation(),
		}),
		writable: false,
		configurable: false,
	});
	const frozenLessor = Object.freeze(lessor) as TransitionLessor;
	if (reminted) {
		remintedLessorStates.set(frozenLessor as object, reminted);
	}
	return frozenLessor;
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
			isTransitionSessionRevocationCapability(
				(brand as LessorBrand).revocation,
			) &&
			typeof (value as { readonly acquire?: unknown }).acquire === 'function'
		);
	} catch {
		return false;
	}
}

function lessorBrand(target: TransitionLessor): LessorBrand {
	const brand = (target as unknown as Record<symbol, LessorBrand | undefined>)[
		TRANSITION_LESSOR_BRAND
	];
	if (!brand) throw new Error(TRANSITION_LESSOR_REJECTION);
	return brand;
}

function isTransitionSessionRevocationCapability(
	value: unknown,
): value is TransitionSessionRevocationPropagation {
	return (
		value != null &&
		typeof value === 'object' &&
		Object.isFrozen(value) &&
		typeof (value as TransitionSessionRevocationPropagation).compromise ===
			'function' &&
		typeof (value as TransitionSessionRevocationPropagation).isCompromised ===
			'function'
	);
}

function isObject(value: unknown): value is object {
	return (
		value != null && (typeof value === 'object' || typeof value === 'function')
	);
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
	detail = TRANSITION_LESSOR_REJECTION_DETAIL,
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
				detail,
				scope: [],
			},
		],
	};
}
