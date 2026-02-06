/* biome-ignore-all lint/style/noNonNullAssertion: NQL AST node access requires non-null assertions on validated parse tree */
/**
 * @module compiler/include-builder
 * Build nested IncludeIntent trees from relation paths and apply per-include limits.
 */

import type { IncludeIntent } from '@dbsp/types';

/**
 * Build nested IncludeIntent[] from a set of dotted relation paths.
 *
 * Given paths like:
 *   - "userRoles.role"
 *   - "userRoles.role.rolePermissions.permission"
 *
 * Produces:
 *   [{ relation: "userRoles", include: [
 *     { relation: "role", include: [
 *       { relation: "rolePermissions", include: [
 *         { relation: "permission" }
 *       ]}
 *     ]}
 *   ]}]
 *
 * Strategy-agnostic: the planner/adapter decides execution strategy.
 * flatMode propagates to all levels when enabled.
 */
export function buildNestedIncludes(
	paths: Set<string>,
	flatMode: boolean,
): IncludeIntent[] {
	// Build a tree structure from all paths
	interface TreeNode {
		children: Map<string, TreeNode>;
	}
	const root: TreeNode = { children: new Map() };

	for (const path of paths) {
		const segments = path.split('.');
		let node = root;
		for (const segment of segments) {
			if (!node.children.has(segment)) {
				node.children.set(segment, { children: new Map() });
			}
			node = node.children.get(segment)!;
		}
	}

	// Convert tree to nested IncludeIntent[]
	function treeToIncludes(node: TreeNode): IncludeIntent[] {
		const includes: IncludeIntent[] = [];
		for (const [relation, child] of node.children) {
			const childIncludes = treeToIncludes(child);
			const include: IncludeIntent = {
				relation,
				...(flatMode ? { strategy: 'flat' as const } : {}),
				...(childIncludes.length > 0 ? { include: childIncludes } : {}),
			};
			includes.push(include);
		}
		return includes;
	}

	return treeToIncludes(root);
}

/**
 * Apply a per-include limit to the correct level of a nested include tree.
 * Also sets strategy to 'flat' (LATERAL required for per-parent limiting).
 */
export function applyIncludeLimit(
	includes: IncludeIntent[],
	path: string,
	limit: number,
): void {
	const segments = path.split('.');
	const root = segments[0]!;
	const idx = includes.findIndex((inc) => inc.relation === root);
	if (idx === -1) return;

	if (segments.length === 1) {
		// Top-level: apply limit + implicit flat (LATERAL required for per-parent limit)
		includes[idx] = {
			...includes[idx]!,
			limit,
			strategy: 'flat',
		};
	} else {
		// Deep path: force flat on intermediate segment (LATERAL cascade required)
		// and recurse into nested includes
		const nested = [...(includes[idx]?.include ?? [])];
		applyIncludeLimit(nested, segments.slice(1).join('.'), limit);
		includes[idx] = { ...includes[idx]!, strategy: 'flat', include: nested };
	}
}
