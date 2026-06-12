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

// Re-export all public types for convenience
export * from './index.js';
