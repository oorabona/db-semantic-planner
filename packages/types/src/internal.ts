/**
 * @dbsp/types/internal - Internal type definitions
 *
 * These types are for internal use by @dbsp package implementations.
 * They are NOT part of the public API and may change without notice.
 *
 * @module @dbsp/types/internal
 * @internal
 */

// Internal-only build utilities (NOT part of public API)
export type { IntentBuilder, Mutable } from './builders.js';

import type { ParamValueProvenance } from './adapter.js';

export interface MutableParamValueProvenance extends ParamValueProvenance {
	markParamValue(container: object, key: PropertyKey): void;
	hasParamValues(): boolean;
}

export function createParamValueProvenance(): MutableParamValueProvenance {
	const positions = new WeakMap<object, Set<PropertyKey>>();
	let count = 0;

	return {
		markParamValue(container: object, key: PropertyKey): void {
			let keys = positions.get(container);
			if (!keys) {
				keys = new Set<PropertyKey>();
				positions.set(container, keys);
			}
			if (!keys.has(key)) {
				keys.add(key);
				count++;
			}
		},
		isParamValue(container: object, key: PropertyKey): boolean {
			return positions.get(container)?.has(key) === true;
		},
		hasParamValues(): boolean {
			return count > 0;
		},
	};
}

// Re-export all public types for convenience
export * from './index.js';
