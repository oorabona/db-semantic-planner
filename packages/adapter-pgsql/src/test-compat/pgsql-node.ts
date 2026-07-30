/** Test-only boundary for the @pgsql/types Null AST node gap. */
import type { Node } from '@pgsql/types';

type NullNode = { readonly Null: Record<never, never> };
declare const nullNode: NullNode;
export function verifyCompatibilityCanary(): void {
	// @ts-expect-error @pgsql/types omits the Null AST node; remove when it accepts this node.
	const _canary: Node = nullNode;
	void _canary;
}

export function pgNode(value: unknown): Node {
	return value as Node;
}
