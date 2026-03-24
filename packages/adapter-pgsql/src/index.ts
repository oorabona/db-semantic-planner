/**
 * @dbsp/adapter-pgsql
 *
 * Native PostgreSQL adapter using tree-to-tree transformation:
 * PlanReport → PostgreSQL AST → SQL (via pgsql-deparser)
 */

// Assert & Convention helpers — public API
export {
	DEFAULT_PK_COLUMN,
	defaultFkDerivation,
	type FkColumnDerivation,
} from './assert-field.js';
// AST Helpers — public API (internal helpers remain in ./ast-helpers.js)
export { normalizeSQL } from './ast-helpers.js';
// Compiler
export {
	type CompiledResult,
	type CompilerOptions,
	compilePlan,
	PlanCompiler,
	type PlanDecision,
	type SimplifiedPlanReport,
} from './compiler.js';
// DDL Generation
export {
	acquireMigrationLock,
	type ChangeKind,
	type CompareSchemataOptions,
	compareSchemata,
	type DiffSummary,
	ensureMigrationsTable,
	type GenerateDDLOptions,
	generateDDL,
	generateDownSQL,
	generateMigrationFile,
	generateMigrationSQL,
	getAppliedMigrations,
	getNextSchemaVersion,
	isDestructiveDown,
	isMigrationApplied,
	type MigrationRecord,
	type MigrationSQLOptions,
	mapColumnType,
	mapOnDeleteAction,
	type ParsedMigrationFile,
	parseMigrationFile,
	recordMigration,
	releaseMigrationLock,
	removeMigrationRecord,
	type SchemaChange,
	type SchemaDiff,
	withMigrationLock,
} from './ddl/index.js';
// EXPLAIN support
export {
	buildExplain,
	buildExplainAnalyzeJson,
	buildExplainPlan,
	buildExplainVerbose,
	type ExplainFormat,
	type ExplainOptions,
	type ExplainPlan,
	getRowEstimates,
	getTotalExecutionTime,
	parseExplainJson,
} from './explain/index.js';
// Extensions (pgvector, etc.)
export {
	cosineDistance,
	innerProduct,
	l2Distance,
	rawDistance,
} from './extensions/index.js';
// Handler Registry — types only (implementation details remain in ./handlers/index.js)
export type {
	CompilerContext,
	CompilerDecision,
	CompilerState,
	/** @deprecated Use CompilerDecision instead */
	Decision,
	ExpressionHandler,
	IncludeHandler,
	IncludeResult,
	WhereDispatcher,
	WhereHandler,
} from './handlers/index.js';
// Introspection
export {
	type DetectedHierarchy,
	type IntrospectedModelIR,
	type IntrospectionOptions,
	introspect,
} from './introspection.js';
// Mutations
export {
	buildOnConflictClause,
	type ConflictAction,
	type ConflictTarget,
	compileDelete,
	compileInsert,
	compileMutation,
	compileUpdate,
	compileUpsert,
	conditionalUpdate,
	type DeleteConfig,
	excludedRef,
	type InsertConfig,
	type UpdateConfig,
	type UpsertConfig,
} from './mutations/index.js';
// Naming resolution
export { resolveLogicalName } from './naming.js';
// Naming plugins
export {
	CamelCaseNamingPlugin,
	camelCaseNaming,
	getNamingPluginForDbCasing,
	IdentityNamingPlugin,
	identityNaming,
	type NamingPlugin,
} from './naming-plugin.js';
// ParamRef validation
export {
	collectAndValidateParamRefs,
	createAnyExpr,
	createEqualityExpr,
	createParamRef,
	createTypeCastParamRef,
	type ParamRefValidationResult,
	validateParamRef,
} from './param-ref.js';
// Adapter
export {
	createPgsqlAdapter,
	createPgsqlCompileOnlyAdapter,
	PgsqlAdapter,
	type PgsqlAdapterOptions,
} from './pgsql-adapter.js';
// Set operations (UNION/INTERSECT/EXCEPT)
export {
	compileSetOperation,
	createLeafCompileFn,
	type LeafCompileFn,
	type SetOperationResult,
} from './set-operation.js';
// Streaming (cursor-based)
export {
	buildCloseCursor,
	buildDeclareCursor,
	buildFetch,
	buildFetchAll,
	buildFetchFirst,
	buildFetchForward,
	buildFetchNext,
	buildStreamingStatements,
	type CursorHoldOption,
	type CursorOptions,
	type CursorScrollOption,
	type FetchDirection,
	type FetchOptions,
	generateCursorName,
	type StreamConfig,
} from './streaming/index.js';
// Validation
export {
	InvalidIdentifierError,
	isReservedKeyword,
	sanitizeForDisplay,
	validateIdentifier,
	validateIdentifiers,
	validateQualifiedIdentifier,
} from './validate.js';
