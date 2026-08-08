/** Explicit, token-gated admission of a pre-existing object into management. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { projectLedgerChain } from '@dbsp/core';
import type { LedgerAddress, LedgerHome, LedgerPayload } from '@dbsp/types';
import { readPgCatalogueIdentity } from './catalogue-identity.js';
import { readPgLedgerAddressChain } from './chain-reader.js';
import type { TransitionJournalQueryable } from './journal.js';
import { runPgTransactionalOutcome } from './outcome-protocol.js';

export type PgAdoptionResult =
	| { readonly outcome: 'completed' }
	| { readonly outcome: 'no-op' }
	| { readonly outcome: 'adoption-refused'; readonly detail: string };

export type PgAdoptionPreflightResult =
	| { readonly outcome: 'ready' }
	| { readonly outcome: 'no-op' }
	| { readonly outcome: 'adoption-refused'; readonly detail: string };

export interface PgDeclaredAdoptionInput {
	readonly executor: TransitionJournalQueryable;
	readonly home: LedgerHome;
	readonly address: LedgerAddress;
	readonly declaration: LedgerPayload;
	/** Identity observed while the digest-covered adoption plan was reviewed. */
	readonly expectedCatalogueIdentity: NonNullable<
		LedgerAddress['catalogueIdentity']
	>;
	readonly shapeMatches: () => Promise<boolean>;
	readonly executionId?: string;
}

/**
 * Inspect a declared adoption without opening its adopt-intent claim.
 *
 * The generator executes this pass for every declared adoption before it opens
 * any claim for ordinary schema work.  A changed shape or physical identity is
 * therefore reported as the actionable adoption refusal, rather than being
 * hidden behind an unrelated destructive-authority refusal.
 */
export async function preflightPgDeclaredAdoption(
	input: PgDeclaredAdoptionInput,
): Promise<PgAdoptionPreflightResult> {
	try {
		const chain = await readPgLedgerAddressChain(
			input.executor,
			input.home,
			input.address,
		);
		const projection = projectLedgerChain(chain);
		if (
			projection.kind === 'projected-ledger-chain' &&
			projection.stableState === 'managed'
		)
			return { outcome: 'no-op' };
		if (projection.kind !== 'projected-ledger-chain')
			return {
				outcome: 'adoption-refused',
				detail: `declared adoption for ${input.address.name} refuses malformed ledger chain: ${projection.reason.code}`,
			};
		if (!(await input.shapeMatches()))
			return {
				outcome: 'adoption-refused',
				detail: `declared adoption for ${input.address.name} refuses live shape mismatch`,
			};
		const live = await readPgCatalogueIdentity(input.executor, input.address);
		if (!live?.catalogueIdentity)
			return {
				outcome: 'adoption-refused',
				detail: `declared adoption for ${input.address.name} refuses absent live identity`,
			};
		if (
			!isDeepStrictEqual(
				live.catalogueIdentity,
				input.expectedCatalogueIdentity,
			)
		)
			return {
				outcome: 'adoption-refused',
				detail: `declared adoption for ${input.address.name} refuses live identity mismatch`,
			};
		return { outcome: 'ready' };
	} catch (error) {
		return {
			outcome: 'adoption-refused',
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * The caller supplies the already-established live shape comparison. This
 * adapter owns the identity read and the only append path, so a matching shape
 * can never be turned into an adoption without a live catalogue identity.
 */
export async function executePgDeclaredAdoption(
	input: PgDeclaredAdoptionInput,
): Promise<PgAdoptionResult> {
	try {
		const preflight = await preflightPgDeclaredAdoption(input);
		if (preflight.outcome !== 'ready') return preflight;
		const claimId = `dbsp.adoption.${randomUUID()}`;
		const result = await runPgTransactionalOutcome(input.executor, {
			plan: {
				claimId,
				address: input.address,
				claimKind: 'adopt-intent',
				statementBundle: { statements: [] },
				// An adoption deliberately claims a present object. It is not a
				// creation, so the generic creation-vacancy gate must not run.
				requiresVacancy: false,
				declared: input.declaration,
			},
			reservations: [
				{
					address: input.address,
					claimKind: 'adopt-intent',
					executionId: input.executionId ?? claimId,
					rootClaimId: claimId,
					homeLedger: input.home,
				},
			],
			resolution: { eventId: `${claimId}:adopt`, eventKind: 'adopt' },
			readBack: async () => input.declaration,
			recordCatalogueIdentity: true,
		});
		return result.kind === 'executed-outcome-claim'
			? { outcome: 'completed' }
			: { outcome: 'adoption-refused', detail: result.reason };
	} catch (error) {
		return {
			outcome: 'adoption-refused',
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}
