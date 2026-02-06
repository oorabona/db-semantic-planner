/**
 * @module intent-ast
 * IntentAST (Intent Abstract Syntax Tree) - Query intent representation for db-semantic-planner.
 * Represents user's query intentions before being translated to SQL by adapters.
 *
 * This file is a barrel re-export. Implementation split into intent/ subdirectory.
 */

export * from './intent/expression-intent.js';
export * from './intent/include-intent.js';
export * from './intent/mutation-intent.js';
export * from './intent/operators.js';
export * from './intent/query-intent.js';
export * from './intent/recursive-intent.js';
export * from './intent/recursive-types.js';
export * from './intent/select-intent.js';
export * from './intent/type-guards.js';
export * from './intent/where-intent.js';
