/**
 * @db-semantic-planner/schema
 *
 * Schema definition DSL for db-semantic-planner.
 * Source of Truth for tables, relations, and planner hints.
 */

// Convention utilities (for CLI and testing)
export {
	capitalize,
	DEFAULT_CONVENTIONS,
	decapitalize,
	detectForeignKeys,
	detectManyToMany,
	inferRelations,
	pluralize,
	singularize,
} from './conventions.js';
// Main entry point
export { defineSchema, SchemaValidationError } from './define.js';
// Types
export type {
	BelongsToRelation,
	Cardinality,
	ColumnDefinition,
	// Column types
	ColumnType,
	// Conventions
	ConventionsDefinition,
	// Hints
	FilterStrategy,
	ForeignKeyReference,
	HasManyRelation,
	HintDefinition,
	HintsDefinition,
	ManyToManyRelation,
	RelationDefinition,
	// Relation types (discriminated union)
	RelationKind,
	RelationsDefinition,
	ResolvedSchema,
	// Schema
	SchemaConfigInput,
	SchemaDefinitionInput,
	TableDefinition,
	TablesDefinition,
} from './types.js';
// Type guards
export { isBelongsTo, isHasMany, isManyToMany } from './types.js';
