import { EXPRESSION_BRAND, REF_BRAND } from '@dbsp/types';

/**
 * Whether a `RangeValue` side (`lower` / `upper`) is query structure: an
 * expression, a schema `ref()` or an `outerRef()`. Any other side is data,
 * whatever its keys.
 */
export function isRangeSideExpression(child: unknown): boolean {
	if (!child || typeof child !== 'object') return false;
	if (EXPRESSION_BRAND in child || REF_BRAND in child) return true;
	const candidate = child as {
		readonly kind?: unknown;
		readonly outer?: unknown;
	};
	return candidate.kind === 'ref' && candidate.outer === true;
}

/** Whether a range condition's `value` is a `RangeValue` (`{ lower, upper }`). */
export function isRangeValueShape(child: unknown): boolean {
	return (
		!!child &&
		typeof child === 'object' &&
		!Array.isArray(child) &&
		!(EXPRESSION_BRAND in child) &&
		('lower' in child || 'upper' in child)
	);
}

/**
 * Whether `node[key]` is a bound or literal payload, data rather than query
 * structure. `value` / `values` hold data unless they carry an expression; a
 * named argument's `value` is always an expression (`name => expr`). A range
 * condition's `RangeValue` is walked, and each of its sides is data unless it
 * is an expression, a schema `ref()` or an `outerRef()`.
 */
export function isBoundPayload(
	node: Readonly<Record<string, unknown>>,
	key: string,
	child: unknown,
): boolean {
	if (key === 'lower' || key === 'upper')
		return node.kind === undefined && !isRangeSideExpression(child);
	if (key !== 'value' && key !== 'values') return false;
	if (node.kind === 'namedArg') return false;
	if (!child || typeof child !== 'object') return true;
	if (EXPRESSION_BRAND in child) return false;
	return !(
		node.kind === 'range' &&
		key === 'value' &&
		isRangeValueShape(child)
	);
}
