/**
 * Schema DSL Types
 *
 * Input types for defineSchema() - the user-facing schema definition DSL.
 * These types are simpler than the IR types and serve as the "source of truth"
 * for schema definitions before they're processed into ModelIR.
 *
 * Migrated from @dbsp/schema/types.ts as part of ARCH-003.
 */

// =============================================================================
// Column Types (DSL - simpler than ColumnType in model-ir.ts)
// =============================================================================

/**
 * Supported column types in the schema DSL.
 * Maps to database types during DDL generation.
 */
export type SchemaColumnType =
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
	| 'jsonb'
	// PostgreSQL-specific range types (will error on non-PG dialects)
	| 'daterange'
	| 'tsrange'
	| 'tstzrange'
	| 'int4range'
	| 'int8range'
	| 'numrange';

/** Foreign key delete behavior */
export type SchemaOnDeleteAction =
	| 'CASCADE'
	| 'SET NULL'
	| 'RESTRICT'
	| 'NO ACTION';

/**
 * Foreign key reference definition.
 * When present, takes priority over convention-based FK detection.
 */
export interface SchemaForeignKeyReference {
	/** Target table name */
	table: string;
	/** Target column name (defaults to 'id') */
	column?: string;
	/** Delete behavior (CASCADE, SET NULL, RESTRICT, NO ACTION) */
	onDelete?: SchemaOnDeleteAction;
}

/**
 * Column definition in the schema DSL.
 */
export interface SchemaColumnDefinition {
	/** Column data type */
	type: SchemaColumnType;
	/** Whether the column is the primary key */
	primaryKey?: boolean;
	/** Whether the column allows NULL values */
	nullable?: boolean;
	/** Whether the column has a unique constraint */
	unique?: boolean;
	/** Default value expression (e.g., 'now()', 'gen_random_uuid()') */
	default?: string;
	/** Explicit foreign key reference (takes priority over conventions) */
	references?: SchemaForeignKeyReference;
	/** Create an index on this column (true for auto-name, string for custom name) */
	index?: boolean | string;
}

/**
 * Table definition: mapping of column names to their definitions.
 */
export type SchemaTableDefinition = Record<string, SchemaColumnDefinition>;

/**
 * All tables in the schema.
 */
export type SchemaTablesDefinition = Record<string, SchemaTableDefinition>;

/**
 * Index definition for composite indexes.
 */
export interface SchemaIndexDefinition {
	/** Columns included in the index */
	columns: string[];
	/** Whether this is a unique index */
	unique?: boolean;
	/** Custom index name (auto-generated if not provided) */
	name?: string;
}

/**
 * Index configuration by table.
 */
export type SchemaIndexesDefinition = Record<string, SchemaIndexDefinition[]>;

// =============================================================================
// Relation Types (Discriminated Union)
// =============================================================================

/**
 * Relation kinds for discriminated union.
 */
export type SchemaRelationKind = 'belongsTo' | 'hasMany' | 'manyToMany';

/**
 * Base properties shared by all relation types.
 */
interface SchemaRelationBase {
	/** Target table name */
	target: string;
}

/**
 * BelongsTo relation: source table has FK to target table.
 * Example: posts.author → users (posts.authorId references users.id)
 */
export interface SchemaBelongsToRelation extends SchemaRelationBase {
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
export interface SchemaHasManyRelation extends SchemaRelationBase {
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
export interface SchemaManyToManyRelation extends SchemaRelationBase {
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
export type SchemaRelationDefinition =
	| SchemaBelongsToRelation
	| SchemaHasManyRelation
	| SchemaManyToManyRelation;

/**
 * Explicit relations mapping.
 * Keys are 'sourceTable.relationName' format.
 */
export type SchemaRelationsDefinition = Record<
	string,
	SchemaRelationDefinition
>;

// =============================================================================
// Planner Hints
// =============================================================================

/**
 * Strategy hint for filtering on to-many relations.
 */
export type SchemaFilterStrategy = 'exists' | 'join';

/**
 * Cardinality hint for relation traversal.
 */
export type SchemaCardinality = 'one' | 'many';

/**
 * Hint definition for a specific relation path.
 */
export interface SchemaHintDefinition {
	/** Preferred filter strategy */
	defaultStrategy?: SchemaFilterStrategy;
	/** Expected cardinality */
	cardinality?: SchemaCardinality;
}

/**
 * All hints, keyed by 'table.relation' path.
 */
export type SchemaHintsDefinition = Record<string, SchemaHintDefinition>;

// =============================================================================
// Convention Configuration
// =============================================================================

/**
 * Convention settings for automatic FK detection and naming.
 */
export interface SchemaConventionsDefinition {
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

	/**
	 * Automatically create indexes on foreign key columns.
	 * FK columns are frequently used in JOINs, so indexing is a best practice.
	 * @default true
	 */
	fkAutoIndex?: boolean;
}

// =============================================================================
// Schema Definition
// =============================================================================

/**
 * Complete schema definition input for defineSchema() wrapped form.
 * Prefer the new hybrid API: defineSchema(tables, config?)
 */
export interface SchemaDefinitionInput<
	T extends SchemaTablesDefinition = SchemaTablesDefinition,
> {
	/** Table definitions */
	tables: T;
	/** Explicit relation definitions (override auto-detected) */
	relations?: SchemaRelationsDefinition;
	/** Planner hints */
	hints?: SchemaHintsDefinition;
	/** Convention configuration */
	conventions?: SchemaConventionsDefinition;
}

/**
 * Configuration options for defineSchema (new API).
 */
export interface SchemaConfigInput {
	/** Explicit relation definitions (override auto-detected) */
	relations?: SchemaRelationsDefinition;
	/** Planner hints */
	hints?: SchemaHintsDefinition;
	/** Convention configuration */
	conventions?: SchemaConventionsDefinition;
	/** Table-level index definitions (composite indexes) */
	indexes?: SchemaIndexesDefinition;
}

/**
 * Resolved schema with all relations (explicit + inferred).
 * This is the output of defineSchema().
 */
export interface ResolvedSchema<
	T extends SchemaTablesDefinition = SchemaTablesDefinition,
> {
	/** Original table definitions */
	tables: T;
	/** All relations (explicit + auto-detected) */
	relations: SchemaRelationsDefinition;
	/** Planner hints */
	hints: SchemaHintsDefinition;
	/** Resolved conventions with defaults applied */
	conventions: Required<SchemaConventionsDefinition>;
	/** Table-level index definitions */
	indexes: SchemaIndexesDefinition;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard for BelongsTo relation.
 */
export function isBelongsTo(
	rel: SchemaRelationDefinition,
): rel is SchemaBelongsToRelation {
	return rel.kind === 'belongsTo';
}

/**
 * Type guard for HasMany relation.
 */
export function isHasMany(
	rel: SchemaRelationDefinition,
): rel is SchemaHasManyRelation {
	return rel.kind === 'hasMany';
}

/**
 * Type guard for ManyToMany relation.
 */
export function isManyToMany(
	rel: SchemaRelationDefinition,
): rel is SchemaManyToManyRelation {
	return rel.kind === 'manyToMany';
}
