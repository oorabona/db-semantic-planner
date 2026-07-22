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
	type AddedEnumValue,
	assertCreateIndexesSupported,
	assertCreateIndexSupported,
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
	type IndexCapabilityContext,
	IndexFeatureUnsupportedError,
	type IndexRenderSpec,
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
	renderCreateIndex,
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
	type SchemaScopeOptions,
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
	type PgAdvisoryLockKey,
	type PgAdvisoryLockResult,
	PgsqlAdapter,
	type PgsqlAdapterOptions,
	PgsqlAdvisoryLockOptionsError,
	type PgsqlBorrowedClientAdapterOptions,
	PgsqlPinnedConnectionAbortSignalError,
	type PgsqlPoolAdapterOptions,
	PgsqlRawSqlTransactionControlError,
	PgsqlTransactionAbortedCommitError,
	PgsqlTransactionAbortedError,
	PgsqlTransactionAbortSignalError,
	PgsqlTransactionOptionsError,
	PgsqlTransactionTimeoutError,
} from './pgsql-adapter.js';
export { derivePostgresqlCapabilitiesForVersion } from './postgresql-capabilities.js';
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
// ADR-0003 transition planner pack
export {
	ADD_CHECK_RULE_ID,
	ALTER_AUTHORITY_OBSERVATION,
	ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND,
	ALTER_TYPE_ADD_VALUE_OPERATION_KIND,
	type AlterColumnSetNotNullPayload,
	type AlterTypeAddValuePayload,
	ATTACH_LOGICAL_IDENTITY_OPERATION_KIND,
	type AttachLogicalIdentityPayload,
	COLUMN_EXISTS_OBSERVATION,
	createAlterColumnSetNotNullOperationRuntime,
	createAlterTypeAddValueOperationRuntime,
	createAttachLogicalIdentityOperationRuntime,
	createEnumAddValueRule,
	createLogicalIdentityAdoptionRule,
	createManualSqlOperationRuntime,
	createPgObservationIssuer,
	createPgTransitionPack,
	createSetNotNullRule,
	DBSP_LOGICAL_IDENTITY_TABLE,
	DBSP_META_SCHEMA,
	DBSP_TRANSITION_JOURNAL_TABLE,
	DBSP_TRANSITION_RUN_TABLE,
	ENGINE_VERSION_OBSERVATION,
	ENUM_ADD_VALUE_RULE_ID,
	ENUM_LABEL_VISIBLE_OBSERVATION,
	ENUM_TYPE_EXISTS_OBSERVATION,
	type EnumAddValueMatch,
	type EnumAddValueRuleOptions,
	ensureTransitionJournal,
	type IdentityAdoptionAsserter,
	LOGICAL_IDENTITY_ADOPTION_RULE_ID,
	LOGICAL_IDENTITY_CARRIER_OBSERVATION,
	type LogicalIdentityAdoptionMatch,
	type LogicalIdentityAdoptionRuleOptions,
	MANUAL_SQL_OPERATION_KIND,
	type ManualSqlPayload,
	NO_NULLS_GUARD,
	normalizeManualSqlPayload,
	PG_INTROSPECTION_ARTIFACT,
	PG_OPERATION_PACK_ARTIFACT,
	PG_RULE_PACK_ARTIFACT,
	type PgTransitionPackOptions,
	readPgObservationContext,
	readTransitionJournal,
	renderAlterColumnSetNotNullSql,
	renderAlterTypeAddValueSql,
	renderAttachLogicalIdentityLockSql,
	renderCreateDbspMetaSchemaSql,
	renderCreateLogicalIdentityIndexesSql,
	renderCreateLogicalIdentitySideTableSql,
	renderCreateTransitionJournalTableSql,
	renderCreateTransitionRunTableSql,
	renderInsertLogicalIdentitySql,
	renderNoNullsCheckSql,
	renderSetNotNullLockSql,
	SET_NOT_NULL_RULE_ID,
	type SetNotNullMatch,
	type SetNotNullRuleOptions,
} from './transition/index.js';
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
