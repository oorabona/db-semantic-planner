/**
 * @dbsp/core
 * Schema definition and query planning for db-semantic-planner.
 */

// ============================================================================
// ModelIR Types
// ============================================================================

export type {
	Cardinality,
	ColumnIR,
	ColumnType,
	IncludeStrategy,
	IndexIR,
	ModelIR,
	Optionality,
	TableIR,
} from './model-ir.js';

// CLI-NQL: Relation kind helpers and pseudo-column factory

// ============================================================================
// IntentAST Types
// ============================================================================

export type {
	AggregateExpressionIntent,
	AggregateIntent,
	ExpressionIntent,
	IncludeIntent,
	InsertFromIntent,
	InsertIntent,
	JoinIntent,
	MutationIntent,
	OrderByIntent,
	QueryIntent,
	RecursiveIntent,
	SelectAggregateIntent,
	SelectFieldsIntent,
	SelectIntent,
	SelectWithExpressionsIntent,
	SubqueryRefIntent,
	UpsertFromIntent,
	WhereAndIntent,
	WhereComparisonIntent,
	WhereInIntent,
	WhereIntent,
	WhereLikeIntent,
	WhereNotIntent,
	WhereNullIntent,
	WhereOrIntent,
	WhereRangeIntent,
	WindowIntent,
} from './intent-ast.js';
export {
	isDeleteIntent,
	isInsertIntent,
	isUpdateIntent,
	isUpsertIntent,
} from './intent-ast.js';

// ============================================================================
// Schema DSL (User-facing API)
// ============================================================================

// ARCH-005: Unified Schema API
export {
	type ColumnDef,
	getSchemaFromDb,
	isRef,
	type JsonValue,
	type RefOptions,
	ref,
	type Schema,
	type SchemaColumnType,
	type SchemaDefinition,
	type SchemaTableOptions,
	type SelfRefRoles,
	schema,
	type TableDef,
} from './dx/schema.js';

// ============================================================================
// Conventions (pluralization and casing)
// ============================================================================

export {
	IRREGULAR_PLURALS,
	pluralize,
	singularize,
} from './conventions.js';

// ============================================================================
// Semantic Planner
// ============================================================================

export type {
	PlanDecision,
	PlanOptions,
	PlanReport,
	PlanWarning,
} from './planner.js';
export {
	AmbiguousPlanError,
	plan,
	planRecursive,
} from './planner.js';

// ============================================================================
// ADR-0003 Transition Planner Interfaces
// ============================================================================

export type {
	Assumption,
	ProvenPlanStep,
} from './transition/index.js';
export {
	admitRecordedIdentity,
	createStagedTransitionOrchestrator,
	isOperationRuntime,
} from './transition/index.js';

// ============================================================================
// Implementation (for advanced use cases)
// ============================================================================

export { ModelIRImpl } from './model-impl.js';

// ============================================================================
// Adapter Interface (for multi-adapter support)
// ============================================================================

export type {
	Adapter,
	AdapterLogger,
	BaseAdapter,
	CompiledQuery,
	CompileOptions,
	CompilingAdapter,
	DbCasing,
	Dump,
	ExecutingAdapter,
	IntrospectingAdapter,
	RawSqlAdapter,
	StreamingAdapter,
	TransactionalAdapter,
} from './adapter.js';

// ============================================================================
// DX Layer (Developer Experience)
// ============================================================================

export {
	type AfterMutationHook,
	type AfterMutationObserver,
	type AfterQueryHook,
	type AfterQueryObserver,
	type AggregateOptions,
	type AlterColumnOptions,
	AmbiguousRelationError,
	aggOrderBy,
	and,
	any,
	array,
	arrayAgg,
	type BatchValuesOptions,
	type BatchValuesRef,
	type BeforeMutationHook,
	type BeforeQueryHook,
	batchValues,
	boolFn,
	CaseBuilder,
	type CaseValue,
	ColumnNotFoundError,
	type ColumnRef,
	type ColumnSpec,
	type CreateIndexOptions,
	CteBuilder,
	CteQueryBuilder,
	type CursorPaginatedResult,
	type CursorPaginateOptions,
	caseWhen,
	cast,
	coalesce,
	col,
	createHookManager,
	createOrm,
	createRawCteBuilder,
	DeleteBuilder,
	type DistinctField,
	type DropIndexOptions,
	denseRank,
	distinct,
	ErrorCode,
	Errors,
	ExecutionError,
	ExpressionRef,
	type ExpressionSpec,
	emitWarning,
	eq,
	every,
	exists,
	exprRef,
	extractPseudoColumnKeywords,
	type FullTextSearchField,
	fn,
	fullTextSearch,
	getLogger,
	gt,
	gte,
	type HookManager,
	type IncludeOptions,
	type IndexColumnDef,
	type IndexInfo,
	type IndexMethod,
	type InferTableRow,
	InsertBuilder,
	InvalidOperationError,
	inArray,
	inSubquery,
	isBatchValuesRef,
	isDistinctFrom,
	isNotNull,
	isNull,
	isSqlRaw,
	type Logger,
	lag,
	lead,
	like,
	literal,
	lt,
	lte,
	type MutationDump,
	type MutationHookContext,
	NotFoundError,
	type NqlBuilder,
	type NqlTag,
	namedArg,
	neq,
	none,
	not,
	notExists,
	nqlRaw,
	type OnErrorHook,
	type OrmInstance,
	type OrmOf,
	op,
	or,
	outerRef,
	type PaginatedResult,
	type PaginateOptions,
	type PredicateExpressionRef,
	type PredicateRef,
	param,
	type QueryBuilder,
	type QueryHookContext,
	type RangeType,
	type RangeValue,
	RawCteQueryBuilder,
	type RecursiveOptions,
	type RelationHints,
	RelationNotFoundError,
	type RelationRef,
	ResultHydrator,
	rangeContainedBy,
	rangeContains,
	rangeOverlaps,
	rank,
	raw,
	rawExists,
	relationColumn,
	resetLogger,
	rowNumber,
	type SchemaIndexOptions,
	type SchemaOptions,
	type SetOperationBuilder,
	type SqlRawExpression,
	type StreamOptions,
	SubqueryBuilder,
	SubqueryExpression,
	setLogger,
	silentLogger,
	some,
	sql,
	star,
	subquery,
	TABLE_META,
	type TableDDL,
	type TableIndexes,
	TableNotFoundError,
	type TableRef,
	type TruncateOptions,
	textScore,
	UnsafeOperationError,
	UpdateBuilder,
	UpsertBuilder,
	unary,
	unsafeAsPredicate,
	type VacuumOptions,
	type WarningCategory,
	wAvg,
	wCount,
	wMax,
	wMin,
	wSum,
} from './dx/index.js';

// ============================================================================
// Dialect Capabilities (CORE-004)
// ============================================================================

export type { DialectCapabilities } from './dialects/index.js';
export { POSTGRESQL_CAPABILITIES } from './dialects/index.js';

// ============================================================================
// SQL Utilities
// ============================================================================

export { normalizeSQL } from './sql-utils.js';

// ============================================================================
// Assertion System (.assert.dbsp)
// ============================================================================

export type {
	Assertion,
	AssertionOutcome,
	AssertionQueryResult,
	AssertionSummary,
	IntentSummary,
	ParseError,
	ParseResult,
	QueryAssertionResult,
} from './assert/index.js';
export {
	assertEquals,
	assertParamsEquals,
	assertParamsType,
	assertSQLEquals,
	parseAssertionFile,
	runAssertions,
	validateAssertionBlocks,
} from './assert/index.js';

export { InvalidJsonAggPayloadError } from './dx/include-payload-hydration.js';
