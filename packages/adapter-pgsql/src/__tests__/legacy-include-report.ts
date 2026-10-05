import type { PlanReport, ResolvedIncludeNode } from '@dbsp/types';
/** External legacy-report fixtures explicitly relinquish the native execution authority. */
export function asLegacyReport(report: PlanReport): PlanReport {
	const { execution, ...legacy } = report;
	if (!execution) return report;
	const nodes = (
		items: readonly ResolvedIncludeNode[],
	): readonly ResolvedIncludeNode[] =>
		items.flatMap((node) => [node, ...nodes(node.children)]);
	const byId = new Map(
		nodes(execution.includes).map((node) => [node.nodeId, node]),
	);
	return {
		...legacy,
		decisions: report.decisions.map((decision) => {
			const node = decision.context.nodeId && byId.get(decision.context.nodeId);
			if (!node) return decision;
			const relation = node.path.relations[0]!;
			return {
				...decision,
				...(node.joinType && { joinType: node.joinType }),
				context: {
					sourceTable: node.sourceRange.table,
					target: node.targetRange.table,
					relation: node.relationName,
					relationType: node.relationType,
					includeAlias: node.publicKey,
					intentPath: node.intentPath,
					...(relation.foreignKey !== undefined && {
						foreignKey: relation.foreignKey,
					}),
					...(node.relationType === 'belongsTo'
						? relation.targetKey !== undefined && {
								parentKey: relation.targetKey,
							}
						: relation.sourceKey !== undefined && {
								parentKey: relation.sourceKey,
							}),
					...(node.recursion && { recursiveInclude: node.recursion }),
					targetOrderKey: node.ordering.fallback,
					orderByFallback: node.ordering.usesFallback,
				},
			};
		}),
	};
}
