/**
 * @dbsp/core/dx
 * Developer Experience enhancements - strict mode, disambiguation, type-safe queries.
 */

// BatchValues (FR-3)
export {
	type BatchValuesOptions,
	type BatchValuesRef,
	batchValues,
	isBatchValuesRef,
	// @internal — exported for adapter compile-time type-name revalidation
	validateTypeName,
} from './batch-values.js';
// CASE WHEN expression builder (FR-6)
export {
	CaseBuilder,
	type CaseValue,
	caseWhen,
} from './case-when-builder.js';
// CTE Builder (BATCH-001 Block 5)
export {
	CteBuilder,
	type CteDump,
	CteQueryBuilder,
} from './cte-builder.js';
// Errors
export {
	AmbiguousRelationError,
	ColumnNotFoundError,
	// Error codes for programmatic handling
	ErrorCode,
	// Error factory (AUD-011)
	Errors,
	ExecutionError,
	// Utility for fuzzy matching suggestions
	findClosestMatch,
	InvalidOperationError,
	// Convention mismatch (ARCH-006)
	NamingConventionMismatchError,
	NotFoundError,
	RelationNotFoundError,
	TableNotFoundError,
	UnsafeOperationError,
} from './errors.js';
// Expression primitives (EXT-001)
export {
	aggOrderBy,
	array,
	arrayAgg,
	boolFn,
	cast,
	ExpressionRef,
	type ExprInput,
	fn,
	isPredicateRef,
	literal,
	namedArg,
	op,
	PREDICATE_REF_DISCRIMINATOR,
	type PredicateExpressionRef,
	type PredicateOperator,
	type PredicateRef,
	param,
	ref as exprRef,
	star,
	stringAgg,
	unary,
	unsafeAsPredicate,
} from './expressions.js';
// Feature negotiation (OCP-001: FeatureChecker registry)
export {
	DEFAULT_FEATURE_CHECKERS,
	type FeatureChecker,
	type FeatureUsage,
} from './feature-checkers.js';
// Filter Helpers (Drizzle-like)
export {
	// Logical
	and,
	// Array
	any,
	// Expression
	coalesce,
	// Column alias expression helper
	col,
	type DistinctField,
	// Window function builders (DX-021)
	denseRank,
	// Distinct helper for aggregates (DX-034)
	distinct,
	// Comparison
	eq,
	// Relation quantifiers (DX-040 Block 7)
	every,
	// Relation
	exists,
	gt,
	gte,
	inArray,
	inSubquery,
	// Type guards
	isDistinctField,
	isDistinctFrom,
	// Null
	isNotNull,
	isNull,
	// Raw SQL set expression (for doUpdate() / set() mutations)
	isSqlRaw,
	lag,
	lead,
	// String
	like,
	lt,
	lte,
	neq,
	none,
	not,
	notExists,
	or,
	rank,
	// Raw SQL escape hatch
	raw,
	rawExists,
	rawNotExists,
	// Relation column (select from joined table)
	relationColumn,
	rowNumber,
	SQL_RAW_MARKER,
	type SqlRawExpression,
	some,
	sql,
	WindowBuilder,
	wAvg,
	wCount,
	wMax,
	wMin,
	wSum,
} from './filters.js';
// Full-Text Search Helpers (FR-5)
export {
	type FullTextSearchField,
	type FullTextSearchOptions,
	fullTextSearch,
	textScore,
} from './full-text-search.js';
// ARCH-008: Hook composition utilities
export {
	composeAfterMutationHooks,
	composeAfterQueryHooks,
	composeBeforeMutationHooks,
	composeBeforeQueryHooks,
	composeOnErrorHooks,
	type HookPriority,
	type PrioritizedHook,
	pipeAfterMutationHooks,
	pipeAfterQueryHooks,
	pipeBeforeMutationHooks,
	pipeBeforeQueryHooks,
	pipeOnErrorHooks,
	sortByPriority,
	withPriority,
} from './hook-utils.js';
// E17b: Query/Mutation Hooks
export {
	type AfterMutationHook,
	type AfterMutationObserver,
	type AfterQueryHook,
	type AfterQueryObserver,
	type BeforeMutationHook,
	type BeforeQueryHook,
	createHookManager,
	type ErrorHookContext,
	type HookErrorHandler,
	type HookManager,
	type MutationHookContext,
	type MutationOperation,
	type ObserverErrorHandler,
	type OnErrorHook,
	type QueryHookContext,
	type QueryResultType,
} from './hooks.js';
// DX-103: Extracted components for SRP compliance
// IntentBuilder - builds QueryIntent AST from builder state
export {
	IntentBuilder,
	type IntentBuilderState,
	isRecursiveIncludeOptions,
	type RecursiveIncludeConfig,
	validateRecursiveInclude,
} from './intent-builder.js';
// Lightweight ModelIR (DX-023)
export {
	type CardinalityShorthand,
	type DefineModelOptions,
	defineModel,
	InvalidRelationDefinitionError,
	inferForeignKey,
	isCardinalityShorthand,
	isRelationObjectDef,
	isRelationTupleDef,
	type LightweightRelationsDef,
	type ParsedRelationDef,
	type ParsedRelationKey,
	parseRelationDef,
	parseRelationKey,
	type RelationKey,
	type RelationObjectDef,
	type RelationShorthand,
	type RelationTupleDef,
	singularize,
} from './lightweight-model.js';
// E10: Injectable Logger
export {
	defaultLogger,
	type EmitWarningOptions,
	emitWarning,
	getLogger,
	type Logger,
	resetLogger,
	setLogger,
	silentLogger,
	type WarningCategory,
} from './logger.js';
// Mutation Builders (DX-010, DX-026)
export {
	DeleteBuilder,
	InsertBuilder,
	type MutationDump,
	UpdateBuilder,
	// DX-026: Upsert support
	UpsertBuilder,
} from './mutation-builders.js';
export {
	type NegotiationResult,
	negotiateFeatures,
} from './negotiate-features.js';
// NQL Template Literal API (DX-040 Block 8)
export {
	createNqlTag,
	extractPseudoColumnKeywords,
	type NqlBuilder,
	type NqlRawFragment,
	type NqlTag,
	nqlRaw,
} from './nql.js';
// Object Filter Syntax (DX-012)
export {
	type FilterOperators,
	type FilterValue,
	isWhereIntent,
	objectToWhereIntent,
	type WhereFilter,
} from './object-filter.js';
// Factory
export {
	createOrm,
	// ARCH-006: Simplified ORM options (preferred)
	type SimplifiedOrmOptions,
} from './orm.js';
export type { OrmOf } from './orm-instance-types.js';
// Range Operator Helpers (PostgreSQL) — tuple API + backward-compat object API
export {
	type RangeType,
	type RangeValue,
	rangeContainedBy,
	rangeContains,
	rangeOverlaps,
} from './range.js';
// Raw CTE Builder — WITH RECURSIVE (FR-8)
export {
	createRawCteBuilder,
	RawCteQueryBuilder,
	type RecursiveDump,
	type RecursiveOptions,
} from './raw-cte-builder.js';
// NOTE: RecursiveQueryBuilder is now internal-only (DX-022)
// Use include({ recursive: true }) API instead
// Type exports kept for edge-table support (internal use)
export type {
	AdjacencyOptions,
	EdgeTableOptions,
	JoinOptions,
	PathOptions,
	SelectField,
	TraversalDirection,
} from './recursive-query-builder.js';
// Relation path identity helpers shared by planner/adapter/hydration code.
export {
	countDistinctRelationPathsByName,
	deriveRelationPathFromIntentPath,
	type RelationPathIncludeNode,
	type RelationPathUsage,
} from './relation-paths.js';
// ResultHydrator - handles result hydration and recursive include processing
export {
	type HydrateOptions,
	ResultHydrator,
} from './result-hydrator.js';
// ARCH-005: Unified Schema API
export {
	type ColumnDef,
	type ColumnJsReadType,
	// E17: Default filters (soft delete)
	type DefaultFilters,
	type GetSchemaFromDbOptions,
	// ARCH-006: Database introspection → Schema
	getSchemaFromDb,
	// Type inference helpers (ARCH-006)
	type InferColumn,
	type InferColumnNonNull,
	type InferColumnType,
	type InferDB,
	type InferRefColumn,
	type InferRow,
	type InferredRangeValue,
	type InferSchemaDB,
	isRef,
	type JsonValue,
	type RefDefinition,
	type RefOptions,
	ref,
	type Schema,
	type SchemaColumnType,
	type SchemaConstraints,
	type SchemaDefinition,
	type SchemaExtras,
	type SchemaIndexOptions,
	// E17: Schema options with default filters
	type SchemaOptions,
	type SchemaTableOptions,
	SchemaValidationError,
	SchemaValidationError as SchemaError,
	type SelfRefRoles,
	schema,
	schemaToModelIR,
	type TableDef,
} from './schema.js';
// DX-040-SURFACE: InferTables utility type for typed table refs
export type { InferTables } from './schema-tables-types.js';
// Set Operation Builder (UNION / INTERSECT / EXCEPT)
export type {
	SetOperationBuilder,
	// SetOperationBuilderImpl is intentionally NOT exported — @internal implementation class.
	// Consumers use the SetOperationBuilder interface returned by .union()/.intersect() etc.
} from './set-operation-builder.js';
// Subquery Builder (DX-012 Block 3)
export {
	isSubqueryExpression,
	outerRef,
	SubqueryBuilder,
	SubqueryExpression,
	subquery,
} from './subquery-builder.js';
// DX-040: Type-safe table reference types
export {
	// Symbols for metadata access
	BRAND,
	// Symbol key types
	type BrandKey,
	COLUMN_META,
	type ColumnMetaKey,
	RELATION_META,
	type RelationMetaKey,
	TABLE_META,
	type TableMetaKey,
} from './symbols.js';
// DDL-TABLE-001: Table-scoped DDL types
export type {
	AlterColumnOptions,
	CreateIndexOptions,
	DropIndexOptions,
	IndexColumnDef,
	IndexInfo,
	IndexMethod,
	ListIndexOptions,
	TableDDL,
	TableIndexes,
	TruncateOptions,
	VacuumOptions,
} from './table-ddl-types.js';
export {
	// Types
	type AliasedColumn,
	type AllColumns,
	type ColumnRef,
	type InferColumnTypes,
	type InferTableRow,
	// Type guards
	isAliasedColumn,
	isAllColumns,
	isColumnRef,
	isRelationRef,
	isTableRef,
	type RelationRef,
	type RelationType,
	type TableRef,
} from './table-ref.js';
// Types
export type {
	AggregateOptions,
	AliasedExprColumn,
	ColumnSpec,
	// Pagination (DX-028)
	CursorPaginatedResult,
	CursorPaginateOptions,
	DumpMetaInput,
	ExpressionSpec,
	HierarchyOptions,
	IncludeOptions,
	IncludeOptionsWithRecursive,
	ListHierarchyOptions,
	NestedInclude,
	NullsPosition,
	OrderByInput,
	OrderByRecord,
	OrderBySpec,
	OrmInstance,
	// OrmInstanceInternal is intentionally NOT exported — @internal.
	// Internal consumers cast via: `const internal = orm as OrmInstanceInternal<DB>`
	// after importing OrmInstanceInternal directly from './dx/orm-instance-types.js'.
	OrmOptions,
	OrmOptionsWithAdapter,
	OrmOptionsWithModel,
	PaginatedResult,
	PaginateOptions,
	QueryBuilder,
	RelationHints,
	SortDirection,
	StreamOptions,
} from './types.js';
// Type guard
export { isExpressionSpec } from './types.js';
