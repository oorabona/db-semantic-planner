/**
 * @dbsp/types - Shared type definitions for @dbsp packages
 *
 * This package contains types that are shared across multiple @dbsp packages
 * without introducing circular dependencies.
 *
 * @module @dbsp/types
 */

// Adapter types (interfaces, options, dump)
export * from './adapter.js';
// Builder types (for internal use across packages)
export type { IntentBuilder, Mutable } from './builders.js';
// Dialect types (capabilities, column type unions)
export * from './dialects.js';
// IntentAST types (shared between core and nql)
export * from './intent-ast.js';
// ModelIR types (schema representation)
export * from './model-ir.js';
// Planner types (plan report, decisions, warnings)
export * from './planner.js';
// Shared utility types
export type { RangeValue, SortDirection } from './shared/utils.js';
