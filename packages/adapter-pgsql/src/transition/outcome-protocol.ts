import {
	classifyOutcomeRecovery,
	projectLedgerChain,
	selectorMatchesResource,
	type ValidatedManagedStepManifest,
} from '@dbsp/core';
import type { AdmittedDestructiveOutcomeClaim } from '@dbsp/core/internal';
import {
	admitDestructiveOutcomeClaim,
	admitOutcomeClaim,
	claimIdForToken,
	consumeClaimToken,
	type DurablyLoadedRun,
	isDestructiveAuthorityPermit,
	isDurablyLoadedRun,
} from '@dbsp/core/internal';
import type {
	AdmittedOutcomeClaim,
	ClaimBundleStatement,
	ClaimToken,
	ControllerIdentity,
	DestructiveDecision,
	LedgerAddress,
	LedgerChainMember,
	LedgerEventKind,
	LedgerPayload,
	LedgerReservationRow,
	OutcomeClaimAdmission,
	OutcomeClaimPlan,
	OutcomeIndeterminateRecoveryEvidence,
	OutcomeProtocolRefusal,
	OutcomeRecoveryClassification,
	OutcomeRecoveryEffect,
	OutcomeRecoveryReadBack,
	OutcomeVacancy,
	ScopedApprovalSet,
} from '@dbsp/types';
import { refusalFor, sameLedgerAddress } from '@dbsp/types';
import {
	type GeneratedPostconditionSession,
	mintGeneratedPostconditionSession,
} from '../ddl/generated-postcondition-verifier.js';
import { readPgCatalogueIdentity } from './catalogue-identity.js';
import { readPgLedgerAddressChain } from './chain-reader.js';
import { classifyPgWrite } from './database-writability.js';
import type { TransitionJournalQueryable } from './journal.js';
import {
	acquirePgLedgerLocks,
	appendPgLedgerClaim,
	appendPgLedgerClaimGroup,
	appendPgLedgerProgress,
	appendPgLedgerResolution,
	appendPgLedgerResolutionGroup,
	PgLedgerPhysicalShapeValidationError,
	type PgLedgerShapeAllowance,
	type PgLedgerTarget,
	readPgLedgerReservationsForPairInHomes,
	readPgLedgerReservationsForPairInTransaction,
	validatePgLedgerPhysicalShape,
} from './ledger.js';
import { isDeadPgConnectionError } from './lessor.js';
import {
	createPostLockAdmissionEvidence,
	isPostLockAdmissionEvidence,
	type PostLockAdmissionEvidence,
} from './post-lock-admission-evidence.js';
import { readPgLedgerScopeCurrency } from './reinitialize-preflight.js';

const DEFAULT_LOCK_TIMEOUT_MS = 5000;

declare const admittedPermitBrand: unique symbol;
interface AdmittedPermit {
	readonly [admittedPermitBrand]: 'dbsp-admitted-permit';
}

declare const pgLockedRunBrand: unique symbol;
const lockedRuns = new WeakSet<object>();

/**
 * A run identity that was loaded while the caller owns its run lock.  This is
 * deliberately not a structural `{ runId, planDigest }`: callers cannot bind
 * the digest check to two independently supplied strings.
 */
export interface PgLockedRun {
	readonly runId: string;
	readonly planDigest: string;
	readonly [pgLockedRunBrand]: 'dbsp-pg-locked-journal-run';
}

/**
 * Adapter-only bridge from the journal-load/run-lock boundary.  Keep this
 * beside the admitted facade; ordinary callers receive a `PgLockedRun`, never
 * manufacture one from string fields.
 */
export function lockPgJournalRun(run: DurablyLoadedRun): PgLockedRun {
	if (!isDurablyLoadedRun(run))
		throw new Error(
			'locked journal run refuses an unverified durable-run witness',
		);
	const locked = Object.freeze({
		runId: run.metadata.runId,
		planDigest: run.metadata.planDigest,
	}) as PgLockedRun;
	lockedRuns.add(locked);
	return locked;
}

declare const digestBindingVerdictBrand: unique symbol;
export interface DigestBindingVerdict {
	readonly [digestBindingVerdictBrand]: 'dbsp-digest-binding-verdict';
}

declare const validatedManifestVerdictBrand: unique symbol;
export interface ValidatedManifestVerdict {
	readonly [validatedManifestVerdictBrand]: 'dbsp-validated-manifest-verdict';
}

declare const approvalScopeVerdictBrand: unique symbol;
export interface ApprovalScopeVerdict {
	readonly [approvalScopeVerdictBrand]: 'dbsp-approval-scope-verdict';
}

declare const liveAdmissionVerdictBrand: unique symbol;
export interface LiveAdmissionVerdict {
	readonly [liveAdmissionVerdictBrand]: 'dbsp-live-admission-verdict';
}

type ReleasableTransitionJournalQueryable = TransitionJournalQueryable & {
	release(error?: unknown): void;
};

type PoolTransitionJournalQueryable = TransitionJournalQueryable & {
	connect(): Promise<ReleasableTransitionJournalQueryable>;
};

function isPoolQueryable(
	executor: TransitionJournalQueryable,
): executor is PoolTransitionJournalQueryable {
	// node-postgres exposes `connect()` on both Pool and Client. A checked-out
	// Client also has `release()`, and is already the session that the caller
	// deliberately selected (including for concurrent and kill scenarios).
	// Only a pool may be checked out here.
	return (
		'connect' in executor &&
		typeof executor.connect === 'function' &&
		!('release' in executor && typeof executor.release === 'function')
	);
}

/**
 * A pool is not a transaction session: each `query()` may use a different
 * PostgreSQL connection.  Claim append, token validation, DDL and terminal
 * append must therefore share a checked-out client whenever the caller gives
 * this protocol a pool.
 */
export async function withPgOutcomeSession<T>(
	executor: TransitionJournalQueryable,
	work: (session: TransitionJournalQueryable) => Promise<T>,
): Promise<T> {
	if (!isPoolQueryable(executor)) return work(executor);
	const session = await executor.connect();
	let failed = false;
	let failure: unknown;
	try {
		return await work(session);
	} catch (error) {
		failed = true;
		failure = error;
		throw error;
	} finally {
		session.release(
			compromisedPgOutcomeSessions.get(session) ??
				(!failed || isConfirmedPgServerError(failure)
					? undefined
					: asPgSessionReleaseError(failure)),
		);
	}
}

const compromisedPgOutcomeSessions = new WeakMap<object, Error>();

function asPgSessionReleaseError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function pgSqlState(error: unknown): string | undefined {
	if (
		error == null ||
		(typeof error !== 'object' && typeof error !== 'function')
	)
		return undefined;
	const code = (error as { readonly code?: unknown }).code;
	return typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code)
		? code
		: undefined;
}

/** A SQLSTATE is a server acknowledgement, except for known dead backends. */
function isConfirmedPgServerError(error: unknown): boolean {
	return pgSqlState(error) !== undefined && !isDeadPgConnectionError(error);
}

function markPgOutcomeSessionCompromised(
	session: TransitionJournalQueryable,
	error: unknown,
): void {
	if (isConfirmedPgServerError(error)) return;
	compromisedPgOutcomeSessions.set(
		session as object,
		asPgSessionReleaseError(error),
	);
}

/**
 * The sole explicit-transition bracket for managed ledger work.  It checks a
 * client out once when given a Pool, never checks out recursively, and keeps
 * BEGIN, all work, COMMIT/ROLLBACK and release on that one session.
 */
export async function withPgTransitionTransaction<T>(
	executor: TransitionJournalQueryable,
	work: (session: TransitionJournalQueryable) => Promise<T>,
): Promise<T> {
	return withPgOutcomeSession(executor, async (session) => {
		let committed = false;
		let commitAttempted = false;
		try {
			await session.query('BEGIN');
			const result = await work(session);
			commitAttempted = true;
			await session.query('COMMIT');
			committed = true;
			return result;
		} catch (error) {
			if (!committed && !commitAttempted) await rollback(session);
			if (commitAttempted) {
				if (isConfirmedPgServerError(error))
					throw new PgCommitDeterministicFailureError(error);
				markPgOutcomeSessionCompromised(session, error);
				throw new PgCommitAcknowledgementAmbiguousError(error);
			}
			throw error;
		}
	});
}

/** A COMMIT write may have reached PostgreSQL even when its acknowledgement did not. */
export class PgCommitAcknowledgementAmbiguousError extends Error {
	constructor(cause: unknown) {
		super(
			`PostgreSQL COMMIT acknowledgement is transport-ambiguous: ${detail(cause)}`,
			{
				cause,
			},
		);
		this.name = 'PgCommitAcknowledgementAmbiguousError';
	}
}

/** PostgreSQL acknowledged that COMMIT did not take effect. */
export class PgCommitDeterministicFailureError extends Error {
	constructor(cause: unknown) {
		super(`PostgreSQL COMMIT was rejected by the server: ${detail(cause)}`, {
			cause,
		});
		this.name = 'PgCommitDeterministicFailureError';
	}
}

/**
 * Test-only observation points on the admitted path.  Production callers do
 * not supply an observer, so the helper is inert: it performs no IPC, I/O, or
 * scheduling work in an ordinary run.
 */
export type PgOutcomeCheckpoint =
	| 'post-lock-integrity-before-append'
	| 'commit-acknowledged'
	| 'ddl-completed-before-read-back';

export type PgOutcomeCheckpointObserver = (
	checkpoint: PgOutcomeCheckpoint,
) => Promise<void> | void;

async function checkpoint(
	observer: PgOutcomeCheckpointObserver | undefined,
	point: PgOutcomeCheckpoint,
): Promise<void> {
	if (observer) await observer(point);
}

async function commitPgOutcome(
	executor: TransitionJournalQueryable,
	observer?: PgOutcomeCheckpointObserver,
): Promise<void> {
	try {
		await executor.query('COMMIT');
		await checkpoint(observer, 'commit-acknowledged');
	} catch (error) {
		if (isConfirmedPgServerError(error))
			throw new PgCommitDeterministicFailureError(error);
		markPgOutcomeSessionCompromised(executor, error);
		throw new PgCommitAcknowledgementAmbiguousError(error);
	}
}

export interface PgOutcomeClaimRequest {
	readonly plan: OutcomeClaimPlan;
	readonly reservations: readonly LedgerReservationRow[];
	readonly lockTimeoutMs?: number;
	/** Destructive authority is evaluated under these same ledger locks. */
	readonly destructiveDecision?: (
		executor: TransitionJournalQueryable,
		plan: OutcomeClaimPlan,
	) => Promise<DestructiveDecision>;
	/** Optional E2E observer; absent in all production command paths. */
	readonly observer?: PgOutcomeCheckpointObserver;
}

/** One root claim plus its token-free destructive-closure members. */
export interface PgOutcomeClaimGroupRequest extends PgOutcomeClaimRequest {
	readonly members: readonly Omit<
		PgOutcomeClaimRequest,
		'destructiveDecision'
	>[];
}

export interface PgOutcomeClaimGroupAdmission {
	readonly root: OutcomeClaimAdmission;
	readonly members: readonly OutcomeClaimAdmission[];
}

export interface PgOutcomeClaimGroupResolution {
	readonly rootClaimId: string;
	readonly members: readonly {
		readonly target: PgLedgerTarget;
		readonly member: Omit<LedgerChainMember, 'controller' | 'recordedAt'>;
	}[];
	readonly reservations: readonly Pick<LedgerReservationRow, 'address'>[];
	readonly lockTimeoutMs?: number;
	/** Durable run witness carried from destructive admission to its terminal. */
	readonly runtimeIntegrityRun?: PgLockedRun;
	/** Optional E2E observer for this terminal-appending transaction. */
	readonly observer?: PgOutcomeCheckpointObserver;
}

export interface PgOutcomeResolution {
	readonly eventId: string;
	readonly eventKind: Exclude<
		LedgerEventKind,
		| 'intent'
		| 'retire-intent'
		| 'readdress-intent'
		| 'adopt-intent'
		| 'executing'
	>;
	readonly observed?: LedgerChainMember['observed'];
	/** Required by the ledger writer when this resolution is `refused`. */
	readonly refusal?: LedgerChainMember['refusal'];
}

export interface PgOutcomeExecutionRequest {
	readonly token: ClaimToken;
	readonly claim: AdmittedOutcomeClaim;
	readonly statements: readonly ClaimBundleStatement[];
}

/**
 * The first admitted-operation shape. Later waves add single and paired
 * operation variants without reopening the facade's authority boundary.
 */
export interface PgSingleAdmittedOperation {
	readonly kind: 'single-outcome';
	readonly request:
		| PgOutcomeTransactionalRequest
		| PgOutcomeNonTransactionalRequest;
}

/**
 * Readdress keeps its catalogue closure discovery in readdress.ts, while this
 * facade owns the only claim/permit/DDL/terminal path for the resulting pair.
 */
export interface PgPairedReaddressOperation {
	readonly kind: 'paired-readdress';
	readonly request: {
		readonly pairId: string;
		readonly executionId: string;
		readonly members: readonly {
			readonly source: LedgerAddress;
			readonly target: LedgerAddress;
			readonly sourceClaimId: string;
			readonly targetClaimId: string;
			readonly sourceDeclared?: LedgerPayload;
			readonly targetDeclared: LedgerPayload;
			readonly targetObserved: LedgerPayload;
		}[];
		readonly reservations: readonly LedgerReservationRow[];
		readonly statements: readonly ClaimBundleStatement[];
		/** Digest-covered root material for this paired request; it is never empty. */
		readonly manifestPlan: OutcomeClaimPlan;
		/** Re-read closure, source controller/identity and target vacancy under lock. */
		readonly verifyLiveAdmission: (
			executor: TransitionJournalQueryable,
			currentController: ControllerIdentity,
		) => Promise<OutcomeProtocolRefusal | undefined>;
		readonly lockTimeoutMs?: number;
		/** Optional E2E observer; absent in normal execution. */
		readonly observer?: PgOutcomeCheckpointObserver;
	};
}

export interface PgDestructiveAdmittedOperation {
	readonly kind: 'destructive-outcome';
	readonly request: PgOutcomeClaimGroupRequest;
	readonly readBackAndResolve: (
		executor: TransitionJournalQueryable,
		claim: AdmittedDestructiveOutcomeClaim,
	) => Promise<PgOutcomeClaimGroupResolution>;
}

export type PgAdmittedOperation =
	| PgSingleAdmittedOperation
	| PgPairedReaddressOperation
	| PgDestructiveAdmittedOperation;

export type PgAdmittedOperationResult =
	| PgOutcomeResult
	| PgDestructiveOutcomeResult
	| { readonly kind: 'executed-paired-readdress'; readonly pairId: string }
	| { readonly kind: 'outcome-transport-ambiguous'; readonly reason: string }
	| {
			readonly kind: 'outcome-recovery-required';
			readonly claimId: string;
			readonly reason: string;
	  };

interface AdmittedPermitRecord {
	readonly claim?: AdmittedOutcomeClaim;
	readonly paired?: {
		readonly pairId: string;
		readonly statements: readonly ClaimBundleStatement[];
	};
}
const admittedPermitRecords = new WeakMap<object, AdmittedPermitRecord>();

type AdmissionOperationClassification = PgAdmittedOperation['kind'];

interface ApprovalScopeRecord {
	readonly address: LedgerAddress;
	readonly classification: AdmissionOperationClassification;
}

const digestBindingVerdicts = new WeakSet<object>();
const validatedManifestVerdicts = new WeakSet<object>();
const approvalScopeVerdicts = new WeakMap<object, ApprovalScopeRecord>();
const liveAdmissionVerdicts = new WeakMap<object, PostLockAdmissionEvidence>();

function mintDigestBindingVerdict(): DigestBindingVerdict {
	const verdict = Object.freeze({}) as DigestBindingVerdict;
	digestBindingVerdicts.add(verdict);
	return verdict;
}

function mintValidatedManifestVerdict(): ValidatedManifestVerdict {
	const verdict = Object.freeze({}) as ValidatedManifestVerdict;
	validatedManifestVerdicts.add(verdict);
	return verdict;
}

function mintApprovalScopeVerdict(
	address: LedgerAddress,
	classification: AdmissionOperationClassification,
): ApprovalScopeVerdict {
	const verdict = Object.freeze({}) as ApprovalScopeVerdict;
	approvalScopeVerdicts.set(verdict, { address, classification });
	return verdict;
}

function mintLiveAdmissionVerdict(
	evidence: PostLockAdmissionEvidence,
): LiveAdmissionVerdict {
	if (!isPostLockAdmissionEvidence(evidence))
		throw new Error(
			'admitted permit requires authentic post-lock admission evidence',
		);
	const verdict = Object.freeze({}) as LiveAdmissionVerdict;
	liveAdmissionVerdicts.set(verdict, evidence);
	return verdict;
}

/** NEXT ROUND target for direct compatibility runners without durable evidence. */
function requireAdmittedVerdicts(
	digestBinding: DigestBindingVerdict,
	validatedManifest: ValidatedManifestVerdict,
	approvalScope: ApprovalScopeVerdict,
	liveAdmission: LiveAdmissionVerdict,
	evidence?: PostLockAdmissionEvidence,
): void {
	if (!digestBindingVerdicts.has(digestBinding))
		throw new Error('admitted permit requires a digest-binding verdict');
	if (!validatedManifestVerdicts.has(validatedManifest))
		throw new Error('admitted permit requires a validated-manifest verdict');
	if (!approvalScopeVerdicts.has(approvalScope))
		throw new Error('admitted permit requires an approval-scope verdict');
	const boundEvidence = liveAdmissionVerdicts.get(liveAdmission);
	if (!boundEvidence || !isPostLockAdmissionEvidence(boundEvidence))
		throw new Error(
			'admitted permit requires a post-lock live-admission verdict',
		);
	if (
		evidence &&
		(!isPostLockAdmissionEvidence(evidence) || boundEvidence !== evidence)
	)
		throw new Error(
			'admitted permit requires the post-lock evidence that minted its live-admission verdict',
		);
}

export function mintAdmittedPermit(
	claim: AdmittedOutcomeClaim,
	digestBinding: DigestBindingVerdict,
	validatedManifest: ValidatedManifestVerdict,
	approvalScope: ApprovalScopeVerdict,
	liveAdmission: LiveAdmissionVerdict,
	evidence: PostLockAdmissionEvidence,
): AdmittedPermit {
	requireAdmittedVerdicts(
		digestBinding,
		validatedManifest,
		approvalScope,
		liveAdmission,
		evidence,
	);
	const approval = approvalScopeVerdicts.get(approvalScope);
	if (
		approval?.classification !== 'single-outcome' ||
		!sameLedgerAddress(approval.address, claim.plan.address)
	)
		throw new Error(
			'admitted permit refuses an approval scope verdict for another operation',
		);
	const permit = Object.freeze({}) as AdmittedPermit;
	admittedPermitRecords.set(permit, { claim });
	return permit;
}

function mintPairedReaddressPermit(
	pairId: string,
	statements: readonly ClaimBundleStatement[],
	digestBinding: DigestBindingVerdict,
	validatedManifest: ValidatedManifestVerdict,
	approvalScope: ApprovalScopeVerdict,
	liveAdmission: LiveAdmissionVerdict,
): AdmittedPermit {
	requireAdmittedVerdicts(
		digestBinding,
		validatedManifest,
		approvalScope,
		liveAdmission,
	);
	const approval = approvalScopeVerdicts.get(approvalScope);
	if (approval?.classification !== 'paired-readdress')
		throw new Error(
			'admitted permit refuses an approval scope verdict for another operation',
		);
	const permit = Object.freeze({}) as AdmittedPermit;
	admittedPermitRecords.set(permit, { paired: { pairId, statements } });
	return permit;
}

function admittedClaim(
	permit: AdmittedPermit,
): AdmittedOutcomeClaim | undefined {
	return admittedPermitRecords.get(permit)?.claim;
}

/** The destructive DDL sink cannot be called with raw evidence or a bare token. */
export interface PgDestructiveOutcomeExecutionRequest {
	readonly claim: AdmittedDestructiveOutcomeClaim;
	readonly statements: readonly ClaimBundleStatement[];
}

/**
 * Predecessors are ledger facts, never lifecycle predictions.  Every managed
 * successor reads the unique current terminal on the same pinned session and
 * in the transaction that will append it; a previous append in that
 * transaction is therefore visible here too.
 */
async function currentTerminalPredecessor(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	address: LedgerAddress,
): Promise<string | undefined> {
	return (await readPgLedgerAddressChain(executor, target, address))
		.terminalMember?.eventId;
}

async function memberWithCurrentTerminalPredecessor(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	member: Omit<LedgerChainMember, 'controller' | 'recordedAt'>,
): Promise<Omit<LedgerChainMember, 'controller' | 'recordedAt'>> {
	const predecessor = await currentTerminalPredecessor(
		executor,
		target,
		member.address,
	);
	const { predecessor: _predicted, ...withoutPredictedPredecessor } = member;
	return {
		...withoutPredictedPredecessor,
		...(predecessor === undefined ? {} : { predecessor }),
	};
}

export type PgDestructiveOutcomeResult =
	| { readonly kind: 'executed-destructive-outcome' }
	/**
	 * SQL was admitted and may have run, but its operation-owned read-back could
	 * not establish a terminal fact.  Keep the durable claim open for reconcile;
	 * in particular, never turn this post-executing state into `refused`.
	 */
	| { readonly kind: 'outcome-protocol-pending'; readonly reason: string }
	| OutcomeProtocolRefusal
	| { readonly kind: 'outcome-transport-ambiguous'; readonly reason: string }
	| {
			readonly kind: 'outcome-recovery-required';
			readonly claimId: string;
			readonly reason: string;
	  };

/**
 * High-level managed destructive execution. It owns claim admission and the
 * token-gated PostgreSQL sender so callers cannot compose raw ledger writes
 * with a fabricated capability.
 */
async function runPgDestructiveOutcome(
	executor: TransitionJournalQueryable,
	request: PgOutcomeClaimGroupRequest,
	run: PgLockedRun,
	readBackAndResolve: (
		executor: TransitionJournalQueryable,
		claim: AdmittedDestructiveOutcomeClaim,
	) => Promise<PgOutcomeClaimGroupResolution>,
): Promise<PgDestructiveOutcomeResult> {
	return withPgOutcomeSession(executor, async (session) => {
		const admission =
			request.members.length > 0
				? (await openPgOutcomeClaimGroup(session, request, run)).root
				: await openPgOutcomeClaim(session, request, run);
		if (admission.kind !== 'admitted-outcome-claim') return admission;
		if (!('destructivePermit' in admission))
			return refusal('destructive admission did not mint an authority permit');
		let executingCommitted = false;
		const recoveryRequired = (reason: string): PgDestructiveOutcomeResult => ({
			kind: 'outcome-recovery-required',
			claimId: admission.plan.claimId,
			reason,
		});
		try {
			// Persist the send boundary before the first autocommitted statement.
			await begin(session, request.lockTimeoutMs);
			const executingLock = await acquirePgLedgerLocks(
				session,
				homesForGroup(request),
			);
			if (executingLock.kind !== 'acquired') {
				await rollback(session);
				return refusal('ledger advisory lock is busy');
			}
			const executingPostLockEvidence = await createPostLockAdmissionEvidence(
				session,
				executingLock.proof,
			);
			const executingLiveAdmission = await checkLiveAdmission(
				executingPostLockEvidence,
			);
			if ('kind' in executingLiveAdmission) {
				await rollback(session);
				return executingLiveAdmission;
			}
			const integrity = await validatePgLedgerRuntimeIntegrity(
				session,
				homesForGroup(request),
				run,
			);
			if (integrity) {
				await rollback(session);
				return integrity;
			}
			await checkpoint(request.observer, 'post-lock-integrity-before-append');
			const target = targetForPlan(request.plan);
			const predecessor = await currentTerminalPredecessor(
				session,
				target,
				admission.plan.address,
			);
			if (!predecessor)
				throw new Error(
					`claim ${admission.plan.claimId} has no current terminal`,
				);
			await appendPgLedgerProgress(session, target, {
				eventId: `${request.plan.claimId}:executing`,
				...(admission.plan.executionId === undefined
					? {}
					: { executionId: admission.plan.executionId }),
				...(admission.plan.plannedClaimKey === undefined
					? {}
					: { plannedClaimKey: admission.plan.plannedClaimKey }),
				...(admission.plan.claimGroupId === undefined
					? {}
					: { claimGroupId: admission.plan.claimGroupId }),
				...(admission.plan.rootClaimId === undefined
					? {}
					: { rootClaimId: admission.plan.rootClaimId }),
				address: admission.plan.address,
				eventKind: 'executing',
				predecessor,
			});
			try {
				await commitPgOutcome(session, request.observer);
				executingCommitted = true;
			} catch (error) {
				if (error instanceof PgCommitDeterministicFailureError) throw error;
				if (error instanceof PgCommitAcknowledgementAmbiguousError)
					return recoveryRequired(error.message);
				throw error;
			}
			const sent = await executePgDestructiveBundle(session, {
				claim: admission as AdmittedDestructiveOutcomeClaim,
				statements: request.plan.statementBundle.statements,
			});
			if (sent) return recoveryRequired(sent.reason);
			await checkpoint(request.observer, 'ddl-completed-before-read-back');
			const resolution = await readBackAndResolve(
				session,
				admission as AdmittedDestructiveOutcomeClaim,
			);
			// The read-back factory owns the durable terminal material, while the
			// admitted operation owns the test-only observer.  Preserve both so the
			// terminal resolution COMMIT is observable by the same one-shot
			// checkpoint protocol as the preceding executing COMMIT.
			const resolved = await resolvePgDestructiveOutcome(session, {
				...resolution,
				runtimeIntegrityRun: run,
				...(request.observer === undefined
					? {}
					: { observer: request.observer }),
			});
			if (
				resolution.members.some(
					({ member }) => member.eventKind === 'indeterminate',
				)
			)
				return {
					kind: 'outcome-protocol-pending',
					reason:
						'destructive read-back found a surviving closure member; the claim remains indeterminate',
				};
			return resolved
				? recoveryRequired(resolved.reason)
				: { kind: 'executed-destructive-outcome' };
		} catch (error) {
			await rollback(session);
			if (error instanceof PgCommitDeterministicFailureError) throw error;
			if (error instanceof PgCommitAcknowledgementAmbiguousError)
				return recoveryRequired(error.message);
			markPgOutcomeSessionCompromised(session, error);
			if (executingCommitted) return recoveryRequired(detail(error));
			return refusal(detail(error));
		}
	});
}

/**
 * Internal compatibility bridge. Callers must bring the durable run and scoped
 * approvals that the façade consumes; this bridge never invents either.
 */
export async function executePgDestructiveOutcome(
	executor: TransitionJournalQueryable,
	input: {
		readonly run: PgLockedRun;
		readonly approval: ScopedApprovalSet;
		readonly request: PgOutcomeClaimGroupRequest;
		readonly readBackAndResolve: (
			executor: TransitionJournalQueryable,
			claim: AdmittedDestructiveOutcomeClaim,
		) => Promise<PgOutcomeClaimGroupResolution>;
	},
): Promise<PgDestructiveOutcomeResult> {
	const result = await executePgAdmittedOperation(executor, {
		run: input.run,
		approval: input.approval,
		operation: {
			kind: 'destructive-outcome',
			request: input.request,
			readBackAndResolve: input.readBackAndResolve,
		},
	});
	return result as PgDestructiveOutcomeResult;
}

/** Keeps terminal appends and reservation release behind the managed facade. */
export async function resolvePgDestructiveOutcome(
	executor: TransitionJournalQueryable,
	request: PgOutcomeClaimGroupResolution,
): Promise<undefined | OutcomeProtocolRefusal> {
	if (request.members.length === 0)
		return refusal('destructive outcome has no terminal member');
	if (request.members.length > 1)
		return resolvePgOutcomeClaimGroup(executor, request);
	const terminal = request.members[0]!;
	return withPgOutcomeSession(executor, async (session) => {
		let begun = false;
		try {
			await begin(session, request.lockTimeoutMs);
			begun = true;
			const lock = await acquirePgLedgerLocks(session, [terminal.target]);
			if (lock.kind !== 'acquired') {
				await rollback(session);
				begun = false;
				return refusal('ledger advisory lock is busy');
			}
			const postLockEvidence = await createPostLockAdmissionEvidence(
				session,
				lock.proof,
			);
			const liveAdmission = await checkLiveAdmission(postLockEvidence);
			if ('kind' in liveAdmission) {
				await rollback(session);
				begun = false;
				return liveAdmission;
			}
			const integrity = await validatePgLedgerRuntimeIntegrity(
				session,
				[terminal.target],
				request.runtimeIntegrityRun,
			);
			if (integrity) {
				await rollback(session);
				begun = false;
				return integrity;
			}
			await checkpoint(request.observer, 'post-lock-integrity-before-append');
			const member = await memberWithCurrentTerminalPredecessor(
				session,
				terminal.target,
				terminal.member,
			);
			if (member.eventKind === 'indeterminate')
				await appendPgLedgerProgress(session, terminal.target, member);
			else
				await appendPgLedgerResolution(
					session,
					terminal.target,
					member,
					request.rootClaimId,
					request.reservations,
				);
			await commitPgOutcome(session, request.observer);
			begun = false;
			return undefined;
		} catch (error) {
			if (begun) await rollback(session);
			if (
				error instanceof PgCommitDeterministicFailureError ||
				error instanceof PgCommitAcknowledgementAmbiguousError
			)
				throw error;
			return refusal(detail(error));
		}
	});
}

export interface PgOutcomeTransactionalRequest extends PgOutcomeClaimRequest {
	readonly resolution: PgOutcomeResolution;
	/** Core has already opened the segment transaction; never nest BEGIN. */
	readonly transactionOpen?: boolean;
	/**
	 * Operation-owned terminal read-back; generic catalogue identity is not
	 * evidence. It receives the admitted session so transactional DDL is read
	 * before its terminal ledger fact commits.
	 */
	readonly readBack?: (
		executor: GeneratedPostconditionSession,
	) => Promise<LedgerPayload>;
	/** Required for creations; the reader runs after the claim and before SQL. */
	readonly vacancy?: (
		executor: TransitionJournalQueryable,
		plan: OutcomeClaimPlan,
	) => Promise<OutcomeVacancy>;
	/** Re-check operation-specific live facts after the claim/reservation opens. */
	readonly verifyLiveAdmission?: (
		executor: TransitionJournalQueryable,
		plan: OutcomeClaimPlan,
	) => Promise<OutcomeProtocolRefusal | undefined>;
	/** Record the post-DDL catalogue identity on a present terminal member. */
	readonly recordCatalogueIdentity?: boolean;
}

export interface PgOutcomeNonTransactionalRequest
	extends PgOutcomeTransactionalRequest {
	readonly executingEventId: string;
	/** Observable acknowledgement point after executing has committed, before SQL. */
	readonly onExecutingCommitted?: () => Promise<void> | void;
}

/** Builds the canonical read-back payload once catalogue presence is proven. */
export type PgOutcomeReadBackFactory = (
	executor: GeneratedPostconditionSession,
	address: LedgerAddress,
	catalogueIdentity: NonNullable<
		Awaited<ReturnType<typeof readPgCatalogueIdentity>>
	>['catalogueIdentity'],
) => Promise<LedgerPayload>;

/**
 * A postcondition read owned by the operation itself.  Catalogue identity is
 * still retained when present for the ledger, but effect classification comes
 * from the operation's value-level observation rather than object presence.
 */
export type PgOutcomeOperationReadBackFactory = (
	executor: TransitionJournalQueryable,
	address: LedgerAddress,
	catalogueIdentity:
		| NonNullable<
				Awaited<ReturnType<typeof readPgCatalogueIdentity>>
		  >['catalogueIdentity']
		| undefined,
) => Promise<{
	readonly observed: LedgerPayload;
	readonly effect: OutcomeRecoveryEffect;
}>;

export interface PgOutcomeRecoveryRequest {
	readonly address: LedgerAddress;
	readonly reservations: readonly Pick<LedgerReservationRow, 'address'>[];
	readonly resolutionEventId: string;
	readonly acceptedExternalDdlExclusion: boolean;
	/** Durable claim-bound evidence re-matched by reconcile under the run lock. */
	readonly indeterminateEvidence?: OutcomeIndeterminateRecoveryEvidence;
	readonly resolveIndeterminate?: boolean;
	readonly readBack: PgOutcomeReadBackFactory;
	readonly operationReadBack?: PgOutcomeOperationReadBackFactory;
	readonly lockTimeoutMs?: number;
	/** Internal-only, in-memory allowance for one harness-installed trigger. */
	readonly ledgerShapeAllowance?: PgLedgerShapeAllowance;
	/** Optional E2E observer for recovery's committing transaction. */
	readonly observer?: PgOutcomeCheckpointObserver;
}

export type PgOutcomeResolutionAppendResult =
	| { readonly kind: 'appended-outcome-resolution' }
	| { readonly kind: 'already-appended-outcome-resolution' }
	| {
			readonly kind: 'malformed-outcome-resolution';
			readonly reason: string;
	  };

export type PgOutcomeRecoveryResult =
	| Exclude<
			OutcomeRecoveryClassification,
			{ readonly kind: 'outcome-recovery-append' }
	  >
	| {
			readonly kind: 'outcome-recovery-appended';
			readonly classification: Extract<
				OutcomeRecoveryClassification,
				{ readonly kind: 'outcome-recovery-append' }
			>;
			readonly append: Exclude<
				PgOutcomeResolutionAppendResult,
				{ readonly kind: 'malformed-outcome-resolution' }
			>;
	  }
	| { readonly kind: 'outcome-transport-ambiguous'; readonly reason: string }
	| OutcomeProtocolRefusal;

export type PgOutcomeResult =
	| {
			readonly kind: 'executed-outcome-claim';
			readonly claim: AdmittedOutcomeClaim;
	  }
	| OutcomeProtocolRefusal
	| { readonly kind: 'outcome-transport-ambiguous'; readonly reason: string }
	| {
			readonly kind: 'outcome-recovery-required';
			readonly claimId: string;
			readonly reason: string;
	  };

export type PgPairedReaddressRecoveryDecision =
	| { readonly kind: 'refused'; readonly reason: string }
	| { readonly kind: 'pending'; readonly reason: string }
	| { readonly kind: 'indeterminate'; readonly reason: string }
	| { readonly kind: 'outcome-transport-ambiguous'; readonly reason: string };

/**
 * Recovery owns its reservation set: it re-reads every durable pair row,
 * checks currency under the same locks, and appends only under a minted paired
 * permit. A caller's selected rows are evidence to compare, never authority.
 */
export async function recoverPgAdmittedReaddressPair(
	executor: TransitionJournalQueryable,
	request: {
		readonly pairId: string;
		readonly executionId: string;
		readonly reservations: readonly LedgerReservationRow[];
		readonly assess: (
			executor: TransitionJournalQueryable,
			reservations: readonly LedgerReservationRow[],
		) => Promise<PgPairedReaddressRecoveryDecision>;
		readonly observer?: PgOutcomeCheckpointObserver;
	},
): Promise<PgPairedReaddressRecoveryDecision> {
	return withPgOutcomeSession(executor, (session) =>
		recoverPgAdmittedReaddressPairOnSession(session, request),
	);
}

async function recoverPgAdmittedReaddressPairOnSession(
	executor: TransitionJournalQueryable,
	request: {
		readonly pairId: string;
		readonly executionId: string;
		readonly reservations: readonly LedgerReservationRow[];
		readonly assess: (
			executor: TransitionJournalQueryable,
			reservations: readonly LedgerReservationRow[],
		) => Promise<PgPairedReaddressRecoveryDecision>;
		readonly observer?: PgOutcomeCheckpointObserver;
	},
): Promise<PgPairedReaddressRecoveryDecision> {
	let begun = false;
	try {
		await begin(executor, undefined);
		begun = true;
		const transactionId = await readPgTransactionId(executor);
		const initial = await readPgLedgerReservationsForPairInTransaction(
			executor,
			request.pairId,
		);
		const reservationKey = (rows: readonly LedgerReservationRow[]) =>
			rows
				.map((row) => canonicalJson(row))
				.sort()
				.join('\n');
		if (
			initial.length === 0 ||
			reservationKey(initial) !== reservationKey(request.reservations) ||
			initial.some((row) => row.executionId !== request.executionId)
		) {
			await executor.query('ROLLBACK');
			begun = false;
			return {
				kind: 'pending',
				reason:
					're-address recovery reservation subset is not the durable execution closure',
			};
		}
		const homes = uniquePgLedgerHomes(initial.map((row) => row.homeLedger));
		const lock = await acquirePgLedgerLocks(executor, homes);
		if (lock.kind !== 'acquired') {
			await executor.query('ROLLBACK');
			begun = false;
			return { kind: 'pending', reason: 'ledger advisory lock is busy' };
		}
		assertPgTransactionId(
			transactionId,
			await readPgTransactionId(executor),
			'advisory lock',
		);
		const postLockEvidence = await createPostLockAdmissionEvidence(
			executor,
			lock.proof,
		);
		const liveAdmission = await checkLiveAdmission(postLockEvidence);
		if ('kind' in liveAdmission) {
			await executor.query('ROLLBACK');
			begun = false;
			return { kind: 'pending', reason: liveAdmission.reason };
		}
		const integrity = await validatePgLedgerRuntimeIntegrity(executor, homes);
		if (integrity) {
			await executor.query('ROLLBACK');
			begun = false;
			return { kind: 'pending', reason: integrity.reason };
		}
		const durable = await readPgLedgerReservationsForPairInHomes(
			executor,
			request.pairId,
			homes,
		);
		assertPgTransactionId(
			transactionId,
			await readPgTransactionId(executor),
			'reservation reread',
		);
		if (
			durable.length === 0 ||
			reservationKey(durable) !== reservationKey(initial) ||
			reservationKey(durable) !== reservationKey(request.reservations) ||
			durable.some((row) => row.executionId !== request.executionId)
		) {
			await executor.query('ROLLBACK');
			begun = false;
			return {
				kind: 'pending',
				reason:
					're-address recovery reservation subset is not the durable execution closure',
			};
		}
		const decision = await request.assess(executor, durable);
		if (decision.kind === 'pending') {
			await executor.query('ROLLBACK');
			begun = false;
			return decision;
		}
		for (const reservation of durable) {
			if (decision.kind === 'indeterminate') {
				await appendPgLedgerProgress(executor, reservation.homeLedger, {
					eventId: `${reservation.rootClaimId}:reconcile:${request.executionId}:indeterminate`,
					address: reservation.address,
					eventKind: 'indeterminate',
					predecessor: reservation.rootClaimId,
					pairId: request.pairId,
				});
			} else {
				await appendPgLedgerResolution(
					executor,
					reservation.homeLedger,
					{
						eventId: `${reservation.rootClaimId}:reconcile:${request.executionId}:refused`,
						address: reservation.address,
						eventKind: 'refused',
						predecessor: reservation.rootClaimId,
						pairId: request.pairId,
						refusal: refusalFor('ERR-11', {
							address: reservation.address,
							state: 'unknown',
						}),
					},
					reservation.rootClaimId,
					[reservation],
				);
			}
		}
		assertPgTransactionId(
			transactionId,
			await readPgTransactionId(executor),
			'pair terminal append',
		);
		await commitPgOutcome(executor, request.observer);
		begun = false;
		return decision;
	} catch (error) {
		if (begun) await rollback(executor);
		if (error instanceof PgCommitDeterministicFailureError) throw error;
		if (error instanceof PgCommitAcknowledgementAmbiguousError)
			return { kind: 'outcome-transport-ambiguous', reason: error.message };
		return { kind: 'pending', reason: detail(error) };
	}
}

function uniquePgLedgerHomes(
	homes: readonly PgLedgerTarget[],
): readonly PgLedgerTarget[] {
	const unique = new Map<string, PgLedgerTarget>();
	for (const home of homes)
		unique.set(`${home.scope}:${home.schema ?? ''}`, home);
	return [...unique.values()];
}

async function readPgTransactionId(
	executor: TransitionJournalQueryable,
): Promise<string> {
	const result = await executor.query(
		'SELECT pg_catalog.txid_current()::text AS transaction_id',
	);
	const transactionId = result.rows[0]?.transaction_id;
	if (typeof transactionId !== 'string')
		throw new Error(
			'paired recovery could not prove its PostgreSQL transaction identity',
		);
	return transactionId;
}

function assertPgTransactionId(
	expected: string,
	actual: string,
	phase: string,
): void {
	if (actual !== expected)
		throw new Error(
			`paired recovery transaction changed across ${phase}; refusing split pair resolution`,
		);
}

function refusal(reason: string): OutcomeProtocolRefusal {
	return { kind: 'outcome-protocol-refused', reason };
}

function detail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function targetForPlan(plan: OutcomeClaimPlan): PgLedgerTarget {
	return targetForAddress(plan.address, plan.claimId);
}

function targetForAddress(
	address: LedgerAddress,
	label = address.name,
): PgLedgerTarget {
	if (address.scope === 'database') return { scope: 'database' };
	if (!address.schema)
		throw new Error(`schema-scoped claim ${label} has no schema address`);
	return { scope: 'schema', schema: address.schema };
}

function homesFor(request: PgOutcomeClaimRequest) {
	const homes = [targetForPlan(request.plan)];
	for (const reservation of request.reservations) {
		if (reservation.address.scope === 'database')
			homes.push({ scope: 'database' });
		else if (reservation.address.schema)
			homes.push({ scope: 'schema', schema: reservation.address.schema });
		else
			throw new Error(
				`schema-scoped reservation ${reservation.address.name} has no schema address`,
			);
	}
	return homes;
}

function homesForGroup(request: PgOutcomeClaimGroupRequest) {
	return [request, ...request.members].flatMap((member) => homesFor(member));
}

function boundedLockTimeout(value: number | undefined): number {
	if (!Number.isFinite(value)) return DEFAULT_LOCK_TIMEOUT_MS;
	return Math.max(
		1,
		Math.min(86_400_000, Math.trunc(value ?? DEFAULT_LOCK_TIMEOUT_MS)),
	);
}

/**
 * The only adapter-to-core live-admission bridge. It reads controller and
 * catalogue identity on the claiming connection after ledger serialization;
 * callers never manufacture managed-by-me from a projected state.
 */
async function liveAdmission(
	executor: TransitionJournalQueryable,
	plan: OutcomeClaimPlan,
	chain: Awaited<ReturnType<typeof readPgLedgerAddressChain>>,
) {
	const projection = projectLedgerChain(chain);
	if (
		projection.kind !== 'projected-ledger-chain' ||
		projection.stableState !== 'managed' ||
		plan.requiresVacancy === true
	)
		return { plan, projection };
	const role = await executor.query(
		'SELECT current_user AS current_user, current_user::regrole::oid::text AS current_user_oid',
	);
	const currentUser = role.rows[0]?.current_user;
	const currentUserOid = role.rows[0]?.current_user_oid;
	const live = await readPgCatalogueIdentity(executor, plan.address);
	return {
		plan,
		projection,
		...(typeof currentUser === 'string' && typeof currentUserOid === 'string'
			? {
					currentController: { name: currentUser, oid: currentUserOid },
				}
			: {}),
		liveAddress: {
			...plan.address,
			...(live?.catalogueIdentity
				? { catalogueIdentity: live.catalogueIdentity }
				: {}),
		},
	};
}

function currencyRefusal(
	currency: Awaited<ReturnType<typeof readPgLedgerScopeCurrency>>,
): OutcomeProtocolRefusal {
	return refusal(
		currency.kind === 'not-current' && currency.reason === 'lineage'
			? 'managed-ledger-not-current: ledger lineage mismatch; run dbsp preflight --reinitialize'
			: `managed-ledger-not-current: ledger marker ${currency.marker.kind}; run dbsp preflight --reinitialize`,
	);
}

type RuntimeIntegritySeams = {
	readonly validateShape: typeof validatePgLedgerPhysicalShape;
	readonly readCurrency: typeof readPgLedgerScopeCurrency;
};

const runtimeIntegritySeams: RuntimeIntegritySeams = {
	validateShape: validatePgLedgerPhysicalShape,
	readCurrency: readPgLedgerScopeCurrency,
};

/**
 * The façade's runtime gate: validate the physical ledger and its marker /
 * lineage currency on the same pinned execution session before it admits DDL.
 * Callers must still take the ledger locks before claiming; this check avoids a
 * preflight-only trust decision without widening the ledger DDL grammar.
 */
export async function validatePgLedgerRuntimeIntegrity(
	executor: TransitionJournalQueryable,
	homes: readonly PgLedgerTarget[],
	run?: PgLockedRun,
	seams: RuntimeIntegritySeams = runtimeIntegritySeams,
): Promise<OutcomeProtocolRefusal | undefined> {
	const seen = new Set<string>();
	for (const home of homes) {
		const key = `${home.scope}:${home.schema ?? ''}`;
		if (seen.has(key)) continue;
		seen.add(key);
		// Direct compatibility runners do not carry a durable run witness. They
		// keep their existing currency-only check; every witness-bearing admission
		// independently re-checks shape with no retained cache.
		if (run !== undefined) await seams.validateShape(executor, home);
		const currency = await seams.readCurrency(executor, home);
		if (currency.kind !== 'current') return currencyRefusal(currency);
	}
	return undefined;
}

/**
 * The sole claim-admission route: after the caller has begun and serialized
 * the claim transaction, it re-reads ledger currency, evaluates the core
 * lifecycle/controller/identity interpreter, and appends the claim.
 */
async function admitPgOutcomeClaim(
	executor: TransitionJournalQueryable,
	request: PgOutcomeClaimRequest,
): Promise<{
	readonly admission: OutcomeClaimAdmission;
	readonly chain?: Awaited<ReturnType<typeof readPgLedgerAddressChain>>;
}> {
	const seen = new Set<string>();
	for (const home of homesFor(request)) {
		const key = `${home.scope}:${home.schema ?? ''}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const currency = await readPgLedgerScopeCurrency(executor, home);
		if (currency.kind !== 'current')
			return { admission: currencyRefusal(currency) };
	}
	const target = targetForPlan(request.plan);
	const chain = await readPgLedgerAddressChain(
		executor,
		target,
		request.plan.address,
	);
	const admissionInput = await liveAdmission(executor, request.plan, chain);
	const admission = request.destructiveDecision
		? await (async () => {
				const decision = await request.destructiveDecision!(
					executor,
					request.plan,
				);
				if (decision.kind !== 'destructive-decision-permitted')
					return refusal(decision.reasons.join('; '));
				return admitDestructiveOutcomeClaim({
					decision,
					admission: admissionInput,
				});
			})()
		: admitOutcomeClaim(admissionInput);
	if (admission.kind !== 'admitted-outcome-claim') return { admission, chain };
	await appendPgLedgerClaim(
		executor,
		target,
		claimMember(request, chain.terminalMember?.eventId),
		request.reservations,
	);
	return { admission, chain };
}

async function begin(
	executor: TransitionJournalQueryable,
	timeout: number | undefined,
) {
	await executor.query('BEGIN');
	await executor.query(
		`SET LOCAL lock_timeout = '${boundedLockTimeout(timeout)}ms'`,
	);
}

async function rollback(executor: TransitionJournalQueryable): Promise<void> {
	try {
		await executor.query('ROLLBACK');
	} catch (error) {
		// A failed rollback leaves transaction and protocol state unknowable.  The
		// outer outcome-session bracket consumes this marker at pool release.
		markPgOutcomeSessionCompromised(executor, error);
		// The original PostgreSQL words are the only useful refusal detail.
	}
}

function claimMember(
	request: PgOutcomeClaimRequest,
	predecessor: string | undefined,
): Omit<LedgerChainMember, 'controller' | 'recordedAt'> {
	return {
		eventId: request.plan.claimId,
		...(request.plan.executionId === undefined
			? {}
			: { executionId: request.plan.executionId }),
		...(request.plan.plannedClaimKey === undefined
			? {}
			: { plannedClaimKey: request.plan.plannedClaimKey }),
		...(request.plan.claimGroupId === undefined
			? {}
			: { claimGroupId: request.plan.claimGroupId }),
		...(request.plan.rootClaimId === undefined
			? {}
			: { rootClaimId: request.plan.rootClaimId }),
		address: request.plan.address,
		eventKind: request.plan.claimKind,
		...(predecessor === undefined ? {} : { predecessor }),
		...(request.plan.pairId === undefined
			? {}
			: { pairId: request.plan.pairId }),
		...(request.plan.declared === undefined
			? {}
			: { declared: request.plan.declared }),
	};
}

function resolutionMember(
	claim: AdmittedOutcomeClaim,
	resolution: PgOutcomeResolution,
	predecessor: string,
): Omit<LedgerChainMember, 'controller' | 'recordedAt'> {
	return {
		eventId: resolution.eventId,
		...(claim.plan.executionId === undefined
			? {}
			: { executionId: claim.plan.executionId }),
		...(claim.plan.plannedClaimKey === undefined
			? {}
			: { plannedClaimKey: claim.plan.plannedClaimKey }),
		...(claim.plan.claimGroupId === undefined
			? {}
			: { claimGroupId: claim.plan.claimGroupId }),
		...(claim.plan.rootClaimId === undefined
			? {}
			: { rootClaimId: claim.plan.rootClaimId }),
		address: claim.plan.address,
		eventKind: resolution.eventKind,
		predecessor,
		...(resolution.observed === undefined
			? {}
			: { observed: resolution.observed }),
		...(resolution.refusal === undefined
			? {}
			: { refusal: resolution.refusal }),
	};
}

function recoveryResolutionMember(
	address: LedgerAddress,
	eventId: string,
	resolution: Extract<
		OutcomeRecoveryClassification,
		{ readonly kind: 'outcome-recovery-append' }
	>['resolution'],
): Omit<LedgerChainMember, 'controller' | 'recordedAt'> {
	const readBack = resolution.readBack;
	return {
		eventId,
		address,
		eventKind: resolution.eventKind,
		predecessor: resolution.predecessor,
		...(resolution.refusal === undefined
			? {}
			: { refusal: resolution.refusal }),
		...(readBack.kind === 'present'
			? {
					catalogueIdentity: readBack.catalogueIdentity,
					observed: readBack.observed,
				}
			: {}),
	};
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
		.join(',')}}`;
}

async function observedResolutionMember(
	executor: TransitionJournalQueryable,
	claim: AdmittedOutcomeClaim,
	resolution: PgOutcomeResolution,
	predecessor: string,
	readBack: (executor: GeneratedPostconditionSession) => Promise<LedgerPayload>,
	recordCatalogueIdentity: boolean | undefined,
): Promise<Omit<LedgerChainMember, 'controller' | 'recordedAt'>> {
	const live = recordCatalogueIdentity
		? await readPgCatalogueIdentity(executor, claim.plan.address)
		: undefined;
	return {
		...resolutionMember(claim, resolution, predecessor),
		...(live?.catalogueIdentity
			? { catalogueIdentity: live.catalogueIdentity }
			: {}),
		observed: await readBack(mintGeneratedPostconditionSession(executor)),
	};
}

async function terminalResolutionMember(
	executor: TransitionJournalQueryable,
	request: PgOutcomeTransactionalRequest,
	claim: AdmittedOutcomeClaim,
	predecessor: string,
): Promise<Omit<LedgerChainMember, 'controller' | 'recordedAt'>> {
	if (!request.readBack)
		return resolutionMember(claim, request.resolution, predecessor);
	return observedResolutionMember(
		executor,
		claim,
		request.resolution,
		predecessor,
		request.readBack,
		request.recordCatalogueIdentity,
	);
}

function sameResolutionPayload(
	left: Omit<LedgerChainMember, 'controller' | 'recordedAt'>,
	right: LedgerChainMember,
): boolean {
	return (
		left.eventKind === right.eventKind &&
		left.predecessor === right.predecessor &&
		left.pairId === right.pairId &&
		canonicalJson(left.catalogueIdentity ?? null) ===
			canonicalJson(right.catalogueIdentity ?? null) &&
		canonicalJson(left.declared ?? null) ===
			canonicalJson(right.declared ?? null) &&
		canonicalJson(left.observed ?? null) ===
			canonicalJson(right.observed ?? null) &&
		canonicalJson(left.refusal ?? null) === canonicalJson(right.refusal ?? null)
	);
}

/**
 * Appends a resolution once, or treats an already-written equal payload as a
 * successful retry. A different child cannot be written by PostgreSQL's
 * one-child constraint and is reported as a fail-closed malformed outcome.
 */
export async function appendPgOutcomeResolution(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	member: Omit<LedgerChainMember, 'controller' | 'recordedAt'>,
	rootClaimId: string,
	reservations: readonly Pick<LedgerReservationRow, 'address'>[],
): Promise<PgOutcomeResolutionAppendResult> {
	try {
		if (member.eventKind === 'indeterminate')
			await appendPgLedgerProgress(executor, target, member);
		else
			await appendPgLedgerResolution(
				executor,
				target,
				member,
				rootClaimId,
				reservations,
			);
		return { kind: 'appended-outcome-resolution' };
	} catch (error) {
		const original = detail(error);
		let chain: Awaited<ReturnType<typeof readPgLedgerAddressChain>>;
		try {
			chain = await readPgLedgerAddressChain(executor, target, member.address);
		} catch {
			throw error;
		}
		const existing = chain.events.find(
			(event) => event.predecessor === member.predecessor,
		);
		if (!existing) throw error;
		if (sameResolutionPayload(member, existing))
			return { kind: 'already-appended-outcome-resolution' };
		return {
			kind: 'malformed-outcome-resolution',
			reason: `resolution predecessor ${member.predecessor ?? 'root'} has a differing terminal member after append failure: ${original}`,
		};
	}
}

async function appendOutcomeTerminal(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	member: Omit<LedgerChainMember, 'controller' | 'recordedAt'>,
	rootClaimId: string,
	reservations: readonly Pick<LedgerReservationRow, 'address'>[],
): Promise<void> {
	if (member.eventKind === 'indeterminate') {
		await appendPgLedgerProgress(executor, target, member);
		return;
	}
	await appendPgLedgerResolution(
		executor,
		target,
		member,
		rootClaimId,
		reservations,
	);
}

/** PostgreSQL catalogue read used by recovery before any ledger append. */
export async function readPgOutcomeRecoveryReadBack(
	executor: TransitionJournalQueryable,
	address: LedgerAddress,
	readBack: PgOutcomeReadBackFactory,
	operationReadBack?: PgOutcomeOperationReadBackFactory,
): Promise<OutcomeRecoveryReadBack> {
	const resource = await readPgCatalogueIdentity(executor, address);
	const operation = operationReadBack
		? await operationReadBack(executor, address, resource?.catalogueIdentity)
		: undefined;
	if (!resource?.catalogueIdentity)
		return {
			kind: 'absent',
			...(operation === undefined ? {} : { effect: operation.effect }),
		};
	return {
		kind: 'present',
		catalogueIdentity: resource.catalogueIdentity,
		observed:
			operation?.observed ??
			(await readBack(
				mintGeneratedPostconditionSession(executor),
				address,
				resource.catalogueIdentity,
			)),
		...(operation === undefined ? {} : { effect: operation.effect }),
	};
}

/** Opens a claim under its closure locks and commits it with its reservations. */
async function openPgOutcomeClaimOnSession(
	executor: TransitionJournalQueryable,
	request: PgOutcomeClaimRequest,
	run?: PgLockedRun,
): Promise<OutcomeClaimAdmission> {
	let begun = false;
	try {
		await begin(executor, request.lockTimeoutMs);
		begun = true;
		const lock = await acquirePgLedgerLocks(executor, homesFor(request));
		if (lock.kind !== 'acquired') {
			await executor.query('ROLLBACK');
			begun = false;
			return refusal(
				lock.kind === 'busy'
					? `ledger advisory lock is busy for ${lock.ledger.scope}${lock.ledger.schema ? ` ${lock.ledger.schema}` : ''}`
					: detail(lock.error),
			);
		}
		await checkpoint(request.observer, 'post-lock-integrity-before-append');
		if (run) await createPostLockAdmissionEvidence(executor, lock.proof);
		const integrity = await validatePgLedgerRuntimeIntegrity(
			executor,
			homesFor(request),
			run,
		);
		if (integrity) {
			await executor.query('ROLLBACK');
			begun = false;
			return integrity;
		}
		const { admission } = await admitPgOutcomeClaim(executor, request);
		if (admission.kind !== 'admitted-outcome-claim') {
			await executor.query('ROLLBACK');
			begun = false;
			return admission;
		}
		await commitPgOutcome(executor, request.observer);
		begun = false;
		return admission;
	} catch (error) {
		if (begun) await rollback(executor);
		if (error instanceof PgCommitDeterministicFailureError) throw error;
		if (error instanceof PgCommitAcknowledgementAmbiguousError) throw error;
		markPgOutcomeSessionCompromised(executor, error);
		return refusal(detail(error));
	}
}

/** Opens a claim on one connection when supplied a PostgreSQL pool. */
export async function openPgOutcomeClaim(
	executor: TransitionJournalQueryable,
	request: PgOutcomeClaimRequest,
	run?: PgLockedRun,
): Promise<OutcomeClaimAdmission> {
	return withPgOutcomeSession(executor, (session) =>
		openPgOutcomeClaimOnSession(session, request, run),
	);
}

/**
 * Opens a root and all closure claims under globally ordered ledger locks in
 * one transaction.  No child is ever durable before its root group commits.
 */
export async function openPgOutcomeClaimGroup(
	executor: TransitionJournalQueryable,
	request: PgOutcomeClaimGroupRequest,
	run?: PgLockedRun,
): Promise<PgOutcomeClaimGroupAdmission> {
	return withPgOutcomeSession(executor, async (session) => {
		let begun = false;
		try {
			await begin(session, request.lockTimeoutMs);
			begun = true;
			const lock = await acquirePgLedgerLocks(session, homesForGroup(request));
			if (lock.kind !== 'acquired') {
				await session.query('ROLLBACK');
				begun = false;
				return { root: refusal('ledger advisory lock is busy'), members: [] };
			}
			const postLockEvidence = await createPostLockAdmissionEvidence(
				session,
				lock.proof,
			);
			const postLockLiveAdmission = await checkLiveAdmission(postLockEvidence);
			if ('kind' in postLockLiveAdmission) {
				await session.query('ROLLBACK');
				begun = false;
				return { root: postLockLiveAdmission, members: [] };
			}
			const integrity = await validatePgLedgerRuntimeIntegrity(
				session,
				homesForGroup(request),
				run,
			);
			if (integrity) {
				await session.query('ROLLBACK');
				begun = false;
				return { root: integrity, members: [] };
			}
			await checkpoint(request.observer, 'post-lock-integrity-before-append');
			const all = [request, ...request.members];
			const currencyHomes = homesForGroup(request);
			const seen = new Set<string>();
			for (const home of currencyHomes) {
				const key = `${home.scope}:${home.schema ?? ''}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const currency = await readPgLedgerScopeCurrency(session, home);
				if (currency.kind !== 'current') {
					await session.query('ROLLBACK');
					begun = false;
					return { root: currencyRefusal(currency), members: [] };
				}
			}
			const admissions: OutcomeClaimAdmission[] = [];
			const claims: Omit<LedgerChainMember, 'controller' | 'recordedAt'>[] = [];
			for (const item of all) {
				const chain = await readPgLedgerAddressChain(
					session,
					targetForPlan(item.plan),
					item.plan.address,
				);
				const input = await liveAdmission(session, item.plan, chain);
				const admission =
					item === request && request.destructiveDecision
						? await (async () => {
								const decision = await request.destructiveDecision!(
									session,
									request.plan,
								);
								return decision.kind === 'destructive-decision-permitted'
									? admitDestructiveOutcomeClaim({ decision, admission: input })
									: refusal(decision.reasons.join('; '));
							})()
						: admitOutcomeClaim(input);
				if (admission.kind !== 'admitted-outcome-claim') {
					await session.query('ROLLBACK');
					begun = false;
					return { root: admission, members: admissions.slice(1) };
				}
				admissions.push(admission);
				// This terminal comes from the locked transaction's live chain, not
				// from a planned lifecycle position. Each group address is unique.
				claims.push(claimMember(item, chain.terminalMember?.eventId));
			}
			await appendPgLedgerClaimGroup(session, claims[0]!, claims.slice(1), [
				...request.reservations,
				...request.members.flatMap((member) => member.reservations),
			]);
			await commitPgOutcome(session, request.observer);
			begun = false;
			return { root: admissions[0]!, members: admissions.slice(1) };
		} catch (error) {
			if (begun) await rollback(session);
			if (
				error instanceof PgCommitDeterministicFailureError ||
				error instanceof PgCommitAcknowledgementAmbiguousError
			)
				throw error;
			return { root: refusal(detail(error)), members: [] };
		}
	});
}

/** Resolves every member terminal atomically under the same ordered locks. */
export async function resolvePgOutcomeClaimGroup(
	executor: TransitionJournalQueryable,
	request: PgOutcomeClaimGroupResolution,
): Promise<undefined | OutcomeProtocolRefusal> {
	return withPgOutcomeSession(executor, async (session) => {
		let begun = false;
		try {
			await begin(session, request.lockTimeoutMs);
			begun = true;
			const lock = await acquirePgLedgerLocks(
				session,
				request.members.map(({ member }) => targetForAddress(member.address)),
			);
			if (lock.kind !== 'acquired') {
				await session.query('ROLLBACK');
				begun = false;
				return refusal('ledger advisory lock is busy');
			}
			const postLockEvidence = await createPostLockAdmissionEvidence(
				session,
				lock.proof,
			);
			const liveAdmission = await checkLiveAdmission(postLockEvidence);
			if ('kind' in liveAdmission) {
				await session.query('ROLLBACK');
				begun = false;
				return liveAdmission;
			}
			const integrity = await validatePgLedgerRuntimeIntegrity(
				session,
				request.members.map(({ member }) => targetForAddress(member.address)),
				request.runtimeIntegrityRun,
			);
			if (integrity) {
				await session.query('ROLLBACK');
				begun = false;
				return integrity;
			}
			await checkpoint(request.observer, 'post-lock-integrity-before-append');
			const members = await Promise.all(
				request.members.map(async ({ target, member }) =>
					memberWithCurrentTerminalPredecessor(session, target, member),
				),
			);
			if (members.every((member) => member.eventKind === 'indeterminate')) {
				// A readable partial destructive effect keeps every member's claim
				// open.  Reservations deliberately remain: another writer must not
				// turn this uncertainty into a competing lifecycle.
				for (const member of members)
					await appendPgLedgerProgress(
						session,
						targetForAddress(member.address),
						member,
					);
			} else {
				await appendPgLedgerResolutionGroup(
					session,
					request.rootClaimId,
					members,
					request.reservations,
				);
			}
			await commitPgOutcome(session, request.observer);
			begun = false;
			return undefined;
		} catch (error) {
			if (begun) await rollback(session);
			if (
				error instanceof PgCommitDeterministicFailureError ||
				error instanceof PgCommitAcknowledgementAmbiguousError
			)
				throw error;
			return refusal(detail(error));
		}
	});
}

async function claimIsOpen(
	executor: TransitionJournalQueryable,
	claim: AdmittedOutcomeClaim,
): Promise<OutcomeProtocolRefusal | undefined> {
	const chain = await readPgLedgerAddressChain(
		executor,
		targetForPlan(claim.plan),
		claim.plan.address,
	);
	const projection = projectLedgerChain(chain);
	if (projection.kind !== 'projected-ledger-chain')
		return refusal(
			`${claimSubject(claim.plan)} refuses malformed ledger chain: ${projection.reason.code}`,
		);
	if (projection.openClaim?.event.eventId !== claim.plan.claimId)
		return refusal(
			`claim token for ${claimSubject(claim.plan)} is no longer valid because its claim is closed`,
		);
	return undefined;
}

/**
 * Keep the reviewed claim's stable identity beside its opaque execution hash
 * on every token-gate failure. The hash alone cannot identify the failed
 * generator change when one reviewed run contains multiple claims.
 */
function claimSubject(plan: OutcomeClaimPlan): string {
	return `${plan.claimId} (plannedClaimKey ${plan.plannedClaimKey ?? 'unknown'}; claim kind ${plan.claimKind}; address ${plan.address.name})`;
}

/**
 * The only managed DDL sink in this layer. A token parameter is mandatory, and
 * it is consumed immediately before the first statement is sent.
 */
async function executePgManagedBundle(
	executor: TransitionJournalQueryable,
	request: PgOutcomeExecutionRequest,
): Promise<undefined | OutcomeProtocolRefusal> {
	const tokenClaimId = claimIdForToken(request.token);
	if (tokenClaimId !== request.claim.plan.claimId)
		return refusal(
			tokenClaimId === undefined
				? `claim token for ${claimSubject(request.claim.plan)} was not minted by claim admission`
				: `claim token belongs to claim ${tokenClaimId}, not ${claimSubject(request.claim.plan)}`,
		);
	const open = await claimIsOpen(executor, request.claim);
	if (open) return open;
	const consumption = consumeClaimToken(
		request.token,
		request.claim.plan.claimId,
		request.statements,
	);
	if ('kind' in consumption) return consumption;
	for (const statement of consumption.statements)
		await classifyPgWrite(() => executor.query(statement.sql));
}

/**
 * The final PostgreSQL sender accepts only an opaque permit minted by live
 * admission. Neither a caller-supplied claim nor a core claim token reaches
 * this boundary directly.
 */
async function sendPgAdmittedBundle(
	executor: TransitionJournalQueryable,
	request: {
		readonly permit: AdmittedPermit;
		readonly statements: readonly ClaimBundleStatement[];
	},
): Promise<undefined | OutcomeProtocolRefusal> {
	const claim = admittedClaim(request.permit);
	if (!claim) return refusal('managed DDL sender refuses an unadmitted permit');
	return executePgManagedBundle(executor, {
		token: claim.token,
		claim,
		statements: request.statements,
	});
}

/**
 * EFF-03 bridge endpoint for generator removals. Its required admission value
 * was minted by the sole authority interpreter and carries the claim token.
 */
async function executePgDestructiveBundle(
	executor: TransitionJournalQueryable,
	request: PgDestructiveOutcomeExecutionRequest,
): Promise<undefined | OutcomeProtocolRefusal> {
	if (!isDestructiveAuthorityPermit(request.claim.destructivePermit))
		return refusal(
			'destructive authority permit was not minted by the interpreter',
		);
	return executePgManagedBundle(executor, {
		token: request.claim.token,
		claim: request.claim,
		statements: request.statements,
	});
}

async function verifyCreationVacancy(
	executor: TransitionJournalQueryable,
	claim: AdmittedOutcomeClaim,
	reader: PgOutcomeTransactionalRequest['vacancy'],
): Promise<OutcomeProtocolRefusal | undefined> {
	if (claim.plan.requiresVacancy === false) return undefined;
	if (!reader)
		return refusal(
			`creation claim ${claim.plan.claimId} has no vacancy reader`,
		);
	const vacancy = await reader(executor, claim.plan);
	if (vacancy.kind === 'vacant') return undefined;
	return refusal(vacancy.reason);
}

async function refuseClaim(
	executor: TransitionJournalQueryable,
	claim: AdmittedOutcomeClaim,
	request: PgOutcomeClaimRequest,
	eventId: string,
	code: 'ERR-02' | 'ERR-05',
): Promise<void> {
	const target = targetForPlan(claim.plan);
	const predecessor = await currentTerminalPredecessor(
		executor,
		target,
		claim.plan.address,
	);
	if (!predecessor)
		throw new Error(`claim ${claim.plan.claimId} has no current terminal`);
	await appendPgLedgerResolution(
		executor,
		target,
		resolutionMember(
			claim,
			{
				eventId,
				eventKind: 'refused',
				refusal: refusalFor(code, {
					address: claim.plan.address,
					state: claim.stableStateBeforeClaim,
				}),
			},
			predecessor,
		),
		claim.plan.claimId,
		request.reservations,
	);
}

/** Claim, vacancy read, bundle send and resolution share one transaction. */
async function runPgTransactionalOutcomeOnSession(
	executor: TransitionJournalQueryable,
	request: PgOutcomeTransactionalRequest,
	verdicts: AdmissionVerdicts,
): Promise<PgOutcomeResult> {
	let begun = false;
	const ownsTransaction = !request.transactionOpen;
	try {
		if (ownsTransaction) {
			await begin(executor, request.lockTimeoutMs);
			begun = true;
		}
		const lock = await acquirePgLedgerLocks(executor, homesFor(request));
		if (lock.kind !== 'acquired') {
			if (ownsTransaction) await executor.query('ROLLBACK');
			begun = false;
			return refusal('ledger advisory lock is busy');
		}
		await checkpoint(request.observer, 'post-lock-integrity-before-append');
		const postLockEvidence = await createPostLockAdmissionEvidence(
			executor,
			lock.proof,
		);
		const liveAdmission = await checkLiveAdmission(postLockEvidence);
		if ('kind' in liveAdmission) {
			if (ownsTransaction) await executor.query('ROLLBACK');
			begun = false;
			return liveAdmission;
		}
		const integrity = await validatePgLedgerRuntimeIntegrity(
			executor,
			homesFor(request),
			verdicts.run,
		);
		if (integrity) {
			if (ownsTransaction) await executor.query('ROLLBACK');
			begun = false;
			return integrity;
		}
		const target = targetForPlan(request.plan);
		const { admission } = await admitPgOutcomeClaim(executor, request);
		if (admission.kind !== 'admitted-outcome-claim') {
			if (ownsTransaction) await executor.query('ROLLBACK');
			begun = false;
			return admission;
		}
		const liveAdmissionRefusal = request.verifyLiveAdmission
			? await request.verifyLiveAdmission(executor, admission.plan)
			: undefined;
		if (liveAdmissionRefusal) {
			await refuseClaim(
				executor,
				admission,
				request,
				request.resolution.eventId,
				'ERR-05',
			);
			if (ownsTransaction) await commitPgOutcome(executor, request.observer);
			begun = false;
			return liveAdmissionRefusal;
		}
		const vacancy = await verifyCreationVacancy(
			executor,
			admission,
			request.vacancy,
		);
		if (vacancy) {
			await refuseClaim(
				executor,
				admission,
				request,
				request.resolution.eventId,
				'ERR-02',
			);
			if (ownsTransaction) await commitPgOutcome(executor, request.observer);
			begun = false;
			return vacancy;
		}
		const permit = mintAdmittedPermit(
			admission,
			verdicts.digestBinding,
			verdicts.validatedManifest,
			verdicts.approvalScope,
			liveAdmission,
			postLockEvidence,
		);
		const sent =
			'destructivePermit' in admission
				? await executePgDestructiveBundle(executor, {
						claim: admission as AdmittedDestructiveOutcomeClaim,
						statements: admission.plan.statementBundle.statements,
					})
				: await sendPgAdmittedBundle(executor, {
						permit,
						statements: admission.plan.statementBundle.statements,
					});
		if (sent) throw new Error(sent.reason);
		await checkpoint(request.observer, 'ddl-completed-before-read-back');
		const predecessor = await currentTerminalPredecessor(
			executor,
			target,
			admission.plan.address,
		);
		if (!predecessor)
			throw new Error(
				`claim ${admission.plan.claimId} has no current terminal`,
			);
		await appendOutcomeTerminal(
			executor,
			target,
			await terminalResolutionMember(executor, request, admission, predecessor),
			request.plan.claimId,
			request.reservations,
		);
		if (ownsTransaction) await commitPgOutcome(executor, request.observer);
		begun = false;
		return { kind: 'executed-outcome-claim', claim: admission };
	} catch (error) {
		if (begun) await rollback(executor);
		if (error instanceof PgCommitDeterministicFailureError) throw error;
		if (error instanceof PgCommitAcknowledgementAmbiguousError) throw error;
		return refusal(detail(error));
	}
}

function sameStatementBundle(
	left: readonly ClaimBundleStatement[],
	right: readonly ClaimBundleStatement[],
): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

/** The paired sender accepts the same opaque permit boundary as every DDL sink. */
async function sendPgPairedReaddressBundle(
	executor: TransitionJournalQueryable,
	permit: AdmittedPermit,
	statements: readonly ClaimBundleStatement[],
): Promise<OutcomeProtocolRefusal | undefined> {
	const paired = admittedPermitRecords.get(permit)?.paired;
	if (!paired)
		return refusal('managed re-address sender refuses an unadmitted permit');
	if (!sameStatementBundle(paired.statements, statements))
		return refusal(
			`managed re-address sender refuses a bundle outside admitted pair ${paired.pairId}`,
		);
	for (const statement of paired.statements)
		await classifyPgWrite(() => executor.query(statement.sql));
	return undefined;
}

function homesForPairedReaddress(
	request: PgPairedReaddressOperation['request'],
): PgLedgerTarget[] {
	return request.members.flatMap((member) => [
		targetForAddress(member.source),
		targetForAddress(member.target),
	]);
}

async function currentControllerIdentity(
	executor: TransitionJournalQueryable,
): Promise<ControllerIdentity | OutcomeProtocolRefusal> {
	const role = await executor.query(
		'SELECT current_user AS current_user, current_user::regrole::oid::text AS current_user_oid',
	);
	const name = role.rows[0]?.current_user;
	const oid = role.rows[0]?.current_user_oid;
	return typeof name === 'string' && typeof oid === 'string'
		? { name, oid }
		: refusal('current controller identity is unreadable');
}

/** One paired admission, send and all paired terminals in one transaction. */
async function runPgPairedReaddressOperation(
	executor: TransitionJournalQueryable,
	request: PgPairedReaddressOperation['request'],
	verdicts: AdmissionVerdicts,
): Promise<PgAdmittedOperationResult> {
	let begun = false;
	let ddlMayHaveBeenSent = false;
	try {
		await begin(executor, request.lockTimeoutMs);
		begun = true;
		const homes = homesForPairedReaddress(request);
		const lock = await acquirePgLedgerLocks(executor, homes);
		if (lock.kind !== 'acquired') {
			await executor.query('ROLLBACK');
			begun = false;
			return refusal('ledger advisory lock is busy');
		}
		const liveAdmission = await checkLiveAdmission(
			await createPostLockAdmissionEvidence(executor, lock.proof),
		);
		if ('kind' in liveAdmission) {
			await executor.query('ROLLBACK');
			begun = false;
			return liveAdmission;
		}
		const integrity = await validatePgLedgerRuntimeIntegrity(
			executor,
			homes,
			verdicts.run,
		);
		if (integrity) {
			await executor.query('ROLLBACK');
			begun = false;
			return integrity;
		}
		await checkpoint(request.observer, 'post-lock-integrity-before-append');
		const seen = new Set<string>();
		for (const home of homes) {
			const key = `${home.scope}:${home.schema ?? ''}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const currency = await readPgLedgerScopeCurrency(executor, home);
			if (currency.kind !== 'current') {
				await executor.query('ROLLBACK');
				begun = false;
				return currencyRefusal(currency);
			}
		}
		const controller = await currentControllerIdentity(executor);
		if ('kind' in controller) {
			await executor.query('ROLLBACK');
			begun = false;
			return controller;
		}
		const live = await request.verifyLiveAdmission(executor, controller);
		if (live) {
			await executor.query('ROLLBACK');
			begun = false;
			return live;
		}
		if (request.members.length === 0) {
			await executor.query('ROLLBACK');
			begun = false;
			return refusal('re-address has no closure members');
		}
		for (const member of request.members) {
			for (const [address, eventId] of [
				[member.source, member.sourceClaimId],
				[member.target, member.targetClaimId],
			] as const) {
				const predecessor = await currentTerminalPredecessor(
					executor,
					targetForAddress(address),
					address,
				);
				const reservation = request.reservations.find(
					(candidate) =>
						sameLedgerAddress(candidate.address, address) &&
						candidate.rootClaimId === eventId,
				);
				if (!reservation) {
					await executor.query('ROLLBACK');
					begun = false;
					return refusal(
						`re-address pair ${request.pairId} has no reservation for ${address.name}`,
					);
				}
				await appendPgLedgerClaim(
					executor,
					targetForAddress(address),
					{
						eventId,
						executionId: request.executionId,
						rootClaimId: eventId,
						address,
						eventKind: 'readdress-intent',
						...(predecessor === undefined ? {} : { predecessor }),
						pairId: request.pairId,
					},
					[reservation],
				);
			}
		}
		ddlMayHaveBeenSent = true;
		const sent = await sendPgPairedReaddressBundle(
			executor,
			mintPairedReaddressPermit(
				request.pairId,
				request.statements,
				verdicts.digestBinding,
				verdicts.validatedManifest,
				verdicts.approvalScope,
				liveAdmission,
			),
			request.statements,
		);
		if (sent) throw new Error(sent.reason);
		await checkpoint(request.observer, 'ddl-completed-before-read-back');
		for (const member of request.members) {
			const liveTarget = await readPgCatalogueIdentity(executor, member.target);
			if (!liveTarget?.catalogueIdentity)
				throw new Error(
					`re-address target read-back is absent for ${member.target.name}`,
				);
			const sourceReservation = request.reservations.find(
				(candidate) =>
					sameLedgerAddress(candidate.address, member.source) &&
					candidate.rootClaimId === member.sourceClaimId,
			);
			const targetReservation = request.reservations.find(
				(candidate) =>
					sameLedgerAddress(candidate.address, member.target) &&
					candidate.rootClaimId === member.targetClaimId,
			);
			if (!sourceReservation || !targetReservation) {
				await executor.query('ROLLBACK');
				begun = false;
				return refusal(`re-address pair ${request.pairId} lost a reservation`);
			}
			await appendPgLedgerResolution(
				executor,
				targetForAddress(member.source),
				{
					eventId: `${member.sourceClaimId}:readdressed-to`,
					executionId: request.executionId,
					rootClaimId: member.sourceClaimId,
					address: member.source,
					eventKind: 'readdressed-to',
					predecessor: member.sourceClaimId,
					pairId: request.pairId,
				},
				member.sourceClaimId,
				[sourceReservation],
			);
			await appendPgLedgerResolution(
				executor,
				targetForAddress(member.target),
				{
					eventId: `${member.targetClaimId}:readdressed-from`,
					executionId: request.executionId,
					rootClaimId: member.targetClaimId,
					address: member.target,
					eventKind: 'readdressed-from',
					predecessor: member.targetClaimId,
					pairId: request.pairId,
					catalogueIdentity: liveTarget.catalogueIdentity,
					declared: member.targetDeclared,
					observed: member.targetObserved,
				},
				member.targetClaimId,
				[targetReservation],
			);
		}
		await commitPgOutcome(executor, request.observer);
		begun = false;
		return { kind: 'executed-paired-readdress', pairId: request.pairId };
	} catch (error) {
		if (begun) await rollback(executor);
		if (error instanceof PgCommitDeterministicFailureError) throw error;
		if (error instanceof PgCommitAcknowledgementAmbiguousError)
			if (ddlMayHaveBeenSent)
				return {
					kind: 'outcome-recovery-required',
					claimId: request.members[0]?.sourceClaimId ?? request.pairId,
					reason: error.message,
				};
		if (ddlMayHaveBeenSent)
			return {
				kind: 'outcome-recovery-required',
				claimId: request.members[0]?.sourceClaimId ?? request.pairId,
				reason: detail(error),
			};
		if (error instanceof PgCommitAcknowledgementAmbiguousError)
			return { kind: 'outcome-transport-ambiguous', reason: error.message };
		markPgOutcomeSessionCompromised(executor, error);
		return refusal(detail(error));
	}
}

interface AdmissionVerdicts {
	readonly digestBinding: DigestBindingVerdict;
	readonly validatedManifest: ValidatedManifestVerdict;
	readonly approvalScope: ApprovalScopeVerdict;
	/** Compatibility-only until direct runners receive durable run witnesses. */
	readonly liveAdmission?: LiveAdmissionVerdict;
	/** Enables one physical validation per locked run/home on this session. */
	readonly run?: PgLockedRun;
}

function operationApprovalSubject(operation: PgAdmittedOperation):
	| {
			readonly address: LedgerAddress;
			readonly classification: AdmissionOperationClassification;
	  }
	| OutcomeProtocolRefusal {
	if (operation.kind === 'single-outcome')
		return {
			address: operation.request.plan.address,
			classification: operation.kind,
		};
	if (operation.kind === 'destructive-outcome')
		return {
			address: operation.request.plan.address,
			classification: operation.kind,
		};
	const root = operation.request.members.find((member) =>
		sameLedgerAddress(member.source, operation.request.manifestPlan.address),
	);
	if (!root)
		return refusal(
			`re-address closure has no declared root ${operation.request.manifestPlan.address.name}`,
		);
	return {
		address: root.source,
		classification: operation.kind,
	};
}

export function checkDigestBinding(input: {
	readonly run: PgLockedRun;
	readonly recomputedPlanDigest?: string;
}): DigestBindingVerdict | OutcomeProtocolRefusal {
	if (!lockedRuns.has(input.run))
		return refusal('admitted operation refuses an unbound locked journal run');
	if (input.recomputedPlanDigest !== input.run.planDigest)
		return refusal(
			'admitted operation refuses a mismatched recomputed plan digest',
		);
	return mintDigestBindingVerdict();
}

export function checkValidatedManifest(input: {
	readonly manifest?: ValidatedManagedStepManifest;
	/** Plans whose claim keys are declared by the reviewed manifest. */
	readonly expectedPlans: readonly OutcomeClaimPlan[];
	/**
	 * Live closure members supplement legacy root-only manifests. They may record
	 * absent facts, but they cannot introduce SQL outside the manifest.
	 */
	readonly supplementalPlans?: readonly OutcomeClaimPlan[];
	/** The façade, unlike a bare plan, knows which operation class is admitted. */
	readonly expectedClassification?:
		| 'non-destructive'
		| 'removal'
		| 'data-destructive';
}): ValidatedManifestVerdict | OutcomeProtocolRefusal {
	if (input.expectedPlans.length === 0)
		return refusal(
			'admitted operation refuses a manifest check without an expected plan',
		);
	const supplementalNotCascadeCovered = input.supplementalPlans?.find(
		(plan) => plan.claimSpecies !== 'cascade-covered',
	);
	if (supplementalNotCascadeCovered)
		return refusal(
			`admitted operation refuses supplemental closure member ${supplementalNotCascadeCovered.plannedClaimKey ?? supplementalNotCascadeCovered.address.name} that is not cascade-covered`,
		);
	const supplementalWithSql = input.supplementalPlans?.find(
		(plan) => plan.statementBundle.statements.length !== 0,
	);
	if (supplementalWithSql)
		return refusal(
			`admitted operation refuses supplemental closure member ${supplementalWithSql.plannedClaimKey ?? supplementalWithSql.address.name} with a non-empty statement bundle`,
		);
	const manifest = input.manifest;
	const manifestValid =
		manifest !== undefined &&
		input.expectedPlans.every((plan) =>
			manifest.steps.some((step) => {
				return (
					step.plannedClaimKeys.includes(plan.plannedClaimKey ?? '') &&
					step.address !== undefined &&
					sameLedgerAddress(step.address, plan.address) &&
					step.claimKind === plan.claimKind &&
					(input.expectedClassification === undefined ||
						step.classification === input.expectedClassification) &&
					step.requiresVacancy === (plan.requiresVacancy ?? false) &&
					step.statementBundle.statements.length ===
						plan.statementBundle.statements.length &&
					step.statementBundle.statements.every(
						(statement, index) =>
							plan.statementBundle.statements[index]?.ordinal ===
								statement.ordinal &&
							plan.statementBundle.statements[index]?.sql === statement.sql,
					)
				);
			}),
		);
	if (!manifestValid)
		return refusal(
			'admitted operation refuses an unvalidated managed-step manifest',
		);
	return mintValidatedManifestVerdict();
}

export function checkApprovalScope(input: {
	readonly run: PgLockedRun;
	readonly approval: ScopedApprovalSet;
	readonly operation: PgAdmittedOperation;
}): ApprovalScopeVerdict | OutcomeProtocolRefusal {
	const subject = operationApprovalSubject(input.operation);
	if ('kind' in subject) return subject;
	if (input.operation.kind === 'destructive-outcome') {
		const destructiveAcceptances = input.approval.approvals.filter(
			(grant) =>
				grant.class === `destructive-plan-accepted:${input.run.planDigest}`,
		);
		if (destructiveAcceptances.length === 0)
			return refusal('operator acceptance is absent');
		const accepted = destructiveAcceptances.some((grant) => {
			const scope = grant.withinScope;
			const inScope =
				scope === undefined ||
				scope.length === 0 ||
				scope.some((selector) =>
					selectorMatchesResource(selector, subject.address),
				);
			const expectedRoot = input.approval.declaredTrustRoot;
			const trustRootChecked =
				expectedRoot === undefined
					? grant.fromTrustRoot === undefined
					: grant.fromTrustRoot !== undefined &&
						canonicalJson(grant.fromTrustRoot) === canonicalJson(expectedRoot);
			return inScope && trustRootChecked;
		});
		if (!accepted)
			return refusal(
				'admitted operation refuses destructive approval outside its scope or trust root',
			);
	}
	return mintApprovalScopeVerdict(subject.address, subject.classification);
}

export async function checkLiveAdmission(
	evidence: PostLockAdmissionEvidence,
): Promise<LiveAdmissionVerdict | OutcomeProtocolRefusal> {
	try {
		return mintLiveAdmissionVerdict(evidence);
	} catch (error) {
		return refusal(detail(error));
	}
}

/**
 * The public PostgreSQL admitted-execution boundary. It is intentionally not
 * used by legacy paths yet: later dispatches bind their persisted runs and
 * operation shapes here without changing this authority surface.
 */
export async function executePgAdmittedOperation(
	session: TransitionJournalQueryable,
	input: {
		readonly run: PgLockedRun;
		readonly operation: PgAdmittedOperation;
		readonly approval: ScopedApprovalSet;
		/** Branded proof that the operation came from the normalized manifest. */
		readonly manifest?: ValidatedManagedStepManifest;
		/** Recomputed from the durable plan while the caller owns its run lock. */
		readonly recomputedPlanDigest?: string;
	},
): Promise<PgAdmittedOperationResult> {
	try {
		const { expectedPlans, supplementalPlans } =
			input.operation.kind === 'paired-readdress'
				? {
						expectedPlans: [input.operation.request.manifestPlan],
						supplementalPlans: [],
					}
				: input.operation.kind === 'destructive-outcome'
					? {
							expectedPlans: [input.operation.request.plan],
							supplementalPlans: input.operation.request.members.map(
								(member) => member.plan,
							),
						}
					: {
							expectedPlans: [input.operation.request.plan],
							supplementalPlans: [],
						};
		const digestBinding = checkDigestBinding(input);
		if ('kind' in digestBinding) return digestBinding;
		const validatedManifest = checkValidatedManifest({
			expectedPlans,
			supplementalPlans,
			...(input.manifest === undefined ? {} : { manifest: input.manifest }),
		});
		if ('kind' in validatedManifest) return validatedManifest;
		const approvalScope = checkApprovalScope(input);
		if ('kind' in approvalScope) return approvalScope;
		return await withPgOutcomeSession(session, async (pinnedSession) => {
			const verdicts: AdmissionVerdicts = {
				digestBinding,
				validatedManifest,
				approvalScope,
				run: input.run,
			};
			if (input.operation.kind === 'paired-readdress')
				return runPgPairedReaddressOperation(
					pinnedSession,
					input.operation.request,
					verdicts,
				);
			if (input.operation.kind === 'destructive-outcome')
				return runPgDestructiveOutcome(
					pinnedSession,
					input.operation.request,
					input.run,
					input.operation.readBackAndResolve,
				);
			return 'executingEventId' in input.operation.request
				? runPgNonTransactionalOutcomeOnSession(
						pinnedSession,
						input.operation.request,
						verdicts,
					)
				: runPgTransactionalOutcomeOnSession(
						pinnedSession,
						input.operation.request,
						verdicts,
					);
		});
	} catch (error) {
		if (error instanceof PgCommitDeterministicFailureError) throw error;
		if (error instanceof PgCommitAcknowledgementAmbiguousError)
			return { kind: 'outcome-transport-ambiguous', reason: error.message };
		return refusal(detail(error));
	}
}

/**
 * Commits claim first, then commits executing before invoking the token-gated
 * sender. The optional checkpoint makes that inter-commit/send boundary
 * observable to recovery tests without changing the production sequence.
 */
async function runPgNonTransactionalOutcomeOnSession(
	executor: TransitionJournalQueryable,
	request: PgOutcomeNonTransactionalRequest,
	verdicts: AdmissionVerdicts,
): Promise<PgOutcomeResult> {
	const admission = await openPgOutcomeClaimOnSession(
		executor,
		request,
		verdicts.run,
	);
	if (admission.kind !== 'admitted-outcome-claim') return admission;
	let executingCommitted = false;
	const recoveryRequired = (reason: string): PgOutcomeResult => ({
		kind: 'outcome-recovery-required',
		claimId: admission.plan.claimId,
		reason,
	});
	try {
		await begin(executor, request.lockTimeoutMs);
		const executingLock = await acquirePgLedgerLocks(
			executor,
			homesFor(request),
		);
		if (executingLock.kind !== 'acquired') {
			await rollback(executor);
			return refusal('ledger advisory lock is busy');
		}
		await checkpoint(request.observer, 'post-lock-integrity-before-append');
		const executingPostLockEvidence = await createPostLockAdmissionEvidence(
			executor,
			executingLock.proof,
		);
		const executingLiveAdmission = await checkLiveAdmission(
			executingPostLockEvidence,
		);
		if ('kind' in executingLiveAdmission) {
			await rollback(executor);
			return executingLiveAdmission;
		}
		const executingIntegrity = await validatePgLedgerRuntimeIntegrity(
			executor,
			homesFor(request),
			verdicts.run,
		);
		if (executingIntegrity) {
			await rollback(executor);
			return executingIntegrity;
		}
		const target = targetForPlan(request.plan);
		const liveAdmissionRefusal = request.verifyLiveAdmission
			? await request.verifyLiveAdmission(executor, admission.plan)
			: undefined;
		const vacancy = liveAdmissionRefusal
			? undefined
			: await verifyCreationVacancy(executor, admission, request.vacancy);
		if (liveAdmissionRefusal || vacancy) {
			await rollback(executor);
			await begin(executor, request.lockTimeoutMs);
			const terminalLock = await acquirePgLedgerLocks(
				executor,
				homesFor(request),
			);
			if (terminalLock.kind !== 'acquired') {
				await rollback(executor);
				return refusal('ledger advisory lock is busy');
			}
			await checkpoint(request.observer, 'post-lock-integrity-before-append');
			await createPostLockAdmissionEvidence(executor, terminalLock.proof);
			await refuseClaim(
				executor,
				admission,
				request,
				request.resolution.eventId,
				liveAdmissionRefusal ? 'ERR-05' : 'ERR-02',
			);
			await commitPgOutcome(executor, request.observer);
			return liveAdmissionRefusal ?? vacancy!;
		}
		const executingPredecessor = await currentTerminalPredecessor(
			executor,
			target,
			admission.plan.address,
		);
		if (!executingPredecessor)
			throw new Error(
				`claim ${admission.plan.claimId} has no current terminal`,
			);
		await appendPgLedgerProgress(executor, target, {
			eventId: request.executingEventId,
			...(admission.plan.executionId === undefined
				? {}
				: { executionId: admission.plan.executionId }),
			...(admission.plan.plannedClaimKey === undefined
				? {}
				: { plannedClaimKey: admission.plan.plannedClaimKey }),
			...(admission.plan.claimGroupId === undefined
				? {}
				: { claimGroupId: admission.plan.claimGroupId }),
			...(admission.plan.rootClaimId === undefined
				? {}
				: { rootClaimId: admission.plan.rootClaimId }),
			address: request.plan.address,
			eventKind: 'executing',
			predecessor: executingPredecessor,
		});
		await commitPgOutcome(executor, request.observer);
		executingCommitted = true;
		await request.onExecutingCommitted?.();
		const sent = await sendPgAdmittedBundle(executor, {
			permit: mintAdmittedPermit(
				admission,
				verdicts.digestBinding,
				verdicts.validatedManifest,
				verdicts.approvalScope,
				executingLiveAdmission,
				executingPostLockEvidence,
			),
			statements: admission.plan.statementBundle.statements,
		});
		if (sent) return recoveryRequired(sent.reason);
		await checkpoint(request.observer, 'ddl-completed-before-read-back');
		await begin(executor, request.lockTimeoutMs);
		const terminalLock = await acquirePgLedgerLocks(
			executor,
			homesFor(request),
		);
		if (terminalLock.kind !== 'acquired') {
			await rollback(executor);
			return recoveryRequired('ledger advisory lock is busy');
		}
		await checkpoint(request.observer, 'post-lock-integrity-before-append');
		await createPostLockAdmissionEvidence(executor, terminalLock.proof);
		const terminalIntegrity = await validatePgLedgerRuntimeIntegrity(
			executor,
			homesFor(request),
			verdicts.run,
		);
		if (terminalIntegrity) {
			await rollback(executor);
			return recoveryRequired(terminalIntegrity.reason);
		}
		const terminalPredecessor = await currentTerminalPredecessor(
			executor,
			target,
			admission.plan.address,
		);
		if (!terminalPredecessor)
			throw new Error(
				`claim ${admission.plan.claimId} has no current terminal`,
			);
		await appendOutcomeTerminal(
			executor,
			target,
			await terminalResolutionMember(
				executor,
				request,
				admission,
				terminalPredecessor,
			),
			request.plan.claimId,
			request.reservations,
		);
		await commitPgOutcome(executor, request.observer);
		return { kind: 'executed-outcome-claim', claim: admission };
	} catch (error) {
		await rollback(executor);
		if (error instanceof PgCommitDeterministicFailureError) throw error;
		if (error instanceof PgCommitAcknowledgementAmbiguousError)
			if (executingCommitted) return recoveryRequired(error.message);
		if (error instanceof PgCommitAcknowledgementAmbiguousError)
			return { kind: 'outcome-transport-ambiguous', reason: error.message };
		if (executingCommitted) {
			markPgOutcomeSessionCompromised(executor, error);
			return recoveryRequired(detail(error));
		}
		markPgOutcomeSessionCompromised(executor, error);
		return refusal(detail(error));
	}
}

/**
 * Reads an address's chain and live catalogue in one locked transaction before
 * appending the core classifier's instruction. It never calls the DDL sink.
 */
export async function recoverPgOutcomeClaim(
	executor: TransitionJournalQueryable,
	request: PgOutcomeRecoveryRequest,
): Promise<PgOutcomeRecoveryResult> {
	return withPgOutcomeSession(executor, (session) =>
		recoverPgOutcomeClaimOnSession(session, request),
	);
}

async function recoverPgOutcomeClaimOnSession(
	executor: TransitionJournalQueryable,
	request: PgOutcomeRecoveryRequest,
): Promise<PgOutcomeRecoveryResult> {
	let begun = false;
	try {
		if (request.reservations.length === 0)
			return refusal(
				'outcome recovery reservation subset is not the live open claim',
			);
		await begin(executor, request.lockTimeoutMs);
		begun = true;
		const target = targetForAddress(request.address, 'recovery target');
		const homes = [target];
		for (const reservation of request.reservations) {
			if (reservation.address.scope === 'database')
				homes.push({ scope: 'database' });
			else if (reservation.address.schema)
				homes.push({ scope: 'schema', schema: reservation.address.schema });
			else
				throw new Error(
					`schema-scoped recovery reservation ${reservation.address.name} has no schema address`,
				);
		}
		const lock = await acquirePgLedgerLocks(executor, homes);
		if (lock.kind !== 'acquired') {
			await executor.query('ROLLBACK');
			begun = false;
			return refusal(
				lock.kind === 'busy'
					? 'ledger advisory lock is busy'
					: detail(lock.error),
			);
		}
		let postLockEvidence: PostLockAdmissionEvidence;
		try {
			postLockEvidence = await createPostLockAdmissionEvidence(
				executor,
				lock.proof,
				undefined,
				request.ledgerShapeAllowance,
			);
		} catch (error) {
			if (
				error instanceof PgLedgerPhysicalShapeValidationError &&
				error.outcome.kind !== 'shape-wrong'
			) {
				// The session can be gone with the catalogue read, so its rollback
				// acknowledgement is not evidence against the pending outcome.
				await rollback(executor);
				begun = false;
				return {
					kind: 'outcome-recovery-pending',
					address: request.address,
					reason: detail(error),
					reasonCode: 'catalogue-unavailable',
				};
			}
			throw error;
		}
		const liveAdmission = await checkLiveAdmission(postLockEvidence);
		if ('kind' in liveAdmission) {
			await executor.query('ROLLBACK');
			begun = false;
			return liveAdmission;
		}
		const integrity = await validatePgLedgerRuntimeIntegrity(executor, homes);
		if (integrity) {
			await executor.query('ROLLBACK');
			begun = false;
			return integrity;
		}
		const currencyHomes = new Set<string>();
		for (const home of homes) {
			const homeKey = `${home.scope}:${home.schema ?? ''}`;
			if (currencyHomes.has(homeKey)) continue;
			currencyHomes.add(homeKey);
			const currency = await readPgLedgerScopeCurrency(executor, home);
			if (currency.kind !== 'current') {
				await executor.query('ROLLBACK');
				begun = false;
				return currencyRefusal(currency);
			}
		}
		const chain = await readPgLedgerAddressChain(
			executor,
			target,
			request.address,
		);
		const classification = await classifyOutcomeRecovery({
			projection: projectLedgerChain(chain),
			acceptedExternalDdlExclusion: request.acceptedExternalDdlExclusion,
			...(request.resolveIndeterminate === undefined
				? {}
				: { resolveIndeterminate: request.resolveIndeterminate }),
			...(request.indeterminateEvidence === undefined
				? {}
				: { indeterminateEvidence: request.indeterminateEvidence }),
			catalogue: async (address) => {
				try {
					return await readPgOutcomeRecoveryReadBack(
						executor,
						address,
						request.readBack,
						request.operationReadBack,
					);
				} catch (error) {
					return { kind: 'catalogue-unavailable', reason: detail(error) };
				}
			},
		});
		if (classification.kind !== 'outcome-recovery-append') {
			try {
				await commitPgOutcome(executor, request.observer);
				begun = false;
			} catch (error) {
				// A lost catalogue session cannot append anyway. Preserve the
				// classifier's pending result rather than replacing it with a
				// transaction-cleanup failure after the read has failed.
				if (classification.kind !== 'outcome-recovery-pending') throw error;
				begun = false;
			}
			return classification;
		}
		// Recovery is also an admitted resolution: bind the append to the live
		// open claim and its complete reservation subset rather than accepting a
		// caller-supplied terminal alone.
		const projection = projectLedgerChain(chain);
		const rootClaimId = classification.resolution.rootClaimId;
		if (
			projection.kind !== 'projected-ledger-chain' ||
			projection.openClaim?.event.eventId !== rootClaimId ||
			request.reservations.length === 0 ||
			!request.reservations.some((row) =>
				sameLedgerAddress(row.address, request.address),
			)
		) {
			await executor.query('ROLLBACK');
			begun = false;
			return refusal(
				'outcome recovery reservation subset is not the live open claim',
			);
		}
		const append = await appendPgOutcomeResolution(
			executor,
			target,
			recoveryResolutionMember(
				request.address,
				request.resolutionEventId,
				classification.resolution,
			),
			classification.resolution.rootClaimId,
			request.reservations,
		);
		if (append.kind === 'malformed-outcome-resolution') {
			await executor.query('ROLLBACK');
			begun = false;
			return refusal(append.reason);
		}
		await commitPgOutcome(executor, request.observer);
		begun = false;
		return { kind: 'outcome-recovery-appended', classification, append };
	} catch (error) {
		if (begun) await rollback(executor);
		if (error instanceof PgCommitDeterministicFailureError) throw error;
		if (error instanceof PgCommitAcknowledgementAmbiguousError)
			return { kind: 'outcome-transport-ambiguous', reason: error.message };
		markPgOutcomeSessionCompromised(executor, error);
		return refusal(detail(error));
	}
}
