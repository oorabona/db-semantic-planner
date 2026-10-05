import type { ResolvedIncludeNode, SelectExecution } from '@dbsp/types';
import type { PlanDecision } from './plan-decision.js';

/** Physical lowering reads only execution nodes. No intent, decision context or model. */
export function lowerResolvedIncludes(
	execution: SelectExecution,
	defaultPk: string,
): PlanDecision[] {
	const lower = (node: ResolvedIncludeNode): PlanDecision => {
		const pairs = node.path.hops[0]?.pairs ?? [];
		const selected =
			node.projection?.type === 'fields' ? node.projection.fields : undefined;
		const columns =
			node.strategy === 'join'
				? node.outputMode === 'flat'
					? [defaultPk, ...(selected ?? []).filter((c) => c !== defaultPk)]
					: (selected ?? ['*'])
				: node.strategy === 'json_agg' || node.recursion
					? selected
					: undefined;
		const belongsTo = node.relationType === 'belongsTo';
		const fk = node.recursion
			? node.recursion.direction === 'ancestors'
				? pairs.map((p) => p.fromColumn)
				: pairs.map((p) => p.toColumn)
			: belongsTo
				? pairs.map((p) => p.fromColumn)
				: pairs.map((p) => p.toColumn);
		const pk = node.recursion
			? node.recursion.direction === 'ancestors'
				? pairs.map((p) => p.toColumn)
				: pairs.map((p) => p.fromColumn)
			: belongsTo
				? pairs.map((p) => p.toColumn)
				: pairs.map((p) => p.fromColumn);
		return {
			type: 'includeStrategy',
			resolvedInclude: node,
			choice: node.strategy,
			relationName: node.relationName,
			relationPath: node.relationPath,
			intentPath: node.intentPath,
			targetTable: node.targetRange.table,
			sourceTable: node.sourceRange.table,
			...(node.relationType !== 'belongsToMany' && {
				relationType: node.relationType,
			}),
			sourceColumn: pairs.map((p) => p.fromColumn),
			targetColumn: pairs.map((p) => p.toColumn),
			foreignKey: fk,
			parentKey: pk,
			...(node.joinType && { joinType: node.joinType }),
			...(columns !== undefined && { columns }),
			...(columns?.length === 0 && { emptyProjection: true }),
			...(node.projection && { includeSelectForm: node.projection.type }),
			...(node.ordering.fallback.length && { orderBy: node.ordering.fallback }),
			...(node.ordering.usesFallback && { orderByFallback: true }),
			...(node.ordering.authored && { includeOrderBy: node.ordering.authored }),
			...(node.limit !== undefined && { limit: node.limit }),
			...(node.recursion && { recursiveInclude: node.recursion }),
			...(node.predicate && { includePredicate: node.predicate }),
			...(node.strategy !== 'join' && { children: node.children.map(lower) }),
		};
	};
	const flatJoins = (nodes: readonly ResolvedIncludeNode[]): PlanDecision[] =>
		nodes.flatMap((node) => [
			lower(node),
			...(node.strategy === 'join' ? flatJoins(node.children) : []),
		]);
	return flatJoins(execution.includes);
}
