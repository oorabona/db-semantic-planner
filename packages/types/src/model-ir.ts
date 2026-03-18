/**
 * @module model-ir
 * ModelIR (Model Intermediate Representation) type definitions.
 * Represents database tables, columns, and relations with planning metadata.
 *
 * Runtime functions (createPseudoColumnMetadata, createRecursiveMetadata, etc.)
 * remain in @dbsp/core.
 */

// ============================================================================
// Column Types
// ============================================================================

/** Column data types supported by the planner */
export type ColumnType =
	| 'string'
	| 'text'
	| 'number'
	| 'integer'
	| 'bigint'
	| 'decimal'
	| 'boolean'
	| 'date'
	| 'time'
	| 'datetime'
	| 'timestamp'
	| 'json'
	| 'jsonb'
	| 'uuid'
	// PostgreSQL-specific range types
	| 'daterange'
	| 'tsrange'
	| 'tstzrange'
	| 'int4range'
	| 'int8range'
	| 'numrange';

// ============================================================================
// Foreign Key Types
// ============================================================================

/** Foreign key delete behavior */
export type OnDeleteAction = 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';

// ============================================================================
// Relation Types
// ============================================================================

/** Relation types */
export type RelationType = 'hasOne' | 'hasMany' | 'belongsTo' | 'belongsToMany';

/**
 * CLI-NQL: Relation kind for natural query language.
 * Maps to SQL/database perspective rather than ORM perspective.
 * - 'many-to-one': Child → Parent (e.g., post.author)
 * - 'one-to-many': Parent → Children (e.g., author.posts)
 * - 'many-to-many': M:N via junction (e.g., post.tags)
 * - 'recursive-up': Ancestors (e.g., category.ancestors)
 * - 'recursive-down': Descendants (e.g., category.descendants)
 */
export type RelationKind =
	| 'many-to-one'
	| 'one-to-many'
	| 'many-to-many'
	| 'recursive-up'
	| 'recursive-down';

/**
 * CLI-NQL: Recursive relation metadata.
 * For self-referential tables like categories with parentId.
 */
export interface RecursiveMetadata {
	/**
	 * Direction of traversal.
	 * - 'up': Traverse to ancestors (parent → grandparent → ...)
	 * - 'down': Traverse to descendants (children → grandchildren → ...)
	 */
	readonly direction: 'up' | 'down';

	/**
	 * Maximum recursion depth to prevent infinite loops.
	 * @default 10
	 */
	readonly maxDepth: number;

	/**
	 * The relation name to follow for recursion.
	 * For 'up': typically 'parent' relation
	 * For 'down': typically 'children' relation
	 */
	readonly through: string;
}

/**
 * Metadata for auto-generated pseudo-columns from self-referential FKs.
 * These enable intuitive traversal in NQL: parent.name, ascendant.title, etc.
 */
export interface PseudoColumnMetadata {
	/** The table this pseudo-column belongs to */
	readonly table: string;

	/** The FK column that creates this self-reference */
	readonly foreignKeyColumn: string;

	/** Target column in the same table (usually 'id') */
	readonly targetColumn: string;

	/**
	 * Role names for traversal directions.
	 * parentRole: singular upward (e.g., 'parent', 'manager')
	 * childRole: plural downward (e.g., 'children', 'subordinates')
	 */
	readonly parentRole: string;
	readonly childRole: string;

	/**
	 * Keywords for recursive traversal.
	 * ascendantKeyword: recursive upward (e.g., 'ascendant', 'manager.ascendant')
	 * descendantKeyword: recursive downward (e.g., 'descendant', 'manager.descendant')
	 */
	readonly ascendantKeyword: string;
	readonly descendantKeyword: string;
}

/** Cardinality for planning */
export type Cardinality = 'one' | 'many';

/** Optionality for join type inference */
export type Optionality = 'required' | 'optional';

/**
 * Include strategy for fetching related data.
 * - 'join': Use JOIN (efficient for to-one, risk of row explosion for to-many)
 * - 'subquery': Use subquery query (safe for to-many, N+1 if not batched)
 * - 'cte': Use CTE-based include (good for recursive/hierarchical)
 * - 'lateral': Use LATERAL JOIN (PostgreSQL/MSSQL CROSS APPLY, handles LIMIT)
 * - 'json_agg': Use JSON aggregation (PostgreSQL/MySQL/DuckDB, single row per parent)
 * - 'auto': Planner decides based on relation type + dialect capabilities
 */
export type IncludeStrategy =
	| 'join'
	| 'subquery'
	| 'cte'
	| 'lateral'
	| 'json_agg'
	| 'auto';

/** Strategy for filtering by relation */
export type FilterStrategy = 'exists' | 'join' | 'auto';

/** Default join type when joining */
export type JoinDefault = 'left' | 'inner' | 'auto';

// ============================================================================
// Core Interfaces
// ============================================================================

/**
 * Column definition
 */
export interface ColumnIR {
	/** Column name in database */
	readonly name: string;

	/** Data type for TypeScript inference */
	readonly type: ColumnType;

	/** Whether NULL is allowed */
	readonly nullable: boolean;

	/** Default value (optional) */
	readonly default?: unknown;

	/**
	 * Original database type string from introspection.
	 * Preserves precision/scale/length info that may be lost in `type`.
	 *
	 * @example
	 * - 'varchar(255)' when type is 'string'
	 * - 'numeric(10,2)' when type is 'number'
	 * - 'timestamptz' when type is 'datetime'
	 *
	 * This is optional and only populated by introspection.
	 * Manually defined schemas may not have this field.
	 */
	readonly originalDbType?: string;

	/** Whether column has a UNIQUE constraint */
	readonly unique?: boolean;

	/** Whether column auto-increments (SERIAL, IDENTITY, AUTOINCREMENT) */
	readonly autoIncrement?: boolean;
}

/**
 * Foreign key constraint
 */
export interface ForeignKeyIR {
	/** Local columns that form the FK */
	readonly columns: readonly string[];

	/** Referenced table and columns */
	readonly references: {
		readonly table: string;
		readonly columns: readonly string[];
	};

	/** Delete behavior */
	readonly onDelete?: OnDeleteAction;
}

/**
 * CHECK constraint definition
 */
export interface CheckConstraintIR {
	/** Constraint name in database */
	readonly name: string;

	/** CHECK expression in canonical form (from pg_get_constraintdef) */
	readonly expression: string;
}

/**
 * Index definition (single or composite)
 */
export interface IndexIR {
	/** Index name (auto-generated if not provided: idx_{table}_{columns}) */
	readonly name?: string;

	/** Columns included in the index (1+ columns) */
	readonly columns: readonly string[];

	/** Whether this is a unique index */
	readonly unique?: boolean;
}

/**
 * Table definition
 */
export interface TableIR {
	/** Table name in database */
	readonly name: string;

	/** Column definitions */
	readonly columns: readonly ColumnIR[];

	/** Primary key (single column or composite); omitted for junction tables without explicit PK */
	readonly primaryKey?: string | readonly string[];

	/** Foreign key constraints */
	readonly foreignKeys: readonly ForeignKeyIR[];

	/** Index definitions */
	readonly indexes: readonly IndexIR[];

	/** CHECK constraints */
	readonly checkConstraints?: readonly CheckConstraintIR[];

	/**
	 * Auto-generated pseudo-columns from self-referential FKs.
	 * Each self-ref FK generates: parent/child roles + ascendant/descendant keywords.
	 * For multi-FK tables, roles are scoped (e.g., manager.ascendant).
	 */
	readonly pseudoColumns?: readonly PseudoColumnMetadata[];
}

/**
 * Relation definition with planning metadata
 */
export interface RelationIR {
	/** Relation name (used in queries) */
	readonly name: string;

	/** Relation type */
	readonly type: RelationType;

	/** Source table name */
	readonly source: string;

	/** Target table name */
	readonly target: string;

	/** Junction table for M:N relations */
	readonly through?: string | undefined;

	/** Foreign key column(s) on the "many" side */
	readonly foreignKey?: string | readonly string[] | undefined;

	/**
	 * For M:N relations: foreign key column on junction table pointing to target.
	 * Example: In posts-tags via postTags, otherKey = 'tagId'
	 */
	readonly otherKey?: string | undefined;

	// --- Planning Hints ---

	/** Cardinality affects strategy selection */
	readonly cardinality: Cardinality;

	/** Optionality affects LEFT vs INNER join */
	readonly optionality: Optionality;

	// --- Strategy Defaults (can be overridden per-query) ---

	/**
	 * How to fetch related data when included.
	 * - 'join': Use JOIN (efficient for to-one)
	 * - 'subquery': Use subquery query (avoids row explosion for to-many)
	 * - 'auto': Planner decides based on cardinality
	 * @default 'auto'
	 */
	readonly includeStrategy: IncludeStrategy;

	/**
	 * How to filter by this relation.
	 * - 'exists': Use EXISTS subquery (no row multiplication)
	 * - 'join': Use JOIN (may cause row explosion on to-many)
	 * - 'auto': Planner decides (defaults to EXISTS for to-many)
	 * @default 'auto'
	 */
	readonly filterStrategy: FilterStrategy;

	/**
	 * Default join type when joining.
	 * - 'left': LEFT JOIN (keep parent even if no child)
	 * - 'inner': INNER JOIN (parent must have child)
	 * - 'auto': Inferred from optionality + filters
	 * @default 'auto'
	 */
	readonly joinDefault: JoinDefault;

	// --- CLI-NQL: Recursive Relations ---

	/**
	 * CLI-NQL: Recursive relation metadata for ancestors/descendants.
	 * Only present for self-referential relations (source === target).
	 */
	readonly recursive?: RecursiveMetadata | undefined;
}

// ============================================================================
// Ambiguity Check Result
// ============================================================================

/**
 * Result of checking for ambiguous relations
 */
export interface AmbiguityCheckResult {
	/** Whether the relation path is ambiguous */
	readonly ambiguous: boolean;

	/** Available relation names if ambiguous */
	readonly options: readonly string[];
}

// ============================================================================
// ModelIR Interface
// ============================================================================

/**
 * Complete model intermediate representation
 */
export interface ModelIR {
	/** Table definitions indexed by name */
	readonly tables: ReadonlyMap<string, TableIR>;

	/** Relation definitions indexed by "source.name" */
	readonly relations: ReadonlyMap<string, RelationIR>;

	// --- Helper Methods ---

	/**
	 * Get table by logical name.
	 *
	 * @param name - Logical table name (camelCase, e.g. "postComments").
	 *   This is the model-level name, NOT the database name (e.g. "post_comments").
	 *   Use adapter-side naming utilities to convert DB names to logical names.
	 */
	getTable(name: string): TableIR | undefined;

	/** Get relation by qualified name "source.relationName" */
	getRelation(qualifiedName: string): RelationIR | undefined;

	/** Get all relations from a source table */
	getRelationsFrom(sourceTable: string): readonly RelationIR[];

	/** Get all relations to a target table */
	getRelationsTo(targetTable: string): readonly RelationIR[];

	/** Check if relation path is ambiguous (multiple relations to same target) */
	isAmbiguous(sourceTable: string, targetTable: string): AmbiguityCheckResult;
}
