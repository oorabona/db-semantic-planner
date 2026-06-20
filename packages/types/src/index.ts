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
// Shared relation-key helpers
export * from './column-list.js';
// Dialect types (capabilities, column type unions)
export * from './dialects.js';
// IntentAST types (shared between core and nql)
export * from './intent-ast.js';
// Dialect-neutral json_agg include order-key resolution
export * from './json-agg-order-key.js';
// LoadedSchema + isValidSchema (canonical cross-package type, consumed by cli, gui, mcp-server)
export type { LoadedSchema } from './loaded-schema.js';
export { isValidSchema } from './loaded-schema.js';
// ModelIR types (schema representation)
export * from './model-ir.js';
// Planner types (plan report, decisions, warnings)
export * from './planner.js';
// Dialect-neutral RelationIR key-field builder
export * from './relation-key-fields.js';
// Shared utility types
export type { RangeValue, SortDirection } from './shared/utils.js';
