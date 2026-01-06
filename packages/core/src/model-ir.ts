/**
 * @module model-ir
 * ModelIR (Model Intermediate Representation) - Schema definition format for db-semantic-planner.
 * Represents database tables, columns, and relations with planning metadata.
 */

// ============================================================================
// Column Types
// ============================================================================

/** Column data types supported by the planner */
export type ColumnType =
	| 'string'
	| 'number'
	| 'boolean'
	| 'date'
	| 'datetime'
	| 'json'
	| 'uuid'
	| 'bigint';

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

/** Cardinality for planning */
export type Cardinality = 'one' | 'many';

/** Optionality for join type inference */
export type Optionality = 'required' | 'optional';

/** Strategy for including related data */
export type IncludeStrategy = 'join' | 'separate' | 'auto';

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
 * Table definition
 */
export interface TableIR {
	/** Table name in database */
	readonly name: string;

	/** Column definitions */
	readonly columns: readonly ColumnIR[];

	/** Primary key (single column or composite) */
	readonly primaryKey: string | readonly string[];

	/** Foreign key constraints */
	readonly foreignKeys: readonly ForeignKeyIR[];
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

	// --- Planning Hints ---

	/** Cardinality affects strategy selection */
	readonly cardinality: Cardinality;

	/** Optionality affects LEFT vs INNER join */
	readonly optionality: Optionality;

	// --- Strategy Defaults (can be overridden per-query) ---

	/**
	 * How to fetch related data when included.
	 * - 'join': Use JOIN (efficient for to-one)
	 * - 'separate': Use separate query (avoids row explosion for to-many)
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

	/** Get table by name */
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
