/**
 * @dbsp/core
 * Schema definition and query planning for db-semantic-planner.
 */

// ============================================================================
// ModelIR Types
// ============================================================================

export type {
	// ModelIR
	AmbiguityCheckResult,
	Cardinality,
	// Core interfaces
	ColumnIR,
	// Column types
	ColumnType,
	FilterStrategy,
	ForeignKeyIR,
	IncludeStrategy,
	// Index definition
	IndexIR,
	JoinDefault,
	ModelIR,
	OnDeleteAction,
	Optionality,
	// Partition configuration (parent table only)
	PartitionIR,
	// CLI-NQL: Pseudo-columns for self-referential FKs
	PseudoColumnMetadata,
	// CLI-NQL: Recursive relation metadata
	RecursiveMetadata,
	RelationIR,
	// CLI-NQL: Relation kind (database perspective)
	RelationKind,
	// Relation types
	RelationType,
	RequiredEnumLabelIR,
	TableIR,
} from './model-ir.js';

// CLI-NQL: Relation kind helpers and pseudo-column factory
export {
	createPseudoColumnMetadata,
	createRecursiveMetadata,
	getRelationKind,
	isRecursiveRelation,
	isSelfReferential,
} from './model-ir.js';

// ============================================================================
// IntentAST Types
// ============================================================================

export type {
	// Recursive CTE (RFC-001)
	AdjacencyTraversal,
	// Expressions
	AggregateExpressionIntent,
	// Aggregates
	AggregateFunction,
	AggregateIntent,
	// Window Functions (P3-A)
	AggregateWindowFunction,
	// Operators
	ArrayOperator,
	CaseExpressionIntent,
	CoalesceExpressionIntent,
	ColumnAliasIntent,
	ColumnExpressionIntent,
	ComparisonExpressionIntent,
	ComparisonOperator,
	CustomTraversal,
	// Mutations (DX-010)
	DeleteIntent,
	EdgeTableTraversal,
	// Emit composition (DX-005)
	EmitJoinClause,
	ExpressionIntent,
	// Include
	IncludeIntent,
	InsertFromIntent,
	InsertIntent,
	// Join (FR-10)
	JoinIntent,
	LiteralExpressionIntent,
	LogicalOperator,
	MutationIntent,
	NullOperator,
	NullsPosition,
	OffsetWindowFunction,
	// OrderBy
	OrderByIntent,
	// Pseudo-columns (Self-Referential Traversal)
	PseudoColumnExpressionIntent,
	PseudoColumnTraversal,
	// Query
	QueryIntent,
	RangeOperator,
	RankingWindowFunction,
	RawExpressionIntent,
	RecursiveAdvancedOptions,
	RecursiveDedupe,
	// Recursive EXISTS (CLI-NQL Block 7)
	RecursiveDirection,
	RecursiveEmitOptions,
	RecursiveExistsOptions,
	RecursiveIntent,
	RecursiveNodeIdExpr,
	RecursiveTrackOptions,
	RecursiveTraversal,
	RelationColumnIntent,
	RelationOperator,
	SelectAggregateIntent,
	// Select
	SelectAllIntent,
	SelectFieldsIntent,
	SelectIntent,
	SelectWithExpressionsIntent,
	SortDirection,
	StringOperator,
	SubqueryRefIntent,
	UpdateIntent,
	// Upsert (DX-026)
	UpsertConflictAction,
	UpsertConflictTarget,
	UpsertFromIntent,
	UpsertIntent,
	// Where (filters)
	WhereAndIntent,
	WhereAnyIntent,
	WhereComparisonIntent,
	WhereExistsIntent,
	WhereInIntent,
	WhereIntent,
	WhereLikeIntent,
	WhereNotExistsIntent,
	WhereNotIntent,
	WhereNullIntent,
	WhereOrIntent,
	// Range (PostgreSQL P3-C)
	WhereRangeIntent,
	WhereRelationFilterIntent,
	// Subquery (DX-012)
	WhereSubqueryIntent,
	// Window Functions (P3-A)
	WindowFunction,
	WindowIntent,
	WindowOrderBy,
} from './intent-ast.js';
export {
	// Recursive CTE helpers (RFC-001)
	getNodeIdAlias,
	// Recursive CTE type guards (RFC-001)
	isAdjacencyTraversal,
	// Window function type guards (P3-A)
	isAggregateWindowFunction,
	// Type guards
	isCoalesceExpression,
	isColumnAliasExpression,
	isCustomTraversal,
	// Mutation type guards (DX-010)
	isDeleteIntent,
	isEdgeTableTraversal,
	isInsertIntent,
	isMutationIntent,
	isRankingWindowFunction,
	isRawExpression,
	isRecursiveIntent,
	isRelationColumnExpression,
	isSelectAggregate,
	isSelectAll,
	isSelectFields,
	isSelectWithExpressions,
	isSubqueryRef,
	isUpdateIntent,
	// Upsert type guard (DX-026)
	isUpsertIntent,
	isWhereAnd,
	isWhereAny,
	isWhereComparison,
	isWhereExists,
	isWhereIn,
	isWhereLike,
	isWhereLogical,
	isWhereNot,
	isWhereNotExists,
	isWhereNull,
	isWhereOr,
	// Range type guard (P3-C)
	isWhereRange,
	isWhereRelationBased,
	isWhereRelationFilter,
	// Subquery type guards (DX-012)
	isWhereSubquery,
	// Window function type guards (P3-A)
	isWindowIntent,
} from './intent-ast.js';

// ============================================================================
// Schema DSL (User-facing API)
// ============================================================================

// ARCH-005: Unified Schema API
export {
	type ColumnDef,
	type GetSchemaFromDbOptions,
	// ARCH-006: Database introspection → Schema
	getSchemaFromDb,
	isRef,
	type RefDefinition,
	type RefOptions,
	ref,
	type Schema,
	type SchemaColumnType,
	type SchemaColumnType as NewSchemaColumnType,
	type SchemaConstraints,
	type SchemaDefinition,
	type SchemaIndexValidationInput,
	type SchemaTableOptions,
	SchemaValidationError,
	SchemaValidationError as SchemaError,
	type SelfRefRoles,
	schema,
	schemaToModelIR,
	type TableDef,
	validateSchemaIndexOptions,
} from './dx/schema.js';

// ============================================================================
// Conventions (pluralization and casing)
// ============================================================================

export {
	capitalize,
	decapitalize,
	IRREGULAR_PLURALS,
	pluralize,
	singularize,
} from './conventions.js';

// ============================================================================
// Semantic Planner
// ============================================================================

export type {
	// Plan types
	CTEDefinition,
	DecisionType,
	PlanDecision,
	PlanOptions,
	PlanReport,
	PlanWarning,
	PlanWarningCode,
	// Recursive CTE planning (RFC-001)
	RecursivePlanOptions,
	RecursivePlanReport,
	// Include strategy (CORE-006)
	ResolvedIncludeStrategy,
} from './planner.js';
export {
	// Errors
	AmbiguousPlanError,
	// Entry points
	plan,
	planRecursive,
	RecursiveShapeMismatchError,
	// Include strategy errors (CORE-006)
	UnsupportedStrategyError,
	// Recursive CTE helpers
	validateRecursiveShape,
} from './planner.js';

// ============================================================================
// ADR-0003 Transition Planner Interfaces
// ============================================================================

export type {
	ApplicableAssessment,
	ApplicableEvaluation,
	Applier,
	ApplyPolicy,
	CapabilityDescriptor,
	CheckDelta,
	Comparator,
	CompareOutcome,
	EnumAddDelta,
	EstablishedProofClaim,
	GuardExecutionResult,
	InapplicableAssessment,
	InProcessProvenPlan,
	ObservationIssuer,
	OperationEffectAssessment,
	OperationFingerprints,
	OperationObservation,
	OperationRuntime,
	OperationSemantics,
	ProvenApplyGuard,
	ProvenGuardProtocol,
	ProvenPlanShape,
	ProvenPlanStep,
	ProveOutcome,
	Prover,
	RecognitionResult,
	RegisteredOperationSemantics,
	RuleEvaluation,
	RuleSupport,
	SerializedProvenPlan,
	StagedCompositionCandidate,
	StagedCompositionPreflight,
	StagedCompositionPreflightInput,
	StagedTransitionInput,
	StagedTransitionOrchestrator,
	TransitionCandidate,
	TransitionConnectionPool,
	TransitionExecutionClient,
	TransitionPack,
	TransitionQueryClient,
	TransitionRelationalValidationInput,
	TransitionRelationalValidationResult,
	TransitionRule,
} from './transition/index.js';
export {
	advisoryObservationId,
	assumptionId,
	checkDelta,
	chooseReadyCandidate,
	claimId,
	createApplier,
	createComparator,
	createPackRegistry,
	createProver,
	createStagedTransitionOrchestrator,
	enumAddDelta,
	evidenceId,
	isOperationRuntime,
	PackRegistry,
	preflightStagedComposition,
	projectCompareToSingleCandidate,
	semanticArtifactId,
	validateTransitionRelationalInvariants,
} from './transition/index.js';

// ============================================================================
// Implementation (for advanced use cases)
// ============================================================================

export { ModelIRImpl } from './model-impl.js';

// ============================================================================
// Adapter Interface (for multi-adapter support)
// ============================================================================

export type {
	// Full adapter type (all capabilities)
	Adapter,
	AdapterCapabilities,
	AdapterLogger,
	AdapterStreamOptions,
	// DX-104: Split interfaces (ISP compliance)
	AliasIncludedColumnsMode,
	BaseAdapter,
	CompiledQuery,
	CompileOnlyAdapter,
	CompileOptions,
	// DX-033: Include hydration
	CompileResultWithIncludes,
	CompilingAdapter,
	// PGSQL-PHASE2: Intuitive DB casing convention
	DbCasing,
	DDLGeneratingAdapter,
	Dump,
	DumpMeta,
	ExecutingAdapter,
	IntrospectingAdapter,
	RawSqlAdapter,
	StreamingAdapter,
	SubqueryIncludeInfo,
	TransactionalAdapter,
} from './adapter.js';
export {
	AdapterRequiredError,
	assertCapability,
	// DX-104: Feature detection helpers
	supportsDDLGeneration,
	supportsExecution,
	supportsIntrospection,
	supportsRawSql,
	supportsStreaming,
	supportsTransactions,
	UnsupportedCapabilityError,
} from './adapter.js';

// ============================================================================
// DX Layer (Developer Experience)
// ============================================================================

export * from './dx/index.js';
export { UnsupportedFeatureError } from './dx/negotiate-features.js';

// ============================================================================
// Dialect Capabilities (CORE-004)
// ============================================================================

export type {
	// Types
	CommonColumnType,
	DialectCapabilities,
	DialectName,
	DuckDBColumnType,
	IsTypeSupported,
	MSSQLColumnType,
	MySQLColumnType,
	PostgresColumnType,
	PostgresOnlyColumnType,
	SQLiteColumnType,
	SupportedColumnTypes,
} from './dialects/index.js';
export {
	// Functions
	assertTypeSupported,
	createDialectCapabilities,
	// Constants
	DUCKDB_CAPABILITIES,
	extendDialect,
	getAvailableDialects,
	getDialectCapabilities,
	isKnownDialect,
	MSSQL_CAPABILITIES,
	MYSQL_CAPABILITIES,
	POSTGRESQL_CAPABILITIES,
	registerDialect,
	SQLITE_CAPABILITIES,
	// Errors
	UnhandledTypeInDialect,
	UnknownDialectError,
} from './dialects/index.js';

// ============================================================================
// SQL Utilities
// ============================================================================

export { normalizeSQL } from './sql-utils.js';

// ============================================================================
// Assertion System (.assert.dbsp)
// ============================================================================

export type {
	Assertion,
	AssertionBlock,
	AssertionOutcome,
	AssertionQueryResult,
	AssertionSummary,
	AssertionType,
	IntentSummary,
	ParseError,
	ParseResult,
	QueryAssertionResult,
	TableAssertionData,
} from './assert/index.js';
export {
	// Parser
	ASSERTION_TYPES,
	// Individual assertion functions
	assertContains,
	assertDbColumnExists,
	assertDbOutput,
	assertDbRowsEquals,
	assertDbRowsMax,
	assertDbRowsMin,
	assertDbValueEquals,
	assertEquals,
	assertIntentHasGroupBy,
	assertIntentHasOrderBy,
	assertIntentHasWhere,
	assertIntentTable,
	assertIntentType,
	assertIntentWith,
	assertMatches,
	assertParamsEquals,
	assertParamsLength,
	assertParamsType,
	assertParamsValue,
	assertSQLColumn,
	assertSQLEquals,
	assertSQLJoin,
	assertSQLTable,
	assertSuccess,
	isOverallSuccess,
	parseAssertionFile,
	requiresDatabase,
	resolveQueryIndex,
	// Runner
	runAssertions,
	validateAssertionBlocks,
} from './assert/index.js';
