/**
 * Shared builder utilities for CTE and recursive query builders.
 */

import type { Adapter, WhereIntent } from '@dbsp/types';
import { InvalidOperationError } from './errors.js';

/**
 * Combine a builder's existing WHERE condition with a new one: successive
 * `.where()` calls narrow the query with AND, as `QueryBuilder.where()` does
 * (#1063, #1028). Replacing the previous condition would widen it instead.
 */
export function andWhere(
	previous: WhereIntent | undefined,
	next: WhereIntent,
): WhereIntent {
	if (previous === undefined) return next;
	// Extend an existing AND instead of nesting it, so a long chain of calls
	// stays one level deep for the recursive resolvers.
	return previous.kind === 'and'
		? { kind: 'and', conditions: [...previous.conditions, next] }
		: { kind: 'and', conditions: [previous, next] };
}

/**
 * Asserts that an adapter is present, throwing a descriptive error if not.
 *
 * @param adapter - The adapter instance (may be undefined)
 * @param operationName - The public API operation name, used in the error message
 * @returns The validated adapter
 */
export function requireAdapter(
	adapter: Adapter | undefined,
	operationName: string,
): Adapter {
	if (!adapter) {
		throw new InvalidOperationError(
			operationName,
			'This operation requires an adapter \u2014 pass an adapter when creating the ORM',
		);
	}
	return adapter;
}
