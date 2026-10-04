import type { PlanReport } from '@dbsp/types';

/** Nested payloads belong only to the terminal read. */
export function assertRelationalOutput(
	plan: PlanReport | undefined,
	context: 'Set operations' | 'Relational bodies',
): void {
	if (plan?.includePayloads?.some((payload) => payload.outputMode !== 'flat')) {
		throw new Error(
			`${context} with nested relation output are not supported; use | flat in every branch. A relation with includeStrategy hint 'json_agg' or 'cte' cannot be flattened; change that hint or select from the joined table.`,
		);
	}
}
