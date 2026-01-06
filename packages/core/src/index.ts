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
// Implementation (for advanced use cases)
// ============================================================================

export { ModelIRImpl } from './model-impl.js';
