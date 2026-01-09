/**
 * @db-semantic-planner/dx
 * Developer Experience enhancements - strict mode, disambiguation, compat helpers.
 */

// Re-export types from adapter for dump() and stream()
export type { Dump, DumpMeta } from '@db-semantic-planner/adapter-kysely';
export {
	MissingDependencyError,
	UnsupportedOperationError,
} from '@db-semantic-planner/adapter-kysely';

// Errors
export {
	AmbiguousRelationError,
	ExecutionError,
	InvalidOperationError,
	NotFoundError,
	RelationNotFoundError,
	UnsafeOperationError,
} from './errors.js';
// Filter Helpers (Drizzle-like)
export {
	// Logical
	and,
	// Expression
	coalesce,
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
	// String
	like,
	lt,
	lte,
	neq,
	not,
	notExists,
	or,
	// Raw SQL escape hatch
	raw,
	// Window function builders (DX-021)
	denseRank,
	lag,
	lead,
	rank,
	rowNumber,
	wAvg,
	wCount,
	wMax,
	wMin,
	wSum,
	WindowBuilder,
} from './filters.js';
// Mutation Builders (DX-010)
export {
	DeleteBuilder,
	InsertBuilder,
	type MutationDump,
	UpdateBuilder,
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
	ExpressionSpec,
	HierarchyOptions,
	ListHierarchyOptions,
	IncludeOptions,
	NestedInclude,
	OrmInstance,
	OrmOptions,
	OrmOptionsWithDb,
	OrmOptionsWithModel,
	QueryBuilder,
	RelationHints,
	StreamOptions,
} from './types.js';
// Type guard
export { isExpressionSpec } from './types.js';
