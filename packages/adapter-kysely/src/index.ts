/**
 * @module @db-semantic-planner/adapter-kysely
 * Kysely adapter for db-semantic-planner.
 *
 * Provides SQL compilation and query execution using Kysely.
 */

// Compiler (low-level)
export { compile } from './compiler.js';
// Dump API (high-level observability)
export { createDump, createDumpFromPlan, formatDump } from './dump.js';
// Errors
export {
	CompilationError,
	InvalidIdentifierError,
	NotFoundError,
} from './errors.js';
// Types
export type { CompileOptions, Dump, DumpMeta } from './types.js';
