import {
	admitOutcomeClaim,
	claimIdForToken,
	consumeClaimToken,
	projectLedgerChain,
} from '@dbsp/core';
import type {
	AdmittedOutcomeClaim,
	ClaimBundleStatement,
	ClaimToken,
	LedgerChainMember,
	LedgerEventKind,
	LedgerReservationRow,
	OutcomeClaimAdmission,
	OutcomeClaimPlan,
	OutcomeProtocolRefusal,
	OutcomeVacancy,
} from '@dbsp/types';
import { readPgLedgerAddressChain } from './chain-reader.js';
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

export interface PgOutcomeTransactionalRequest extends PgOutcomeClaimRequest {
	readonly resolution: PgOutcomeResolution;
	/** Required for creations; the reader runs after the claim and before SQL. */
	readonly vacancy?: (
		executor: TransitionJournalQueryable,
		plan: OutcomeClaimPlan,
	) => Promise<OutcomeVacancy>;
}

export interface PgOutcomeNonTransactionalRequest
	extends PgOutcomeTransactionalRequest {
	readonly executingEventId: string;
	/** Observable acknowledgement point after executing has committed, before SQL. */
	readonly onExecutingCommitted?: () => Promise<void> | void;
}

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
	if (plan.address.scope === 'database') return { scope: 'database' };
	if (!plan.address.schema)
		throw new Error(
			`schema-scoped claim ${plan.claimId} has no schema address`,
		);
	return { scope: 'schema', schema: plan.address.schema };
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
		await executor.query(statement.sql);
}

async function verifyCreationVacancy(
	executor: TransitionJournalQueryable,
	claim: AdmittedOutcomeClaim,
	reader: PgOutcomeTransactionalRequest['vacancy'],
): Promise<OutcomeProtocolRefusal | undefined> {
	if (claim.stableStateBeforeClaim === 'managed') return undefined;
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
	try {
		await begin(executor, request.lockTimeoutMs);
		begun = true;
		const lock = await acquirePgLedgerLocks(executor, homesFor(request));
		if (lock.kind !== 'acquired') {
			await executor.query('ROLLBACK');
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
			await executor.query('COMMIT');
			begun = false;
			return vacancy;
		}
		const sent = await executePgManagedBundle(executor, {
			token: admission.token,
			claim: admission,
			statements: admission.plan.statementBundle.statements,
		});
		if (sent) throw new Error(sent.reason);
		await appendPgLedgerResolution(
			executor,
			target,
			resolutionMember(admission, request.resolution, request.plan.claimId),
			request.plan.claimId,
			request.reservations,
		);
		await executor.query('COMMIT');
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
		await appendPgLedgerResolution(
			executor,
			targetForPlan(request.plan),
			resolutionMember(admission, request.resolution, request.executingEventId),
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
