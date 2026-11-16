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
	{
		report?: PlanReport;
		model: ModelIR;
		filters: PlanOptions['defaultFilters'];
	}
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

/** Associate a raw nested body with its issuer, including an explicit opt-out. */
export function registerRelationalReadPolicy(
	intent: QueryIntent,
	model: ModelIR,
	filters: PlanOptions['defaultFilters'],
): QueryIntent {
	plans.set(intent, { model, filters });
	return intent;
}
export function getRelationalReadPolicy(intent: QueryIntent) {
	return plans.get(intent);
}

/**
 * Whether a query, or any query nested in it, carries a policy issued by a
 * builder. A body without its own policy can still hold one deeper, for
 * example `rawExists(orm.select(...))` in its WHERE.
 */
export function containsRelationalReadPolicy(intent: unknown): boolean {
	const seen = new Set<object>();
	const visit = (value: unknown): boolean => {
		if (!value || typeof value !== 'object' || seen.has(value)) return false;
		seen.add(value);
		if (
			typeof (value as { from?: unknown }).from === 'string' &&
			plans.has(value as QueryIntent)
		)
			return true;
		return (Array.isArray(value) ? value : Object.values(value)).some(visit);
	};
	return visit(intent);
}
