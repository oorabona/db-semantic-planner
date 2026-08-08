/**
 * @module model-ir
 * ModelIR (Model Intermediate Representation) type definitions.
 * Represents database tables, columns, and relations with planning metadata.
 *
 * Runtime functions (createPseudoColumnMetadata, createRecursiveMetadata, etc.)
 * remain in @dbsp/core.
 */

import type { TrustRoot } from './transition/artifact.js';

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

/** JavaScript read-side representation for PostgreSQL bigint/int8 values. */
export type ColumnJsReadType = 'bigint' | 'number' | 'string';

// ============================================================================
// Foreign Key Types
// ============================================================================

/** Foreign key delete behavior */
export type OnDeleteAction =
	| 'CASCADE'
	| 'SET NULL'
	| 'SET DEFAULT'
	| 'RESTRICT'
	| 'NO ACTION';

// ============================================================================
// Relation Types
// ============================================================================

/** Relation types */
export type RelationType = 'hasOne' | 'hasMany' | 'belongsTo' | 'belongsToMany';

/** Relation type label carried by NQL binding proofs. */
export type NqlBindingRelationType = RelationType | 'manyToMany';

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

export type AuthorAttester = Exclude<TrustRoot, { readonly kind: 'pack' }>;

export interface AuthorAttestedNativeDefault {
	readonly sql: string;
	readonly attestedBy: AuthorAttester;
	readonly statement?: string;
}

// ============================================================================
// Core Interfaces
// ============================================================================

export interface LogicalIdentityCarrier {
	readonly kind: 'postgresql-side-table' | (string & {});
	readonly authenticated: false;
}

export interface LogicalIdentity {
	readonly id: string;
	readonly carrier: LogicalIdentityCarrier;
}

/**
 * Column definition
 */
export interface ColumnIR {
	/** Column name in database */
	readonly name: string;

	/** Stable logical identity, when attached by an engine-neutral carrier. */
	readonly logicalIdentity?: LogicalIdentity;

	/** Data type for TypeScript inference */
	readonly type: ColumnType;

	/** Optional read-side JavaScript representation for bigint/int8 values. */
	readonly js?: ColumnJsReadType;

	/** Whether NULL is allowed */
	readonly nullable: boolean;

	/** Default value (optional) */
	readonly default?: unknown;

	/**
	 * Original database type spelling from introspection or an authored dbType.
	 * Preserves precision/scale/length info that may be lost in `type`.
	 *
	 * For custom database types, this is the bare type spelling only: type name,
	 * modifiers, and array suffix, with no schema qualification. The type's
	 * catalog schema and retargeting scope are carried separately by
	 * `originalDbTypeSchema` and `originalDbTypeSchemaScope`.
	 *
	 * @example
	 * - 'varchar(255)' when type is 'string'
	 * - 'numeric(10,2)' when type is 'number'
	 * - 'timestamptz' when type is 'datetime'
	 * - 'status[]' for an enum array whose schema is in `originalDbTypeSchema`
	 *
	 * This is optional and only populated by introspection.
	 * Manually defined schemas may not have this field.
	 */
	readonly originalDbType?: string;

	/**
	 * Catalog schema for `originalDbType` when it references a custom database
	 * type. Undefined for PostgreSQL built-ins and for schemas that do not carry
	 * structural custom type identity.
	 */
	readonly originalDbTypeSchema?: string;

	/**
	 * Scope of `originalDbTypeSchema` for custom database types.
	 *
	 * - `target`: type belongs to the managed/model schema and can be retargeted
	 *   at SQL emission.
	 * - `absolute`: type belongs to an external/shared schema and always emits
	 *   against `originalDbTypeSchema`.
	 */
	readonly originalDbTypeSchemaScope?: 'target' | 'absolute';

	/** Whether column has a UNIQUE constraint */
	readonly unique?: boolean;

	/**
	 * Actual database UNIQUE constraint name, populated by introspection.
	 * Manually defined schemas may not have this field.
	 */
	readonly uniqueConstraintName?: string;

	/** Whether column auto-increments (SERIAL, IDENTITY, AUTOINCREMENT) */
	readonly autoIncrement?: boolean;

	/** Collation name for string columns */
	readonly collation?: string;

	/** Column comment (COMMENT ON COLUMN) */
	readonly comment?: string;

	/** Identity column generation strategy (GENERATED {ALWAYS|BY DEFAULT} AS IDENTITY) */
	readonly identity?: 'always' | 'byDefault';
}

/**
 * Foreign key constraint
 */
export interface ForeignKeyIR {
	/** Local columns that form the FK */
	readonly columns: readonly string[];

	/** Referenced table and columns; schema is the referenced table's schema and defaults to the FK's own/migration schema when absent */
	readonly references: {
		readonly schema?: string;
		readonly table: string;
		readonly columns: readonly string[];
	};

	/** Delete behavior */
	readonly onDelete?: OnDeleteAction;

	/** Update behavior */
	readonly onUpdate?: OnDeleteAction;

	/** Whether this FK constraint is deferrable (DEFERRABLE INITIALLY DEFERRED) */
	readonly deferred?: boolean;

	/** If true, add the constraint WITHOUT scanning existing rows (NOT VALID). Use validate_constraint to validate later. */
	readonly notValid?: boolean;
}

/**
 * CHECK constraint definition
 */

/**
 * PostgreSQL ENUM type definition
 */

/**
 * PostgreSQL sequence definition
 */
export interface SequenceIR {
	/** Sequence name */
	readonly name: string;
	/** Start value */
	readonly startWith?: number;
	/** Increment step */
	readonly incrementBy?: number;
	/** Minimum value */
	readonly minValue?: number;
	/** Maximum value */
	readonly maxValue?: number;
	/** Whether to cycle */
	readonly cycle?: boolean;
	/** Schema name (if not default) */
	readonly schema?: string;
}

export interface EnumIR {
	/** Enum type name */
	readonly name: string;

	/** Ordered list of enum values */
	readonly values: readonly string[];

	/** Schema name (if not in default schema) */
	readonly schema?: string;
}

export interface RequiredEnumLabelIR {
	readonly schema?: string;
	readonly type: string;
	readonly label: string;
}

export interface CheckConstraintIR {
	/** Constraint name in database */
	readonly name: string;

	/** CHECK expression in canonical form (from pg_get_constraintdef) */
	readonly expression: string;

	/** If true, add the constraint WITHOUT scanning existing rows (NOT VALID). Use validate_constraint to validate later. */
	readonly notValid?: boolean;

	/** Authored transition metadata: enum labels this CHECK references and requires visible before proof/apply. */
	readonly requiresEnumLabels?: readonly RequiredEnumLabelIR[];
}

/**
 * Row-Level Security policy definition.
 *
 * Models PostgreSQL's CREATE POLICY. Other dialects (Oracle VPD, MSSQL security predicates)
 * use fundamentally different mechanisms — this interface captures the PG-style model which
 * is the most common. Adapters without RLS support skip policies via capability negotiation.
 *
 * @example
 * ```typescript
 * {
 *   name: 'tenant_isolation',
 *   command: 'ALL',
 *   roles: ['app_user'],
 *   using: "tenant_id = current_setting('app.current_tenant')::uuid",
 *   withCheck: "tenant_id = current_setting('app.current_tenant')::uuid",
 * }
 * ```
 */
export interface PolicyIR {
	/** Policy name (must be unique per table) */
	readonly name: string;
	/** SQL command the policy applies to (default: ALL) */
	readonly command?: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
	/** Database roles the policy applies to (default: PUBLIC) */
	readonly roles?: readonly string[];
	/** Whether the policy is permissive or restrictive (default: PERMISSIVE) */
	readonly permissive?: boolean;
	/** USING expression — SQL predicate for row visibility (SELECT, UPDATE, DELETE) */
	readonly using?: string;
	/** WITH CHECK expression — SQL predicate for new/modified rows (INSERT, UPDATE) */
	readonly withCheck?: string;
}

/**
 * Table partition configuration (parent table only).
 * Child partition management is out of scope (DDL-PARTITION-MGMT).
 */
export interface PartitionIR {
	/** Partition strategy */
	readonly strategy: 'RANGE' | 'LIST' | 'HASH';

	/** Partition key columns */
	readonly columns: readonly string[];
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

	/** PostgreSQL catalog validity (indisvalid); false marks an unusable leftover index */
	readonly valid?: boolean;

	/** PostgreSQL catalog readiness (indisready); false marks an incomplete index build */
	readonly ready?: boolean;

	/** PG15+ — for UNIQUE indexes only; schema authoring rejects true on non-unique indexes */
	readonly nullsNotDistinct?: boolean;

	/** Index access method (default: btree) */
	readonly method?: string;

	/**
	 * Partial index predicate (WHERE clause). The model representation has one
	 * absence value: `undefined`. Every present string, including an empty or
	 * whitespace-only string, is an authored `WHERE` clause and must reach
	 * PostgreSQL.
	 */
	readonly where?: string;

	/** Expression-based index entries (used instead of/alongside columns) */
	readonly expressions?: readonly string[];

	/** Non-key columns to include (INCLUDE clause, PG11+) */
	readonly include?: readonly string[];

	/** Per-column operator class overrides (non-default only). Key = column name, value = opclass name */
	readonly opclass?: Readonly<Record<string, string>>;

	/** Index storage parameters (WITH clause). Key = param name, value = param value */
	readonly with?: Readonly<Record<string, string>>;
}

/**
 * Table definition
 */
export interface TableIR {
	/** Table name in database */
	readonly name: string;

	/**
	 * An explicit address change for this table.  The desired table remains
	 * identified by `name`; `from` and `to` make the otherwise ambiguous
	 * rename/schema move an authored transition rather than inferred drift.
	 */
	readonly readdress?: TableReaddressDeclaration;

	/** Stable logical identity, when attached by an engine-neutral carrier. */
	readonly logicalIdentity?: LogicalIdentity;

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

	/** Table-level comment (COMMENT ON TABLE) */
	readonly comment?: string;

	/** Partition configuration (parent table). Child management deferred to DDL-PARTITION-MGMT. */
	readonly partition?: PartitionIR;

	/** Whether Row-Level Security is enabled on this table */
	readonly rlsEnabled?: boolean;

	/** Row-Level Security policies */
	readonly policies?: readonly PolicyIR[];
}

/** One endpoint of an authored table re-addressing declaration. */
export interface TableReaddressAddress {
	readonly name: string;
	readonly schema?: string;
	/** Deliberately carried through so the command can refuse the named kind. */
	readonly kind?: string;
	/** Deliberately carried through so the command can refuse cross-database moves. */
	readonly database?: string;
}

/** A declared rename or schema move; execution currently supports tables only. */
export interface TableReaddressDeclaration {
	readonly from: TableReaddressAddress;
	readonly to: TableReaddressAddress;
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

	/** Column(s) on source table that FK on target references; set when generated relation overrides the default PK. */
	readonly sourceKey?: string | readonly string[] | undefined;

	/** Column(s) on target table that the FK points to; set when generated relation overrides the default PK. */
	readonly targetKey?: string | readonly string[] | undefined;

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

	/** Declared tables outside this managed model that foreign keys may reference */
	readonly externalTables?: ReadonlySet<string>;

	/** Relation definitions indexed by "source.name" */
	readonly relations: ReadonlyMap<string, RelationIR>;

	/** ENUM type definitions indexed by name */
	readonly enums?: ReadonlyMap<string, EnumIR>;

	/** Extension names to ensure (CREATE EXTENSION IF NOT EXISTS) */
	readonly extensions?: readonly string[];

	/** Sequence definitions */
	readonly sequences?: ReadonlyMap<string, SequenceIR>;

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

/**
 * Hierarchy pattern detected during database introspection.
 * Describes adjacency-list or edge-table patterns on self-referencing tables.
 */
export interface HierarchyIR {
	/** How the hierarchy is represented in the schema */
	readonly type: 'adjacency' | 'edge-table';
	/** Table that contains the nodes */
	readonly nodeTable: string;
	/** Edge table (for edge-table type only) */
	readonly edgeTable?: string;
	/** Column pointing to the parent node (adjacency) or source node (edge-table) */
	readonly parentColumn: string;
	/** Column pointing to the child node (edge-table type only) */
	readonly childColumn?: string;
	/** Column holding the node's own identifier */
	readonly nodeIdColumn: string;
}
