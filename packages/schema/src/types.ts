/**
 * ARCH-002 Block 1: Schema Definition Types
 *
 * This module defines the core types for the dbsp.schema.ts Source of Truth.
 * Key design: Discriminated unions with `kind` field for type safety.
 */

// =============================================================================
// Column Types
// =============================================================================

/**
 * Supported column types in the schema DSL.
 * Maps to PostgreSQL types during verification.
 */
export type ColumnType =
	| 'uuid'
	| 'string'
	| 'text'
	| 'integer'
	| 'bigint'
	| 'decimal'
	| 'boolean'
	| 'timestamp'
	| 'date'
	| 'time'
	| 'json'
	| 'jsonb';

/**
 * Foreign key reference definition.
 * When present, takes priority over convention-based FK detection.
 */
export interface ForeignKeyReference {
	/** Target table name */
	table: string;
	/** Target column name (defaults to 'id') */
	column?: string;
}

/**
 * Column definition in the schema.
 */
export interface ColumnDefinition {
	/** Column data type */
	type: ColumnType;
	/** Whether the column is the primary key */
	primaryKey?: boolean;
	/** Whether the column allows NULL values */
	nullable?: boolean;
	/** Whether the column has a unique constraint */
	unique?: boolean;
	/** Default value expression (e.g., 'now()', 'gen_random_uuid()') */
	default?: string;
	/** Explicit foreign key reference (takes priority over conventions) */
	references?: ForeignKeyReference;
}

/**
 * Table definition: mapping of column names to their definitions.
 */
export type TableDefinition = Record<string, ColumnDefinition>;

/**
 * All tables in the schema.
 */
export type TablesDefinition = Record<string, TableDefinition>;

// =============================================================================
// Relation Types (Discriminated Union)
// =============================================================================

/**
 * Relation kinds for discriminated union.
 */
export type RelationKind = 'belongsTo' | 'hasMany' | 'manyToMany';

/**
 * Base properties shared by all relation types.
 */
interface RelationBase {
	/** Target table name */
	target: string;
}

/**
 * BelongsTo relation: source table has FK to target table.
 * Example: posts.author → users (posts.authorId references users.id)
 */
export interface BelongsToRelation extends RelationBase {
	kind: 'belongsTo';
	/** Foreign key column in the source table */
	foreignKey: string;
	/** Target column (defaults to 'id') */
	targetKey?: string;
}

/**
 * HasMany relation: target table has FK to source table.
 * Example: users.posts → posts (posts.authorId references users.id)
 */
export interface HasManyRelation extends RelationBase {
	kind: 'hasMany';
	/** Foreign key column in the target table */
	foreignKey: string;
	/** Source column (defaults to 'id') */
	sourceKey?: string;
}

/**
 * ManyToMany relation: junction table connects source and target.
 * Example: posts ↔ categories via post_categories
 */
export interface ManyToManyRelation extends RelationBase {
	kind: 'manyToMany';
	/** Junction table name */
	through: string;
	/** FK column in junction pointing to source */
	sourceFk: string;
	/** FK column in junction pointing to target */
	targetFk: string;
}

/**
 * Union of all relation types.
 * Use `kind` field for type narrowing.
 */
export type RelationDefinition =
	| BelongsToRelation
	| HasManyRelation
	| ManyToManyRelation;

/**
 * Explicit relations mapping.
 * Keys are 'sourceTable.relationName' format.
 */
export type RelationsDefinition = Record<string, RelationDefinition>;

// =============================================================================
// Planner Hints
// =============================================================================

/**
 * Strategy hint for filtering on to-many relations.
 */
export type FilterStrategy = 'exists' | 'join';

/**
 * Cardinality hint for relation traversal.
 */
export type Cardinality = 'one' | 'many';

/**
 * Hint definition for a specific relation path.
 */
export interface HintDefinition {
	/** Preferred filter strategy */
	defaultStrategy?: FilterStrategy;
	/** Expected cardinality */
	cardinality?: Cardinality;
}

/**
 * All hints, keyed by 'table.relation' path.
 */
export type HintsDefinition = Record<string, HintDefinition>;

// =============================================================================
// Convention Configuration
// =============================================================================

/**
 * Convention settings for automatic FK detection and naming.
 */
export interface ConventionsDefinition {
	/**
	 * Pattern for foreign key column names.
	 * {singular} is replaced with singular table name.
	 * @default '{singular}Id'
	 */
	fkPattern?: string;

	/**
	 * Whether to auto-pluralize relation names.
	 * @default true
	 */
	pluralize?: boolean;

	/**
	 * Column names recognized as timestamps.
	 * @default ['createdAt', 'updatedAt']
	 */
	timestamps?: string[];
}

// =============================================================================
// Schema Definition
// =============================================================================

/**
 * Complete schema definition input for defineSchema().
 * @deprecated Use the new hybrid API: defineSchema(tables, config?)
 */
export interface SchemaDefinitionInput<
	T extends TablesDefinition = TablesDefinition,
> {
	/** Table definitions */
	tables: T;
	/** Explicit relation definitions (override auto-detected) */
	relations?: RelationsDefinition;
	/** Planner hints */
	hints?: HintsDefinition;
	/** Convention configuration */
	conventions?: ConventionsDefinition;
}

/**
 * Configuration options for defineSchema (new API).
 */
export interface SchemaConfigInput {
	/** Explicit relation definitions (override auto-detected) */
	relations?: RelationsDefinition;
	/** Planner hints */
	hints?: HintsDefinition;
	/** Convention configuration */
	conventions?: ConventionsDefinition;
}

/**
 * Resolved schema with all relations (explicit + inferred).
 * This is the output of defineSchema().
 */
export interface ResolvedSchema<T extends TablesDefinition = TablesDefinition> {
	/** Original table definitions */
	tables: T;
	/** All relations (explicit + auto-detected) */
	relations: RelationsDefinition;
	/** Planner hints */
	hints: HintsDefinition;
	/** Resolved conventions with defaults applied */
	conventions: Required<ConventionsDefinition>;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard for BelongsTo relation.
 */
export function isBelongsTo(rel: RelationDefinition): rel is BelongsToRelation {
	return rel.kind === 'belongsTo';
}

/**
 * Type guard for HasMany relation.
 */
export function isHasMany(rel: RelationDefinition): rel is HasManyRelation {
	return rel.kind === 'hasMany';
}

/**
 * Type guard for ManyToMany relation.
 */
export function isManyToMany(
	rel: RelationDefinition,
): rel is ManyToManyRelation {
	return rel.kind === 'manyToMany';
}
