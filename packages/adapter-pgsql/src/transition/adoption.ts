/** Explicit, token-gated admission of a pre-existing object into management. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
	outcomeClaimEventId,
	outcomeClaimId,
	projectLedgerChain,
	validateNormalizedManagedStepManifest,
} from '@dbsp/core';
import type { LedgerAddress, LedgerHome, LedgerPayload } from '@dbsp/types';
import { readPgCatalogueIdentity } from './catalogue-identity.js';
import { readPgLedgerAddressChain } from './chain-reader.js';
import type { TransitionJournalQueryable } from './journal.js';
import {
	executePgAdmittedOperation,
	lockPgJournalRunForNextRoundCompatibilityPath,
	type PgOutcomeTransactionalRequest,
} from './outcome-protocol.js';

export type PgAdoptionResult =
	| { readonly outcome: 'completed' }
	| { readonly outcome: 'no-op' }
	| { readonly outcome: 'adoption-refused'; readonly detail: string }
	| { readonly outcome: 'execution-failed'; readonly detail: string };

export type PgAdoptionPreflightResult =
	| { readonly outcome: 'ready' }
	| { readonly outcome: 'no-op' }
	| { readonly outcome: 'adoption-refused'; readonly detail: string }
	| { readonly outcome: 'execution-failed'; readonly detail: string };

export interface PgDeclaredAdoptionInput {
	readonly executor: TransitionJournalQueryable;
	readonly home: LedgerHome;
	readonly address: LedgerAddress;
	readonly declaration: LedgerPayload;
	/** Identity observed while the digest-covered adoption plan was reviewed. */
	readonly expectedCatalogueIdentity: NonNullable<
		LedgerAddress['catalogueIdentity']
	>;
	readonly shapeMatches: (
		executor: TransitionJournalQueryable,
	) => Promise<boolean>;
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
		const alreadyManaged =
			projection.kind === 'projected-ledger-chain' &&
			projection.stableState === 'managed';
		if (projection.kind !== 'projected-ledger-chain')
			return {
				outcome: 'adoption-refused',
				detail: `declared adoption for ${input.address.name} refuses malformed ledger chain: ${projection.reason.code}`,
			};
		if (!(await input.shapeMatches(input.executor)))
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
		return alreadyManaged ? { outcome: 'no-op' } : { outcome: 'ready' };
	} catch (error) {
		return {
			outcome: 'execution-failed',
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
		// This explanatory preflight does not mint authority: the same facts are
		// re-read by verifyLiveAdmission after the claim/reservation is open.
		const preflight = await preflightPgDeclaredAdoption(input);
		if (preflight.outcome !== 'ready') return preflight;
		const executionId =
			input.executionId ?? `dbsp.adoption.execution.${randomUUID()}`;
		const plannedClaimKey = `adoption:${input.address.kind}:${input.address.name}`;
		const claimId = outcomeClaimId(executionId, plannedClaimKey, input.address);
		const outcomeRequest: PgOutcomeTransactionalRequest = {
			plan: {
				claimId,
				claimSpecies: 'adoption',
				executionId,
				plannedClaimKey,
				claimGroupId: claimId,
				rootClaimId: claimId,
				address: input.address as never,
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
					executionId,
					rootClaimId: claimId,
					homeLedger: input.home,
				},
			],
			resolution: {
				eventId: outcomeClaimEventId(claimId, 'adopt'),
				eventKind: 'adopt',
			},
			verifyLiveAdmission: async (executor) => {
				if (!(await input.shapeMatches(executor)))
					return {
						kind: 'outcome-protocol-refused',
						reason: `declared adoption for ${input.address.name} refuses live shape mismatch`,
					};
				const live = await readPgCatalogueIdentity(executor, input.address);
				if (!live?.catalogueIdentity)
					return {
						kind: 'outcome-protocol-refused',
						reason: `declared adoption for ${input.address.name} refuses absent live identity`,
					};
				if (
					!isDeepStrictEqual(
						live.catalogueIdentity,
						input.expectedCatalogueIdentity,
					)
				)
					return {
						kind: 'outcome-protocol-refused',
						reason: `declared adoption for ${input.address.name} refuses live identity mismatch`,
					};
				return undefined;
			},
			readBack: async () => input.declaration,
			recordCatalogueIdentity: true,
		};
		const manifest = validateNormalizedManagedStepManifest([
			{
				stepKey: plannedClaimKey,
				order: 0,
				segmentId: claimId,
				dependencyOrder: [],
				address: input.address as never,
				claimKind: 'adopt-intent',
				plannedClaimKeys: [plannedClaimKey],
				statementBundle: outcomeRequest.plan.statementBundle,
				classification: 'non-destructive',
				requiresVacancy: false,
				lifecycle: { kind: 'adoption', shape: {} as never },
				replayPolicy: 'recorded',
			},
		]);
		if (!manifest.ok)
			return { outcome: 'execution-failed', detail: manifest.detail };
		const result = await executePgAdmittedOperation(input.executor, {
			run: lockPgJournalRunForNextRoundCompatibilityPath({
				runId: executionId,
				planDigest: claimId,
			}),
			approval: { approvals: [] },
			manifest: manifest.manifest,
			recomputedPlanDigest: claimId,
			operation: { kind: 'single-outcome', request: outcomeRequest },
		});
		// The initial preflight is intentionally outside the claim transaction so
		// it can short-circuit an already-complete adoption. If a concurrent
		// closer wins after that read, the token gate is the authoritative signal;
		// re-read the completed lifecycle before reporting a refusal.
		if (
			result.kind === 'outcome-protocol-refused' &&
			result.reason.includes('claim token for') &&
			result.reason.includes('claim is closed')
		) {
			const completed = await preflightPgDeclaredAdoption(input);
			if (completed.outcome === 'no-op') return completed;
		}
		if (result.kind === 'executed-outcome-claim')
			return { outcome: 'completed' };
		if (!('reason' in result))
			return {
				outcome: 'execution-failed',
				detail: `declared adoption returned unexpected ${result.kind}`,
			};
		return result.reason.startsWith(
			`declared adoption for ${input.address.name} refuses `,
		)
			? { outcome: 'adoption-refused', detail: result.reason }
			: { outcome: 'execution-failed', detail: result.reason };
	} catch (error) {
		return {
			outcome: 'execution-failed',
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}
