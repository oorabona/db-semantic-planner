/**
 * @db-semantic-planner/core
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
	JoinDefault,
	ModelIR,
	OnDeleteAction,
	Optionality,
	RelationIR,
	// Relation types
	RelationType,
	TableIR,
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
	// Operators
	ArrayOperator,
	// Expressions
	CoalesceExpressionIntent,
	ComparisonOperator,
	CustomTraversal,
	EdgeTableTraversal,
	ExpressionIntent,
	// Include
	IncludeIntent,
	LogicalOperator,
	NullOperator,
	NullsPosition,
	// OrderBy
	OrderByIntent,
	// Query
	QueryIntent,
	RawExpressionIntent,
	RecursiveDedupe,
	RecursiveEmitOptions,
	RecursiveIntent,
	RecursiveNodeIdExpr,
	RecursivePgOptions,
	RecursiveTrackOptions,
	RecursiveTraversal,
	RelationOperator,
	SelectAggregateIntent,
	// Select
	SelectAllIntent,
	SelectFieldsIntent,
	SelectIntent,
	SelectWithExpressionsIntent,
	SortDirection,
	StringOperator,
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
	WhereRelationFilterIntent,
} from './intent-ast.js';
export {
	// Recursive CTE type guards (RFC-001)
	isAdjacencyTraversal,
	// Type guards
	isCoalesceExpression,
	isCustomTraversal,
	isEdgeTableTraversal,
	isRawExpression,
	isRecursiveIntent,
	isSelectAggregate,
	isSelectAll,
	isSelectFields,
	isSelectWithExpressions,
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
	isWhereRelationBased,
	isWhereRelationFilter,
} from './intent-ast.js';

// ============================================================================
// Schema Builder
// ============================================================================

export type {
	// Builder types
	ColumnDef,
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
	// Entry point
	defineSchema,
	hasMany,
	// Relation helpers
	hasOne,
} from './schema-builder.js';

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
} from './planner.js';
export {
	// Errors
	AmbiguousPlanError,
	// Entry points
	plan,
	planRecursive,
	RecursiveShapeMismatchError,
	// Recursive CTE helpers
	validateRecursiveShape,
} from './planner.js';

// ============================================================================
// Implementation (for advanced use cases)
// ============================================================================

export { ModelIRImpl } from './model-impl.js';
