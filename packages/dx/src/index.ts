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
	type WhereFilter,
	isWhereIntent,
	objectToWhereIntent,
} from './object-filter.js';

// Factory
export { createOrm } from './orm.js';
export type {
	AdjacencyOptions,
	EdgeTableOptions,
	JoinOptions,
	PathOptions,
	SelectField,
	TraversalDirection,
} from './recursive-query-builder.js';

// Recursive Query Builder (DX-005)
export {
	createRecursiveBuilder,
	RecursiveQueryBuilder,
} from './recursive-query-builder.js';
// Types
export type {
	AggregateOptions,
	HierarchyOptions,
	IncludeOptions,
	NestedInclude,
	OrmInstance,
	OrmOptions,
	OrmOptionsWithDb,
	OrmOptionsWithModel,
	QueryBuilder,
	RelationHints,
	StreamOptions,
	WindowOptions,
} from './types.js';

// Subquery Builder (DX-012 Block 3)
export {
	SubqueryBuilder,
	SubqueryExpression,
	subquery,
	ref,
	isSubqueryExpression,
} from './subquery-builder.js';
