/** Shared construction for E2E outcome claims; the harness stays uninvolved. */
import { openPgOutcomeClaim } from '@dbsp/adapter-pgsql';
import type { LedgerReservationRow, OutcomeClaimPlan } from '@dbsp/types';

export interface FixtureOutcomeClaimInput {
	readonly claimId: string;
	readonly executionId?: string;
	readonly plannedClaimKey?: string;
	readonly claimGroupId?: string;
	readonly rootClaimId?: string;
	readonly address: OutcomeClaimPlan['address'];
	readonly claimKind: OutcomeClaimPlan['claimKind'];
	readonly statements: readonly string[];
	readonly reservations: readonly LedgerReservationRow[];
	readonly declared?: OutcomeClaimPlan['declared'];
	readonly pairId?: string;
	readonly requiresVacancy?: boolean;
}

export function fixtureOutcomeClaim(input: FixtureOutcomeClaimInput): {
	readonly plan: OutcomeClaimPlan;
	readonly reservations: readonly LedgerReservationRow[];
} {
	const executionId =
		input.executionId ??
		input.reservations[0]?.executionId ??
		`fixture-execution:${input.claimId}`;
	const plannedClaimKey = input.plannedClaimKey ?? `fixture:${input.claimId}`;
	const rootClaimId = input.rootClaimId ?? input.claimId;
	const claimGroupId = input.claimGroupId ?? rootClaimId;
	return {
		plan: {
			claimId: input.claimId,
			executionId,
			plannedClaimKey,
			claimGroupId,
			rootClaimId,
			address: input.address,
			claimKind: input.claimKind,
			statementBundle: {
				statements: input.statements.map((sql, ordinal) => ({ ordinal, sql })),
			},
			...(input.declared === undefined ? {} : { declared: input.declared }),
			...(input.pairId === undefined ? {} : { pairId: input.pairId }),
			...(input.requiresVacancy === undefined
				? {}
				: { requiresVacancy: input.requiresVacancy }),
		},
		reservations: input.reservations.map((reservation) => ({
			...reservation,
			executionId,
			rootClaimId,
		})),
	};
}

/** Opens an E2E fixture claim after constructing its canonical request. */
export function openFixtureOutcomeClaim(
	executor: Parameters<typeof openPgOutcomeClaim>[0],
	input: FixtureOutcomeClaimInput,
) {
	return openPgOutcomeClaim(executor, fixtureOutcomeClaim(input));
}
