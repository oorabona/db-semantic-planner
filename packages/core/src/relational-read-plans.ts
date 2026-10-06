import type {
	ModelIR,
	PlanOptions,
	PlanReport,
	QueryIntent,
} from '@dbsp/types';
import { assertUnplannedDefaultFilters } from './dx/default-filter-refusals.js';

// Retain the plan issued with each builder's policy, including opted-out leaves.
// These bodies are in-process intents; policy is not public intent syntax.
const plans = new WeakMap<
	QueryIntent,
	{ report: PlanReport; model: ModelIR; filters: PlanOptions['defaultFilters'] }
>();
export function registerRelationalReadPlan(
	report: PlanReport,
	model: ModelIR,
	filters: PlanOptions['defaultFilters'],
): QueryIntent {
	plans.set(report.intent, { report, model, filters });
	return report.intent;
}
export function getRelationalReadPlan(
	intent: QueryIntent,
	queryLocalSource = false,
): PlanReport | undefined {
	const issued = plans.get(intent);
	if (!issued) return undefined;
	if (queryLocalSource) {
		assertUnplannedDefaultFilters(
			intent,
			issued.model,
			issued.filters,
			'CTE binding',
		);
		return undefined;
	}
	return issued.report;
}
