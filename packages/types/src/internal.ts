/**
 * @dbsp/types/internal - Internal type definitions
 *
 * These types are for internal use by @dbsp adapter implementations.
 * They are NOT part of the public API and may change without notice.
 *
 * @module @dbsp/types/internal
 * @internal
 */

// Re-export all public types for convenience
export * from './index.js';

// Note: Complex types that depend on @dbsp/core remain in their respective packages
// to avoid circular dependencies. This file exists for future internal-only types
// that don't have external dependencies.
