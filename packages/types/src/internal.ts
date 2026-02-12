/**
 * @dbsp/types/internal - Internal type definitions
 *
 * These types are for internal use by @dbsp package implementations.
 * They are NOT part of the public API and may change without notice.
 *
 * @module @dbsp/types/internal
 * @internal
 */

// Re-export all public types for convenience
export * from './index.js';
// Internal-only build utilities (NOT part of public API)
export type { IntentBuilder, Mutable } from './builders.js';
