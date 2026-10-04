import type { Node } from '@pgsql/types';
import { floatNode, integerNode } from '../../ast-helpers.js';

/** Shared validation and rendering for numeric SQL literals. */
export function numericLiteralNode(value: number): Node {
	if (!Number.isFinite(value)) {
		throw new Error(
			`literal(): numeric value must be finite; got ${value}. Use param() for computed values.`,
		);
	}
	return Number.isInteger(value)
		? integerNode(value)
		: floatNode(String(value));
}
