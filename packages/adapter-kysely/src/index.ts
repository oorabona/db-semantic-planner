/**
 * @module @db-semantic-planner/adapter-kysely
 * Kysely adapter for db-semantic-planner.
 *
 * Provides SQL compilation and query execution using Kysely.
 */

// Compiler (low-level)
export { compile } from './compiler.js';

// Dialect detection and capabilities (DIALECT-001)
export {
	assertCapability,
	detectDialect,
	getCapabilities,
	getCapabilitiesForDialect,
	getDialectName,
	MSSQL_CAPABILITIES,
	MYSQL_CAPABILITIES,
	POSTGRESQL_CAPABILITIES,
	skipIfMissingCapability,
	SQLITE_CAPABILITIES,
	UNKNOWN_CAPABILITIES,
	withMockedCapabilities,
} from './dialect.js';
export type { DialectCapabilities, DialectName } from './dialect.js';

// Dump API (high-level observability)
export {
	createDump,
	createDumpFromPlan,
	formatDump,
	formatDumpJson,
	toJsonDump,
} from './dump.js';
// Errors
export {
	CompilationError,
	InvalidIdentifierError,
	NotFoundError,
} from './errors.js';
// EXPLAIN API (ADAPTER-004)
export { explain } from './explain.js';
// Redaction API (ADAPTER-004)
export { redactParams } from './redact.js';
export type { StreamQueryOptions } from './stream.js';
// Stream API (STREAMING-001, DIALECT-001)
export {
	assertStreamingSupported,
	MissingDependencyError,
	streamQuery,
	streamRawQuery,
	supportsStreaming,
	UnsupportedOperationError,
} from './stream.js';
// Types
// ADAPTER-004 Types
export type {
	CompileOptions,
	Dump,
	DumpMeta,
	ExplainFormat,
	ExplainOptions,
	ExplainResult,
	FormatDumpJsonOptions,
	JsonDecision,
	JsonDump,
	RedactionOptions,
} from './types.js';
// ADAPTER-004 Constants
export { DEFAULT_REDACTION_PATTERNS, REDACTED_PLACEHOLDER } from './types.js';
