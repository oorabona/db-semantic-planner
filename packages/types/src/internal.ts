/**
 * @dbsp/types/internal - Internal type definitions
 *
 * These types are for internal use by @dbsp adapter implementations.
 * They are NOT part of the public API and may change without notice.
 *
 * @module @dbsp/types/internal
 * @internal
 */

// Builder types (internal only — not part of public API)
export type { IntentBuilder, Mutable } from './builders.js';
// Re-export all public types for convenience
export * from './index.js';
