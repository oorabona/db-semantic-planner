/** Shared construction for E2E outcome claims; the harness stays uninvolved. */
import type { LedgerReservationRow, OutcomeClaimPlan } from '@dbsp/types';

export function fixtureOutcomeClaim(input: {
	readonly claimId: string;
	readonly address: OutcomeClaimPlan['address'];
	readonly claimKind: OutcomeClaimPlan['claimKind'];
	readonly statements: readonly string[];
	readonly reservations: readonly LedgerReservationRow[];
	readonly declared?: OutcomeClaimPlan['declared'];
	readonly pairId?: string;
	readonly requiresVacancy?: boolean;
}): {
	readonly plan: OutcomeClaimPlan;
	readonly reservations: readonly LedgerReservationRow[];
} {
	return {
		plan: {
			claimId: input.claimId,
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
		reservations: input.reservations,
	};
}
