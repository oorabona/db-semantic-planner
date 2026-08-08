import type {
	ManagedOutcomeExecutionRequest,
	ManagedOutcomePreflightRequest,
	TransitionExecutionClient,
} from '@dbsp/core';
import type {
	LedgerReservationRow,
	OperationExecutionOutcome,
} from '@dbsp/types';
import { readPgCatalogueIdentity } from './catalogue-identity.js';
import {
	runPgNonTransactionalOutcome,
	runPgTransactionalOutcome,
} from './outcome-protocol.js';
import { readPgLedgerMarker } from './reinitialize-preflight.js';

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
): LedgerReservationRow {
	const { address, claimId, claimKind } = request.claim;
	return {
		address,
		claimKind,
		executionId: request.run.runId,
		rootClaimId: claimId,
		homeLedger: ledgerHome(request),
	};
}

function ledgerHome(request: ManagedOutcomePreflightRequest) {
	const address = request.claim.address;
	if (address.scope === 'database') return { scope: 'database' } as const;
	if (!address.schema)
		throw new Error(
			`managed claim ${request.claim.claimId} has no schema ledger`,
		);
	return { scope: 'schema', schema: address.schema } as const;
}

async function currentMarker(
	executor: Queryable,
	request: ManagedOutcomePreflightRequest,
): Promise<'absent' | string | undefined> {
	const marker = await readPgLedgerMarker(executor, ledgerHome(request));
	if (marker.kind === 'absent') return 'absent';
	return marker.kind === 'current'
		? undefined
		: `managed claim ${request.claim.claimId} refuses ledger marker ${marker.kind}; run dbsp preflight --reinitialize`;
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
			client: TransitionExecutionClient,
			request: ManagedOutcomePreflightRequest,
		): Promise<string | undefined> {
			const marker = await currentMarker(queryable(client), request);
			return marker === 'absent' ? undefined : (marker ?? undefined);
		},
		async executeManagedOutcome(
			client: TransitionExecutionClient,
			request: ManagedOutcomeExecutionRequest,
		): Promise<OperationExecutionOutcome> {
			const executor = queryable(client);
			const marker = await currentMarker(executor, request);
			if (marker === 'absent') return request.executeUnmanaged();
			if (marker) return refused(marker);
			const reservations = [reservation(request)];
			const vacancy = async () => {
				const live = await readPgCatalogueIdentity(
					executor,
					request.claim.address,
				);
				return live?.catalogueIdentity
					? {
							kind: 'occupied' as const,
							reason: `creation claim ${request.claim.claimId} refuses occupied live address ${request.claim.address.name}`,
						}
					: { kind: 'vacant' as const };
			};
			const base = {
				plan: request.claim,
				reservations,
				lockTimeoutMs: request.lockTimeoutMs,
				resolution: {
					eventId: `${request.claim.claimId}:observed`,
					eventKind: 'observed' as const,
				},
				readBack: request.readBack,
				vacancy,
			};
			const result = request.transactional
				? await runPgTransactionalOutcome(executor, {
						...base,
						transactionOpen: true,
					})
				: await runPgNonTransactionalOutcome(executor, {
						...base,
						executingEventId: `${request.claim.claimId}:executing`,
					});
			return result.kind === 'executed-outcome-claim'
				? { kind: 'completed' }
				: refused(result.reason);
		},
	};
}
