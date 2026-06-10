/**
 * Shared helpers for relation-dotted include path identity.
 *
 * Planner intent paths are positional (`include[0].include[1]`). Join identity
 * and hydration keys use the relation chain actually traversed
 * (`definition.file`, `manager.manager`), so every consumer must derive that
 * string the same way.
 */

export type RelationPathIncludeNode = {
	readonly relation?: unknown;
	readonly via?: unknown;
	readonly include?: readonly unknown[];
};

export type RelationPathUsage = {
	readonly relationName?: string | null | undefined;
	readonly relationPath?: string | null | undefined;
};

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function includeNode(value: unknown): RelationPathIncludeNode | undefined {
	return value !== null && typeof value === 'object'
		? (value as RelationPathIncludeNode)
		: undefined;
}

function parseIntentPathIndexes(intentPath: string): number[] {
	const indexes: number[] = [];
	const indexPattern = /include\[(\d+)\]/g;
	let execResult = indexPattern.exec(intentPath);

	while (execResult !== null) {
		const rawIndex = execResult[1];
		if (rawIndex === undefined) break;
		indexes.push(parseInt(rawIndex, 10));
		execResult = indexPattern.exec(intentPath);
	}

	return indexes;
}

export function deriveRelationPathFromIntentPath(
	includes: readonly unknown[] | undefined,
	intentPath: string | undefined,
	fallbackRelation: string | undefined,
): string | undefined {
	if (includes && intentPath) {
		let current: readonly unknown[] = includes;
		const path: string[] = [];

		for (const index of parseIntentPathIndexes(intentPath)) {
			const item = includeNode(current[index]);
			if (!item) break;

			const segment = nonEmptyString(item.via) ?? nonEmptyString(item.relation);
			if (!segment) break;

			path.push(segment);
			current = Array.isArray(item.include) ? item.include : [];
		}

		if (path.length > 0) return path.join('.');
	}

	return nonEmptyString(fallbackRelation);
}

export function countDistinctRelationPathsByName(
	usages: readonly RelationPathUsage[],
): Map<string, number> {
	const pathsByRelationName = new Map<string, Set<string>>();

	for (const usage of usages) {
		const relationName = nonEmptyString(usage.relationName);
		if (!relationName) continue;

		const relationPath = nonEmptyString(usage.relationPath) ?? relationName;
		const paths = pathsByRelationName.get(relationName) ?? new Set<string>();
		paths.add(relationPath);
		pathsByRelationName.set(relationName, paths);
	}

	const counts = new Map<string, number>();
	for (const [relationName, paths] of pathsByRelationName) {
		counts.set(relationName, paths.size);
	}

	return counts;
}
