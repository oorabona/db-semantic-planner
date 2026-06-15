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

/**
 * @internal Shared compiler-options marker for trusted NQL package internals.
 *
 * Deliberately uses Symbol(), not Symbol.for(), so knowing the description does
 * not let callers forge the marker through the global symbol registry.
 */
export const NQL_INTERNAL_COMPILER_OPTIONS: unique symbol = Symbol(
	'@dbsp/nql/internalCompilerOptions',
);

const NQL_BINDING_REF = Symbol('@dbsp/nql/bindingRef');

/**
 * @internal Opaque marker for NQL compiler-created binding references.
 *
 * The brand is a module-private Symbol(), so JSON/plain object inputs cannot
 * forge it by shape.
 */
export interface NqlBindingRef {
	readonly name: string;
	readonly [NQL_BINDING_REF]: true;
}

/** @internal */
export function createNqlBindingRef(name: string): NqlBindingRef {
	const ref = { name } as { name: string; [NQL_BINDING_REF]?: true };
	Object.defineProperty(ref, NQL_BINDING_REF, {
		value: true,
		enumerable: false,
	});
	return ref as NqlBindingRef;
}

/** @internal */
export function isNqlBindingRef(value: unknown): value is NqlBindingRef {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	const record = value as {
		readonly name?: unknown;
		readonly [NQL_BINDING_REF]?: unknown;
	};
	return (
		Object.hasOwn(record, NQL_BINDING_REF) &&
		record[NQL_BINDING_REF] === true &&
		typeof record.name === 'string'
	);
}

/** @internal */
export function getNqlBindingRefName(ref: NqlBindingRef): string {
	return ref.name;
}

// Re-export all public types for convenience
export * from './index.js';
