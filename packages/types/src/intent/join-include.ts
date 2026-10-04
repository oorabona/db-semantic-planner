import type { QueryIntent } from './query-intent.js';
import { NQL_SELECT_AGGREGATE_FUNCTIONS } from './select-function-allowlist.js';

const aggregateFunctions: ReadonlySet<string> = new Set(
	NQL_SELECT_AGGREGATE_FUNCTIONS,
);

/** Inspect nested expression nodes, including wrappers and function arguments. */
function containsAggregate(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false;
	if (Array.isArray(value)) return value.some(containsAggregate);
	const node = value as Record<string, unknown>;
	if (node.kind === 'aggregate') return true;
	if (
		(node.kind === 'function' || node.kind === 'customFn') &&
		typeof node.name === 'string' &&
		aggregateFunctions.has(node.name.toLowerCase())
	)
		return true;
	return Object.values(node).some(containsAggregate);
}

/** Shared by join-include refusal and relational projection stripping. */
export function dropsJoinIncludeData(intent: QueryIntent | undefined): boolean {
	return (
		intent?.select?.type === 'aggregate' ||
		(intent?.select?.type === 'expressions' &&
			containsAggregate(intent.select.columns)) ||
		intent?.distinct === true ||
		(intent?.groupBy?.length ?? 0) > 0
	);
}

export function belongsToManyJoinIncludeRefusal(path: string): string {
	return `Include ${path} cannot use 'join' for a belongsToMany relation. The relation goes through a junction table that join includes, .join(<relation>), NQL | flat and json_agg/lateral includes do not traverse yet. Join the junction and target tables explicitly with .join(<table>, { on }).`;
}
