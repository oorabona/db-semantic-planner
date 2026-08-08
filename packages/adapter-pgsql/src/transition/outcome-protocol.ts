import type { AdmittedDestructiveOutcomeClaim } from '@dbsp/core';
import {
	admitOutcomeClaim,
	claimIdForToken,
	classifyOutcomeRecovery,
	consumeClaimToken,
	isDestructiveAuthorityPermit,
	projectLedgerChain,
} from '@dbsp/core';
import type {
	AdmittedOutcomeClaim,
	ClaimBundleStatement,
	ClaimToken,
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
import { readPgCatalogueIdentity } from './catalogue-identity.js';
import { readPgLedgerAddressChain } from './chain-reader.js';
import { classifyPgWrite } from './database-writability.js';
import type { TransitionJournalQueryable } from './journal.js';
import {
	acquirePgLedgerLocks,
	appendPgLedgerClaim,
	appendPgLedgerProgress,
	appendPgLedgerResolution,
	type PgLedgerTarget,
} from './ledger.js';

const DEFAULT_LOCK_TIMEOUT_MS = 5000;

export interface PgOutcomeClaimRequest {
	readonly plan: OutcomeClaimPlan;
	readonly reservations: readonly LedgerReservationRow[];
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

function boundedLockTimeout(value: number | undefined): number {
	if (!Number.isFinite(value)) return DEFAULT_LOCK_TIMEOUT_MS;
	return Math.max(
		1,
		Math.min(86_400_000, Math.trunc(value ?? DEFAULT_LOCK_TIMEOUT_MS)),
	);
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
		address: claim.plan.address,
		eventKind: resolution.eventKind,
		predecessor,
		...(resolution.observed === undefined
			? {}
			: { observed: resolution.observed }),
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
			canonicalJson(right.observed ?? null)
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
export async function openPgOutcomeClaim(
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
		const target = targetForPlan(request.plan);
		const chain = await readPgLedgerAddressChain(
			executor,
			target,
			request.plan.address,
		);
		const admission = admitOutcomeClaim({
			plan: request.plan,
			projection: projectLedgerChain(chain),
		});
		if (admission.kind !== 'admitted-outcome-claim') {
			await executor.query('ROLLBACK');
			begun = false;
			return admission;
		}
		await appendPgLedgerClaim(
			executor,
			target,
			claimMember(request, chain.terminalMember?.eventId),
			request.reservations,
		);
		await executor.query('COMMIT');
		begun = false;
		return admission;
	} catch (error) {
		if (begun) await rollback(executor);
		return refusal(detail(error));
	}
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
			`claim ${claim.plan.claimId} refuses malformed ledger chain: ${projection.reason.code}`,
		);
	if (projection.openClaim?.event.eventId !== claim.plan.claimId)
		return refusal(
			`claim token for ${claim.plan.claimId} is no longer valid because its claim is closed`,
		);
	return undefined;
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
				? 'claim token was not minted by claim admission'
				: `claim token belongs to claim ${tokenClaimId}, not ${request.claim.plan.claimId}`,
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
	predecessor: string,
): Promise<void> {
	await appendPgLedgerResolution(
		executor,
		targetForPlan(claim.plan),
		{
			eventId,
			address: claim.plan.address,
			eventKind: 'refused',
			predecessor,
		},
		claim.plan.claimId,
		request.reservations,
	);
}

/** Claim, vacancy read, bundle send and resolution share one transaction. */
export async function runPgTransactionalOutcome(
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
		const chain = await readPgLedgerAddressChain(
			executor,
			target,
			request.plan.address,
		);
		const admission = admitOutcomeClaim({
			plan: request.plan,
			projection: projectLedgerChain(chain),
		});
		if (admission.kind !== 'admitted-outcome-claim') {
			if (ownsTransaction) await executor.query('ROLLBACK');
			begun = false;
			return admission;
		}
		await appendPgLedgerClaim(
			executor,
			target,
			claimMember(request, chain.terminalMember?.eventId),
			request.reservations,
		);
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
				request.plan.claimId,
			);
			if (ownsTransaction) await executor.query('COMMIT');
			begun = false;
			return vacancy;
		}
		const sent = await executePgManagedBundle(executor, {
			token: admission.token,
			claim: admission,
			statements: admission.plan.statementBundle.statements,
		});
		if (sent) throw new Error(sent.reason);
		await appendOutcomeTerminal(
			executor,
			target,
			await terminalResolutionMember(
				executor,
				request,
				admission,
				request.plan.claimId,
			),
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
 * Commits claim first, then commits executing before invoking the token-gated
 * sender. The optional checkpoint makes that inter-commit/send boundary
 * observable to recovery tests without changing the production sequence.
 */
export async function runPgNonTransactionalOutcome(
	executor: TransitionJournalQueryable,
	request: PgOutcomeNonTransactionalRequest,
): Promise<PgOutcomeResult> {
	const admission = await openPgOutcomeClaim(executor, request);
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
				request.plan.claimId,
			);
			await executor.query('COMMIT');
			return vacancy;
		}
		await begin(executor, request.lockTimeoutMs);
		await appendPgLedgerProgress(executor, targetForPlan(request.plan), {
			eventId: request.executingEventId,
			address: request.plan.address,
			eventKind: 'executing',
			predecessor: request.plan.claimId,
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
		await appendOutcomeTerminal(
			executor,
			targetForPlan(request.plan),
			await terminalResolutionMember(
				executor,
				request,
				admission,
				request.executingEventId,
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
