import type {
	ManagedOutcomeExecutionRequest,
	ManagedOutcomePreflightRequest,
	TransitionExecutionClient,
} from '@dbsp/core';
import { outcomeClaimEventId, outcomeClaimId } from '@dbsp/core';
import type {
	LedgerReservationRow,
	OperationExecutionOutcome,
	OutcomeClaimPlan,
	ProvenPlanShape,
} from '@dbsp/types';
import { readPgCatalogueIdentity } from './catalogue-identity.js';
import {
	runPgNonTransactionalOutcome,
	runPgTransactionalOutcome,
} from './outcome-protocol.js';
import { readPgLedgerScopeCurrency } from './reinitialize-preflight.js';

type Queryable = {
	query(
		sql: string,
		params?: readonly unknown[],
	): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
};

function queryable(client: TransitionExecutionClient): Queryable {
	const candidate = client.opaqueClient as unknown as Partial<Queryable>;
	if (typeof candidate.query !== 'function')
		throw new Error('PostgreSQL managed-outcome client is not queryable');
	return candidate as Queryable;
}

function reservation(
	request: ManagedOutcomeExecutionRequest,
	claim: OutcomeClaimPlan,
): LedgerReservationRow {
	const { address, claimId, claimKind } = claim;
	return {
		address,
		claimKind,
		executionId: request.executionId,
		rootClaimId: claimId,
		homeLedger: ledgerHome(request),
	};
}

function ledgerHome(request: ManagedOutcomePreflightRequest) {
	const address = request.claim.address;
	if (address.scope === 'database') return { scope: 'database' } as const;
	if (!address.schema)
		throw new Error(
			`managed claim ${request.claim.plannedClaimKey} has no schema ledger`,
		);
	return { scope: 'schema', schema: address.schema } as const;
}

/**
 * Check every existing managed ledger before ordinary apply reaches the
 * execution-contract comparison. A restored plan's physical-target clause is
 * necessarily different too, but the ledger's fresh-ledger path is the
 * actionable refusal and must win that ordering.
 */
export async function validatePgManagedLedgerCurrency(
	executor: Queryable,
	plan: ProvenPlanShape,
): Promise<string | undefined> {
	const seen = new Set<string>();
	for (const step of plan.steps) {
		const claim = step.managedClaim;
		if (!claim) continue;
		const home =
			claim.address.scope === 'database'
				? ({ scope: 'database' } as const)
				: claim.address.schema
					? ({ scope: 'schema', schema: claim.address.schema } as const)
					: undefined;
		if (!home)
			return `managed claim ${claim.plannedClaimKey} has no schema ledger; run dbsp preflight --reinitialize`;
		const key = `${home.scope}:${home.schema ?? ''}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const currency = await readPgLedgerScopeCurrency(executor, home);
		if (currency.kind === 'current') continue;
		return currency.kind === 'not-current' && currency.reason === 'lineage'
			? 'managed-ledger-not-current: ledger lineage mismatch; run dbsp preflight --reinitialize'
			: `managed-ledger-not-current: ledger marker ${currency.marker.kind}; run dbsp preflight --reinitialize`;
	}
	return undefined;
}

function refused(detail: string): OperationExecutionOutcome {
	return { kind: 'partially-applied', recovery: [], detail };
}

/**
 * Adds the PostgreSQL implementation of core's outcome capability without
 * changing the operation-specific runtime.  Its SQL input is exclusively the
 * statement bundle persisted on the step; it never renders the operation.
 */
export function withPgManagedOutcomeRuntime<T extends object>(
	runtime: T,
): T & {
	executeManagedOutcome(
		client: TransitionExecutionClient,
		request: ManagedOutcomeExecutionRequest,
	): Promise<OperationExecutionOutcome>;
} {
	return {
		...runtime,
		async preflightManagedOutcome(
			_client: TransitionExecutionClient,
			_request: ManagedOutcomePreflightRequest,
		): Promise<string | undefined> {
			// Live currency is checked by the transaction-owned evaluator, after it
			// has serialized the ledger. Plan-time preflight remains explanatory only.
			return undefined;
		},
		async executeManagedOutcome(
			client: TransitionExecutionClient,
			request: ManagedOutcomeExecutionRequest,
		): Promise<OperationExecutionOutcome> {
			const executor = queryable(client);
			const claimId = outcomeClaimId(
				request.executionId,
				request.claim.plannedClaimKey,
				request.claim.address,
			);
			const claim = {
				...request.claim,
				claimId,
				executionId: request.executionId,
				claimGroupId: claimId,
				rootClaimId: claimId,
			};
			const reservations = [reservation(request, claim)];
			const vacancy = async () => {
				const live = await readPgCatalogueIdentity(
					executor,
					request.claim.address,
				);
				return live?.catalogueIdentity
					? {
							kind: 'occupied' as const,
							reason: `creation claim ${claimId} refuses occupied live address ${request.claim.address.name}`,
						}
					: { kind: 'vacant' as const };
			};
			const base = {
				plan: claim,
				reservations,
				lockTimeoutMs: request.lockTimeoutMs,
				resolution: {
					eventId: outcomeClaimEventId(claimId, 'observed'),
					eventKind: 'observed' as const,
				},
				readBack: request.readBack,
				vacancy,
				// A managed terminal must carry the identity observed after SQL. The
				// next lifecycle uses it as its anti-recreation admission evidence.
				recordCatalogueIdentity: true,
			};
			const result = request.transactional
				? await runPgTransactionalOutcome(executor, {
						...base,
						transactionOpen: true,
					})
				: await runPgNonTransactionalOutcome(executor, {
						...base,
						executingEventId: outcomeClaimEventId(claimId, 'executing'),
					});
			return result.kind === 'executed-outcome-claim'
				? { kind: 'completed' }
				: refused(result.reason);
		},
	};
}
