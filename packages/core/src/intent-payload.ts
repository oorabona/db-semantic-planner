import { EXPRESSION_BRAND } from '@dbsp/types';

/**
 * Whether `node[key]` is a bound or literal payload, data rather than query
 * structure. `value` / `values` hold data unless they carry an expression; a
 * named argument's `value` is always an expression (`name => expr`).
 */
export function isBoundPayload(
	node: Readonly<Record<string, unknown>>,
	key: string,
	child: unknown,
): boolean {
	if (key !== 'value' && key !== 'values') return false;
	if (node.kind === 'namedArg') return false;
	return !child || typeof child !== 'object' || !(EXPRESSION_BRAND in child);
}
