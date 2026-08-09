import { classifyOutcomeRecovery, projectLedgerChain } from '@dbsp/core';
import type { AdmittedDestructiveOutcomeClaim } from '@dbsp/core/internal';
import {
	admitDestructiveOutcomeClaim,
	admitOutcomeClaim,
	claimIdForToken,
	consumeClaimToken,
	isDestructiveAuthorityPermit,
} from '@dbsp/core/internal';
import type {
	AdmittedOutcomeClaim,
	ClaimBundleStatement,
	ClaimToken,
	DestructiveDecision,
	LedgerAddress,
	LedgerChainMember,
	LedgerEventKind,
	LedgerPayload,
	LedgerReservationRow,
	OutcomeClaimAdmission,
	OutcomeClaimPlan,
	OutcomeProtocolRefusal,
	OutcomeRecoveryClassification,
	OutcomeRecoveryEffect,
	OutcomeRecoveryReadBack,
	OutcomeVacancy,
} from '@dbsp/types';
import { refusalFor } from '@dbsp/types';
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
	type PgLedgerTarget,
} from './ledger.js';
import { readPgLedgerScopeCurrency } from './reinitialize-preflight.js';

const DEFAULT_LOCK_TIMEOUT_MS = 5000;

type ReleasableTransitionJournalQueryable = TransitionJournalQueryable & {
	release(): void;
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
	try {
		return await work(session);
	} finally {
		session.release();
	}
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
			if (commitAttempted)
				throw new PgCommitAcknowledgementAmbiguousError(error);
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

export interface PgOutcomeClaimRequest {
	readonly plan: OutcomeClaimPlan;
	readonly reservations: readonly LedgerReservationRow[];
	readonly lockTimeoutMs?: number;
	/** Destructive authority is evaluated under these same ledger locks. */
	readonly destructiveDecision?: (
		executor: TransitionJournalQueryable,
		plan: OutcomeClaimPlan,
	) => Promise<DestructiveDecision>;
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
	| OutcomeProtocolRefusal
	| { readonly kind: 'outcome-transport-ambiguous'; readonly reason: string };

/**
 * High-level managed destructive execution. It owns claim admission and the
 * token-gated PostgreSQL sender so callers cannot compose raw ledger writes
 * with a fabricated capability.
 */
export async function executePgDestructiveOutcome(
	executor: TransitionJournalQueryable,
	request: PgOutcomeClaimGroupRequest,
	readBackAndResolve: (
		executor: TransitionJournalQueryable,
		claim: AdmittedDestructiveOutcomeClaim,
	) => Promise<PgOutcomeClaimGroupResolution>,
): Promise<PgDestructiveOutcomeResult> {
	return withPgOutcomeSession(executor, async (session) => {
		const admission =
			request.members.length > 0
				? (await openPgOutcomeClaimGroup(session, request)).root
				: await openPgOutcomeClaim(session, request);
		if (admission.kind !== 'admitted-outcome-claim') return admission;
		if (!('destructivePermit' in admission))
			return refusal('destructive admission did not mint an authority permit');
		try {
			// Persist the send boundary before the first autocommitted statement.
			await begin(session, request.lockTimeoutMs);
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
				await session.query('COMMIT');
			} catch (error) {
				return {
					kind: 'outcome-transport-ambiguous',
					reason: new PgCommitAcknowledgementAmbiguousError(error).message,
				};
			}
			const sent = await executePgDestructiveBundle(session, {
				claim: admission as AdmittedDestructiveOutcomeClaim,
				statements: request.plan.statementBundle.statements,
			});
			if (sent) return sent;
			const resolution = await readBackAndResolve(
				session,
				admission as AdmittedDestructiveOutcomeClaim,
			);
			const resolved = await resolvePgDestructiveOutcome(session, resolution);
			return resolved ?? { kind: 'executed-destructive-outcome' };
		} catch (error) {
			await rollback(session);
			if (error instanceof PgCommitAcknowledgementAmbiguousError)
				return { kind: 'outcome-transport-ambiguous', reason: error.message };
			return refusal(detail(error));
		}
	});
}

/** Keeps terminal appends and reservation release behind the managed facade. */
export async function resolvePgDestructiveOutcome(
	executor: TransitionJournalQueryable,
	request: PgOutcomeClaimGroupResolution,
): Promise<undefined | OutcomeProtocolRefusal> {
	if (request.members.length > 1)
		return resolvePgOutcomeClaimGroup(executor, request);
	const terminal = request.members[0];
	if (!terminal) return refusal('destructive outcome has no terminal member');
	try {
		const member = await memberWithCurrentTerminalPredecessor(
			executor,
			terminal.target,
			terminal.member,
		);
		await appendPgLedgerResolution(
			executor,
			terminal.target,
			member,
			request.rootClaimId,
			request.reservations,
		);
		return undefined;
	} catch (error) {
		return refusal(detail(error));
	}
}

export interface PgOutcomeTransactionalRequest extends PgOutcomeClaimRequest {
	readonly resolution: PgOutcomeResolution;
	/** Core has already opened the segment transaction; never nest BEGIN. */
	readonly transactionOpen?: boolean;
	/** Operation-owned terminal read-back; generic catalogue identity is not evidence. */
	readonly readBack?: () => Promise<LedgerPayload>;
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
	executor: TransitionJournalQueryable,
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
	readonly resolveIndeterminate?: boolean;
	readonly readBack: PgOutcomeReadBackFactory;
	readonly operationReadBack?: PgOutcomeOperationReadBackFactory;
	readonly lockTimeoutMs?: number;
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
	| OutcomeProtocolRefusal;

export type PgOutcomeResult =
	| {
			readonly kind: 'executed-outcome-claim';
			readonly claim: AdmittedOutcomeClaim;
	  }
	| OutcomeProtocolRefusal;

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
	const role = await executor.query('SELECT current_user AS current_user');
	const currentUser = role.rows[0]?.current_user;
	const live = await readPgCatalogueIdentity(executor, plan.address);
	return {
		plan,
		projection,
		...(typeof currentUser === 'string' ? { currentUser } : {}),
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
	} catch {
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
	readBack: () => Promise<LedgerPayload>,
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
		observed: await readBack(),
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
			(await readBack(executor, address, resource.catalogueIdentity)),
		...(operation === undefined ? {} : { effect: operation.effect }),
	};
}

/** Opens a claim under its closure locks and commits it with its reservations. */
async function openPgOutcomeClaimOnSession(
	executor: TransitionJournalQueryable,
	request: PgOutcomeClaimRequest,
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
		const { admission } = await admitPgOutcomeClaim(executor, request);
		if (admission.kind !== 'admitted-outcome-claim') {
			await executor.query('ROLLBACK');
			begun = false;
			return admission;
		}
		await executor.query('COMMIT');
		begun = false;
		return admission;
	} catch (error) {
		if (begun) await rollback(executor);
		return refusal(detail(error));
	}
}

/** Opens a claim on one connection when supplied a PostgreSQL pool. */
export async function openPgOutcomeClaim(
	executor: TransitionJournalQueryable,
	request: PgOutcomeClaimRequest,
): Promise<OutcomeClaimAdmission> {
	return withPgOutcomeSession(executor, (session) =>
		openPgOutcomeClaimOnSession(session, request),
	);
}

/**
 * Opens a root and all closure claims under globally ordered ledger locks in
 * one transaction.  No child is ever durable before its root group commits.
 */
export async function openPgOutcomeClaimGroup(
	executor: TransitionJournalQueryable,
	request: PgOutcomeClaimGroupRequest,
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
			await session.query('COMMIT');
			begun = false;
			return { root: admissions[0]!, members: admissions.slice(1) };
		} catch (error) {
			if (begun) await rollback(session);
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
			const members = await Promise.all(
				request.members.map(async ({ target, member }) =>
					memberWithCurrentTerminalPredecessor(session, target, member),
				),
			);
			await appendPgLedgerResolutionGroup(
				session,
				request.rootClaimId,
				members,
				request.reservations,
			);
			await session.query('COMMIT');
			begun = false;
			return undefined;
		} catch (error) {
			if (begun) await rollback(session);
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
export async function executePgManagedBundle(
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
 * EFF-03 bridge endpoint for generator removals. Its required admission value
 * was minted by the sole authority interpreter and carries the claim token.
 */
export async function executePgDestructiveBundle(
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
			if (ownsTransaction) await executor.query('COMMIT');
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
			if (ownsTransaction) await executor.query('COMMIT');
			begun = false;
			return vacancy;
		}
		const sent =
			'destructivePermit' in admission
				? await executePgDestructiveBundle(executor, {
						claim: admission as AdmittedDestructiveOutcomeClaim,
						statements: admission.plan.statementBundle.statements,
					})
				: await executePgManagedBundle(executor, {
						token: admission.token,
						claim: admission,
						statements: admission.plan.statementBundle.statements,
					});
		if (sent) throw new Error(sent.reason);
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
		if (ownsTransaction) await executor.query('COMMIT');
		begun = false;
		return { kind: 'executed-outcome-claim', claim: admission };
	} catch (error) {
		if (begun) await rollback(executor);
		return refusal(detail(error));
	}
}

/**
 * Runs the transactional outcome protocol on a connection pinned for its
 * whole claim/token/terminal lifecycle.
 */
export async function runPgTransactionalOutcome(
	executor: TransitionJournalQueryable,
	request: PgOutcomeTransactionalRequest,
): Promise<PgOutcomeResult> {
	if (request.transactionOpen)
		return runPgTransactionalOutcomeOnSession(executor, request);
	return withPgOutcomeSession(executor, (session) =>
		runPgTransactionalOutcomeOnSession(session, request),
	);
}

/**
 * Commits claim first, then commits executing before invoking the token-gated
 * sender. The optional checkpoint makes that inter-commit/send boundary
 * observable to recovery tests without changing the production sequence.
 */
async function runPgNonTransactionalOutcomeOnSession(
	executor: TransitionJournalQueryable,
	request: PgOutcomeNonTransactionalRequest,
): Promise<PgOutcomeResult> {
	const admission = await openPgOutcomeClaimOnSession(executor, request);
	if (admission.kind !== 'admitted-outcome-claim') return admission;
	try {
		const vacancy = await verifyCreationVacancy(
			executor,
			admission,
			request.vacancy,
		);
		if (vacancy) {
			await begin(executor, request.lockTimeoutMs);
			await refuseClaim(
				executor,
				admission,
				request,
				request.resolution.eventId,
				'ERR-02',
			);
			await executor.query('COMMIT');
			return vacancy;
		}
		await begin(executor, request.lockTimeoutMs);
		const target = targetForPlan(request.plan);
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
		await executor.query('COMMIT');
		await request.onExecutingCommitted?.();
		const sent = await executePgManagedBundle(executor, {
			token: admission.token,
			claim: admission,
			statements: admission.plan.statementBundle.statements,
		});
		if (sent) return sent;
		await begin(executor, request.lockTimeoutMs);
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
		await executor.query('COMMIT');
		return { kind: 'executed-outcome-claim', claim: admission };
	} catch (error) {
		await rollback(executor);
		return refusal(detail(error));
	}
}

/** Pins every non-transactional protocol checkpoint to one checked-out client. */
export async function runPgNonTransactionalOutcome(
	executor: TransitionJournalQueryable,
	request: PgOutcomeNonTransactionalRequest,
): Promise<PgOutcomeResult> {
	return withPgOutcomeSession(executor, (session) =>
		runPgNonTransactionalOutcomeOnSession(session, request),
	);
}

/**
 * Reads an address's chain and live catalogue in one locked transaction before
 * appending the core classifier's instruction. It never calls the DDL sink.
 */
export async function recoverPgOutcomeClaim(
	executor: TransitionJournalQueryable,
	request: PgOutcomeRecoveryRequest,
): Promise<PgOutcomeRecoveryResult> {
	let begun = false;
	try {
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
				await executor.query('COMMIT');
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
		await executor.query('COMMIT');
		begun = false;
		return { kind: 'outcome-recovery-appended', classification, append };
	} catch (error) {
		if (begun) await rollback(executor);
		return refusal(detail(error));
	}
}
