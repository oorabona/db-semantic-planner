/**
 * @module intent-ast
 * IntentAST (Intent Abstract Syntax Tree) - Query intent representation for db-semantic-planner.
 *
 * This module re-exports all IntentAST types and type guards from @dbsp/types.
 * The canonical source is @dbsp/types/intent-ast.
 *
 * @since ARCH-007: Types centralized in @dbsp/types to avoid circular dependencies.
 */

// Re-export everything from @dbsp/types (types + type guards + helpers)
export * from '@dbsp/types';
