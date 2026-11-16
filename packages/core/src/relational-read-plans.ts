import {
	isParamIntent,
	type ModelIR,
	type PlanOptions,
	type PlanReport,
	type QueryIntent,
} from '@dbsp/types';
import { assertUnplannedDefaultFilters } from './dx/default-filter-refusals.js';
import { isBoundPayload } from './intent-payload.js';

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
 * example `rawExists(orm.select(...))` in its WHERE. Only query structure is
 * walked: bound and literal payloads are data, never a query.
 */
export function containsRelationalReadPolicy(intent: unknown): boolean {
	const seen = new Set<object>();
	const visit = (value: unknown): boolean => {
		if (!value || typeof value !== 'object' || seen.has(value)) return false;
		seen.add(value);
		if (isParamIntent(value)) return false;
		const node = value as Record<string, unknown>;
		if (
			node.kind === 'param' ||
			node.kind === 'literal' ||
			node.kind === 'parameter'
		)
			return false;
		if (typeof node.from === 'string' && plans.has(value as QueryIntent))
			return true;
		if (Array.isArray(value)) return value.some(visit);
		for (const [key, child] of Object.entries(node)) {
			if (isBoundPayload(node, key, child)) continue;
			if (visit(child)) return true;
		}
		return false;
	};
	return visit(intent);
}
