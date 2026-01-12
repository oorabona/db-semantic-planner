/**
 * @db-semantic-planner/core/dx
 * Developer Experience enhancements - strict mode, disambiguation, compat helpers.
 */

// Errors
export {
	AmbiguousRelationError,
	ColumnNotFoundError,
	ExecutionError,
	// Utility for fuzzy matching suggestions
	findClosestMatch,
	InvalidOperationError,
	NotFoundError,
	RelationNotFoundError,
	TableNotFoundError,
	UnsafeOperationError,
} from './errors.js';

// Filter Helpers (Drizzle-like)
export {
	// Logical
	and,
	// Expression
	coalesce,
	// Window function builders (DX-021)
	denseRank,
	// Comparison
	eq,
	// Relation
	exists,
	gt,
	gte,
	// Array
	inArray,
	// Null
	isNotNull,
	isNull,
	lag,
	lead,
	// String
	like,
	lt,
	lte,
	neq,
	not,
	notExists,
	or,
	rank,
	// Raw SQL escape hatch
	raw,
	rowNumber,
	WindowBuilder,
	wAvg,
	wCount,
	wMax,
	wMin,
	wSum,
} from './filters.js';
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
// Mutation Builders (DX-010, DX-026)
export {
	DeleteBuilder,
	InsertBuilder,
	type MutationDump,
	UpdateBuilder,
	// DX-026: Upsert support
	UpsertBuilder,
} from './mutation-builders.js';
// Object Filter Syntax (DX-012)
export {
	type FilterOperators,
	type FilterValue,
	isWhereIntent,
	objectToWhereIntent,
	type WhereFilter,
} from './object-filter.js';
// Factory
export { createOrm } from './orm.js';
// QueryExecutor - handles query execution via adapter
export {
	type CompileOptions as ExecutorCompileOptions,
	type ExecutionContext,
	QueryExecutor,
} from './query-executor.js';
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
// ResultHydrator - handles result hydration and recursive include processing
export {
	type HydrateOptions,
	ResultHydrator,
} from './result-hydrator.js';
// Schema Bridge (ARCH-002 codegen-first)
export {
	// CORE-005: ResolvedSchema → GeneratedSchema converter with Valibot
	assertResolvedSchemaToGeneratedSchema,
	buildModelFromSchema,
	// DX-102: Type inference utilities for createOrm
	type ColumnTypeToTS,
	type GeneratedBelongsTo,
	type GeneratedColumn,
	type GeneratedColumnType,
	type GeneratedConventions,
	type GeneratedHasMany,
	type GeneratedHint,
	type GeneratedManyToMany,
	type GeneratedRelation,
	type GeneratedRelationKind,
	type GeneratedSchema,
	type GeneratedTable,
	// DX-102: Infer DB type from schema
	type InferDBFromSchema,
	type InferRowType,
	isGeneratedSchema,
	// DX-100: Schema type unification - auto-detect and convert ResolvedSchema
	isResolvedSchema,
	normalizeSchema,
	ResolvedSchemaValidation,
	resolvedSchemaToGeneratedSchema,
	type SchemaConversionResult,
	type ValidatedResolvedSchema,
} from './schema-bridge.js';
// Subquery Builder (DX-012 Block 3)
export {
	isSubqueryExpression,
	ref,
	SubqueryBuilder,
	SubqueryExpression,
	subquery,
} from './subquery-builder.js';
// Types
export type {
	AggregateOptions,
	ColumnSpec,
	// Pagination (DX-028)
	CursorPaginatedResult,
	CursorPaginateOptions,
	ExpressionSpec,
	HierarchyOptions,
	IncludeOptions,
	ListHierarchyOptions,
	NestedInclude,
	NullsPosition,
	OrderByInput,
	OrderByRecord,
	OrderBySpec,
	OrmInstance,
	OrmOptions,
	OrmOptionsWithAdapter,
	OrmOptionsWithModel,
	// ARCH-002: Codegen-first schema option
	OrmOptionsWithSchema,
	PaginatedResult,
	PaginateOptions,
	QueryBuilder,
	RelationHints,
	SortDirection,
	StreamOptions,
} from './types.js';
// Type guard
export { isExpressionSpec } from './types.js';
