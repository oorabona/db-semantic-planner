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
	type BatchValuesJoinDecision,
	type CompiledResult,
	type CompilerOptions,
	compilePlan,
	isBatchValuesJoinDecision,
	isJoinDecision,
	isPrecompiledJoinDecision,
	type JoinDecision,
	PlanCompiler,
	type PlanDecision,
	type PrecompiledJoinDecision,
	type SimplifiedPlanReport,
} from './compiler.js';
// DDL Generation
export {
	assertNoRepeatedExpressionSurfaceDrift,
	type ChangeKind,
	CheckConstraintNewEnumValueError,
	type ComparePgsqlDatabaseSchemaOptions,
	type CompareSchemataOptions,
	canGenerateCreateIndex,
	comparePgsqlDatabaseSchema,
	compareSchemata,
	type DiffSummary,
	ExpressionCanonicalizationUnavailableError,
	ensureMigrationsTable,
	type GenerateDDLOptions,
	generateCreateIndex,
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
	NonConvergentSchemaDiffError,
	type ParsedMigrationFile,
	parseMigrationFile,
	recordMigration,
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
export {
	type CanonicalizeCheckConstraintsOptions,
	CheckConstraintCanonicalizationError,
	type CheckConstraintCanonicalizationWarning,
	canonicalizeCheckConstraints,
} from './expression-canonicalizer.js';
// Extensions (pgvector, ParadeDB, PG builtins)
export {
	bm25Search,
	booleanSearch,
	boost,
	cosineDistance,
	generateSeries,
	innerProduct,
	l2Distance,
	nextval,
	parse,
	rawDistance,
	score,
	vectorDims,
} from './extensions/index.js';
// Handler Registry — types only (implementation details remain in ./handlers/index.js)
export type {
	CompilerContext,
	CompilerState,
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
// Redaction (params logging safety)
export {
	DEFAULT_REDACTION_PATTERNS,
	type RedactionConfig,
	type RedactionPattern,
	redactParams,
} from './redact-params.js';
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
	validateSqlExpression,
} from './validate.js';
