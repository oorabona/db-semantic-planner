/**
 * Shared builder utilities for CTE and recursive query builders.
 */

import type { Adapter } from '@dbsp/types';
import { InvalidOperationError } from './errors.js';

/**
 * Asserts that an adapter is present, throwing a descriptive error if not.
 *
 * @param adapter - The adapter instance (may be undefined)
 * @param operationName - The public API operation name, used in the error message
 * @returns The validated adapter
 */
export function requireAdapter(adapter: Adapter | undefined, operationName: string): Adapter {
	if (!adapter) {
		throw new InvalidOperationError(
			operationName,
			'This operation requires an adapter \u2014 pass an adapter when creating the ORM',
		);
	}
	return adapter;
}
