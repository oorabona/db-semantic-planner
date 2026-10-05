/** Include hydration consumes only the adapter-resolved public payload contract. */
import type { IncludePayloadShape } from '@dbsp/types';
import { getResolvedIncludeNode } from '@dbsp/types/internal';
import type { CompiledQuery } from '../adapter.js';
import type { PlanReport } from '../planner.js';
import { hydrateResolvedIncludes } from './include-payload-hydration.js';

export function planForJsonAggHydration(
	planReport: PlanReport,
	query?: CompiledQuery,
): PlanReport {
	const resolved = query?.hydrationPlan ?? planReport;
	requireIncludePayloads(resolved, planReport);
	return resolved;
}

export function hydrateJsonAggIncludes<T>(
	results: T[],
	planReport: PlanReport,
): void {
	hydrateResolvedIncludes(
		results,
		requireIncludePayloads(planReport),
		'json_agg',
	);
}

/** Missing compilation authority must never silently expose transport columns. */
export function requireIncludePayloads(
	resolved: PlanReport,
	original: PlanReport = resolved,
): readonly IncludePayloadShape[] {
	if (resolved.includePayloadsByNodeId && resolved.execution) {
		return [
			...new Set(
				resolved.execution.includes.map((node) => {
					const payload = resolved.includePayloadsByNodeId![node.nodeId];
					if (!payload) {
						const error = new Error(
							`Include hydration '${node.publicKey}' requires compiled includePayloads; supply the compiled query hydrationPlan.`,
						);
						error.name = 'MissingIncludePayloadShapeError';
						throw error;
					}
					return payload;
				}),
			),
		];
	}
	if (resolved.includePayloads !== undefined) return resolved.includePayloads;
	const decision = [...original.decisions, ...resolved.decisions].find(
		(d) =>
			d.type === 'include-strategy' &&
			['json_agg', 'join', 'lateral', 'cte'].includes(d.choice),
	);
	if (decision) {
		const error = new Error(
			`Include hydration '${getResolvedIncludeNode(original.execution, decision)?.publicKey ?? '?'}' requires compiled includePayloads; supply the compiled query hydrationPlan.`,
		);
		error.name = 'MissingIncludePayloadShapeError';
		throw error;
	}
	return [];
}
