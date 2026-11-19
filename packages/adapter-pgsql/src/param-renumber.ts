import type { Node } from '@pgsql/types';

/**
 * Walk a PostgreSQL AST Node tree and renumber all ParamRef.number values
 * by adding `offset` to each. Used to merge inner subquery parameters into
 * the outer query's parameter sequence without $N collisions.
 *
 * @param node - Root AST node (any pgsql Node object or array)
 * @param offset - Value to add to every ParamRef.number found
 * @returns A new node tree with renumbered ParamRefs (original is not mutated)
 */
export function renumberParamRefsInAst(node: unknown, offset: number): Node {
	if (offset === 0) return node as Node;
	return renumberNode(node, offset) as Node;
}

function renumberNode(value: unknown, offset: number): unknown {
	if (value === null || value === undefined) return value;
	if (Array.isArray(value)) {
		return value.map((item) => renumberNode(item, offset));
	}
	if (typeof value !== 'object') return value;
	const obj = value as Record<string, unknown>;
	// ParamRef node: { ParamRef: { number: N } }
	if (
		'ParamRef' in obj &&
		obj.ParamRef !== null &&
		typeof obj.ParamRef === 'object'
	) {
		const pr = obj.ParamRef as Record<string, unknown>;
		return { ParamRef: { ...pr, number: (pr.number as number) + offset } };
	}
	// Recursively walk all object properties
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(obj)) {
		result[key] = renumberNode(obj[key], offset);
	}
	return result;
}
