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
	// CLI-NQL: Recursive relation metadata
	RecursiveMetadata,
	RelationIR,
	// CLI-NQL: Relation kind (database perspective)
	RelationKind,
	// Relation types
	RelationType,
	TableIR,
} from './model-ir.js';

// CLI-NQL: Relation kind helpers
export {
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
	// Aggregates
	AggregateFunction,
	AggregateIntent,
	// Window Functions (P3-A)
	AggregateWindowFunction,
	// Operators
	ArrayOperator,
	// Expressions
	CoalesceExpressionIntent,
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
	InsertIntent,
	LogicalOperator,
	MutationIntent,
	NullOperator,
	NullsPosition,
	OffsetWindowFunction,
	// OrderBy
	OrderByIntent,
	// Query
	QueryIntent,
	RangeOperator,
	RankingWindowFunction,
	RawExpressionIntent,
	RecursiveAdvancedOptions,
	RecursiveDedupe,
	RecursiveEmitOptions,
	RecursiveIntent,
	RecursiveNodeIdExpr,
	RecursiveTrackOptions,
	RecursiveTraversal,
	RelationOperator,
	ScalarSubqueryIntent,
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
	UpsertIntent,
	// Where (filters)
	WhereAndIntent,
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
	isCustomTraversal,
	// Mutation type guards (DX-010)
	isDeleteIntent,
	isEdgeTableTraversal,
	isInsertIntent,
	isMutationIntent,
	isRankingWindowFunction,
	isRawExpression,
	isRecursiveIntent,
	isSelectAggregate,
	isSelectAll,
	isSelectFields,
	isSelectWithExpressions,
	isSubqueryRef,
	isUpdateIntent,
	// Upsert type guard (DX-026)
	isUpsertIntent,
	isWhereAnd,
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
// Schema Builder
// ============================================================================

export type {
	// Builder types
	ColumnDef,
	ColumnDefInput,
	ModelRef,
	RelationDef,
	RelationHints,
	RelationsDef,
	SchemaBuilder,
	SchemaBuilderWithRelations,
	TableDef,
} from './schema-builder.js';
export {
	belongsTo,
	belongsToMany,
	// Builder entry point (returns SchemaBuilder)
	defineSchemaBuilder,
	hasMany,
	// Relation helpers
	hasOne,
} from './schema-builder.js';

// ============================================================================
// Schema DSL (User-facing API)
// ============================================================================

export {
	// Main entry point for schema definition
	defineSchema,
	SchemaValidationError,
} from './schema-dsl.js';
export type {
	// Output
	ResolvedSchema,
	SchemaBelongsToRelation,
	SchemaCardinality,
	SchemaColumnDefinition,
	// Column types
	SchemaColumnType,
	// Config
	SchemaConfigInput,
	// Conventions
	SchemaConventionsDefinition,
	SchemaDefinitionInput,
	// Hints
	SchemaFilterStrategy,
	SchemaForeignKeyReference,
	SchemaHasManyRelation,
	SchemaHintDefinition,
	SchemaHintsDefinition,
	// Index types
	SchemaIndexDefinition,
	SchemaIndexesDefinition,
	SchemaManyToManyRelation,
	SchemaOnDeleteAction,
	SchemaRelationDefinition,
	// Relation types
	SchemaRelationKind,
	SchemaRelationsDefinition,
	SchemaTableDefinition,
	SchemaTablesDefinition,
} from './schema-dsl-types.js';
export {
	// Type guards
	isBelongsTo,
	isHasMany,
	isManyToMany,
} from './schema-dsl-types.js';

// ============================================================================
// Conventions (FK detection, pluralization)
// ============================================================================

export {
	capitalize,
	DEFAULT_CONVENTIONS,
	decapitalize,
	detectForeignKeys,
	detectManyToMany,
	inferRelationsFromSchema,
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
	AdapterStreamOptions,
	// DX-104: Split interfaces (ISP compliance)
	AliasIncludedColumnsMode,
	BaseAdapter,
	BasicAdapter,
	CompiledQuery,
	CompileOnlyAdapter,
	CompileOptions,
	// DX-033: Include hydration
	CompileResultWithIncludes,
	CompilingAdapter,
	DDLGeneratingAdapter,
	Dump,
	DumpMeta,
	ExecutingAdapter,
	IntrospectingAdapter,
	RawSqlAdapter,
	SeparateIncludeInfo,
	StreamingAdapter,
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
