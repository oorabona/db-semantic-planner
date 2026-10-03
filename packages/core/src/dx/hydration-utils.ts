/** Include hydration consumes only the adapter-resolved public payload contract. */
import type { CompiledQuery } from '../adapter.js';
import type { PlanReport } from '../planner.js';
import { hydrateResolvedIncludes } from './include-payload-hydration.js';

export function planForJsonAggHydration(
	planReport: PlanReport,
	query?: CompiledQuery,
): PlanReport {
	return query?.hydrationPlan ?? planReport;
}

export function hydrateJsonAggIncludes<T>(
	results: T[],
	planReport: PlanReport,
): void {
	hydrateResolvedIncludes(
		results,
		planReport.includePayloads ?? [],
		'json_agg',
	);
}
