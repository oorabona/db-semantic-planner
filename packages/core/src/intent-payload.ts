import { EXPRESSION_BRAND } from '@dbsp/types';

/**
 * Whether `node[key]` is a bound or literal payload, data rather than query
 * structure. `value` / `values` hold data unless they carry an expression; a
 * named argument's `value` is always an expression (`name => expr`), and a
 * range condition's `RangeValue` (`{ lower, upper }`) holds bounds that can be
 * expressions, so it is walked like structure.
 */
export function isBoundPayload(
	node: Readonly<Record<string, unknown>>,
	key: string,
	child: unknown,
): boolean {
	if (key !== 'value' && key !== 'values') return false;
	if (node.kind === 'namedArg') return false;
	if (!child || typeof child !== 'object') return true;
	if (EXPRESSION_BRAND in child) return false;
	return !(
		node.kind === 'range' &&
		key === 'value' &&
		('lower' in child || 'upper' in child)
	);
}
