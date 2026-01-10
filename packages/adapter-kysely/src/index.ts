/**
 * @module @db-semantic-planner/adapter-kysely
 * Kysely adapter for db-semantic-planner.
 *
 * Provides SQL compilation and query execution using Kysely.
 */

// Compiler (low-level)
export {
	type CompileResultWithIncludes,
	compile,
	compileDelete,
	compileInsert,
	compileRecursive,
	compileSeparateInclude,
	compileUpdate,
	// DX-026: Upsert support
	compileUpsert,
	compileWindowSelect,
	compileWithIncludes,
	type InternalCompileOptions,
	type SeparateIncludeInfo,
} from './compiler.js';
export type { DialectCapabilities, DialectName } from './dialect.js';
// Dialect detection and capabilities (DIALECT-001)
export {
	assertCapability,
	assertWindowFunctionsSupported,
	detectDialect,
	getCapabilities,
	getCapabilitiesForDialect,
	getDialectName,
	MSSQL_CAPABILITIES,
	MYSQL_CAPABILITIES,
	POSTGRESQL_CAPABILITIES,
	SQLITE_CAPABILITIES,
	skipIfMissingCapability,
	supportsWindowFunctions,
	UNKNOWN_CAPABILITIES,
	withMockedCapabilities,
} from './dialect.js';
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
	validateIdentifier,
} from './errors.js';
// EXPLAIN API (ADAPTER-004)
export { explain } from './explain.js';
export type {
	DetectedHierarchy,
	ForeignKeyInfo,
	IntrospectedModelIR,
	IntrospectionOptions,
} from './introspection.js';
// Introspection (ADAPTER-006)
export { introspect } from './introspection.js';
// KyselyAdapter (high-level adapter interface implementation)
export { createKyselyAdapter, KyselyAdapter } from './kysely-adapter.js';
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
