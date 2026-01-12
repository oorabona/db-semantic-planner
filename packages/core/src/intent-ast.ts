/**
 * @module intent-ast
 * IntentAST (Intent Abstract Syntax Tree) - Query intent representation for db-semantic-planner.
 * Represents user's query intentions before being translated to SQL by adapters.
 */

// ============================================================================
// Comparison Operators
// ============================================================================

/** Comparison operators for scalar values */
export type ComparisonOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';

/** String operators */
export type StringOperator = 'like';

/** Array operators */
export type ArrayOperator = 'in';

/** Null operators */
export type NullOperator = 'isNull' | 'isNotNull';

/** Logical operators */
export type LogicalOperator = 'and' | 'or' | 'not';

/** Relation filter operators */
export type RelationOperator = 'exists' | 'notExists';

// ============================================================================
// Sort Direction
// ============================================================================

/** Sort direction */
export type SortDirection = 'asc' | 'desc';

/** Null handling in sort */
export type NullsPosition = 'first' | 'last';

// ============================================================================
// Select Intent
// ============================================================================

/**
 * Select all columns
 */
export interface SelectAllIntent {
	readonly type: 'all';
}

/**
 * Select specific fields
 */
export interface SelectFieldsIntent {
	readonly type: 'fields';
	/** Field names to select */
	readonly fields: readonly string[];
}

// ============================================================================
// Aggregate Functions
// ============================================================================

/** Aggregate function types */
export type AggregateFunction = 'count' | 'sum' | 'avg' | 'min' | 'max';

/**
 * Aggregate operation intent
 * @example { function: 'count' } → COUNT(*)
 * @example { function: 'sum', field: 'price' } → SUM(price)
 */
export interface AggregateIntent {
	/** Aggregate function */
	readonly function: AggregateFunction;
	/** Field to aggregate (optional for count without field) */
	readonly field?: string;
	/** Alias for result column */
	readonly as?: string;
}

/**
 * Select with aggregate functions
 */
export interface SelectAggregateIntent {
	readonly type: 'aggregate';
	/** Aggregate operations */
	readonly aggregates: readonly AggregateIntent[];
	/** Non-aggregate fields (for GROUP BY) */
	readonly fields?: readonly string[];
}

/**
 * Select intent - what columns to retrieve
 */
export type SelectIntent =
	| SelectAllIntent
	| SelectFieldsIntent
	| SelectAggregateIntent
	| SelectWithExpressionsIntent;

// ============================================================================
// Expression Intents - Computed/Derived Values
// ============================================================================

/**
 * COALESCE expression: returns first non-null value from a list of fields
 * @example { kind: 'coalesce', fields: ['name_fr', 'name_en'], as: 'display_name' }
 *          → COALESCE(name_fr, name_en) AS display_name
 */
export interface CoalesceExpressionIntent {
	readonly kind: 'coalesce';
	/** Fields to check in order (first non-null wins) */
	readonly fields: readonly string[];
	/** Required alias for the result column */
	readonly as: string;
}

/**
 * Raw SQL expression (escape hatch for advanced use cases)
 * @example { kind: 'raw', sql: 'NOW()', as: 'current_time' }
 *          → NOW() AS current_time
 * @warning Use sparingly - bypasses type safety and SQL injection protection
 */
export interface RawExpressionIntent {
	readonly kind: 'raw';
	/** Raw SQL fragment (must be safe, no user input!) */
	readonly sql: string;
	/** Required alias for the result column */
	readonly as: string;
}

/**
 * Expression intent union type - computed/derived values in SELECT
 * Extensible for future expression types (CASE WHEN, etc.)
 */
export type ExpressionIntent =
	| CoalesceExpressionIntent
	| RawExpressionIntent
	| WindowIntent;

/**
 * Select with expressions (computed columns)
 */
export interface SelectWithExpressionsIntent {
	readonly type: 'expressions';
	/** Regular fields to select */
	readonly fields?: readonly string[];
	/** Computed expressions */
	readonly expressions: readonly ExpressionIntent[];
}

// ============================================================================
// Window Functions (P3-A)
// ============================================================================

/**
 * Window function types for OVER clause analytics.
 * - Ranking: row_number, rank, dense_rank (no field required)
 * - Aggregate: sum, avg, count, min, max (field required)
 * - Offset: lag, lead (field required, offset/default deferred to P3+)
 */
export type WindowFunction =
	| 'row_number'
	| 'rank'
	| 'dense_rank'
	| 'sum'
	| 'avg'
	| 'count'
	| 'min'
	| 'max'
	| 'lag'
	| 'lead';

/**
 * Order specification for window OVER clause.
 */
export interface WindowOrderBy {
	readonly field: string;
	readonly direction?: 'asc' | 'desc';
}

/**
 * Window function intent for analytics over partitions.
 * Produces SQL like: ROW_NUMBER() OVER (PARTITION BY x ORDER BY y) AS alias
 *
 * @example Row numbering
 * {
 *   kind: 'window',
 *   function: 'row_number',
 *   alias: 'rn',
 *   over: { orderBy: [{ field: 'created_at', direction: 'desc' }] }
 * }
 *
 * @example Running total
 * {
 *   kind: 'window',
 *   function: 'sum',
 *   field: 'amount',
 *   alias: 'running_total',
 *   over: { partitionBy: ['account_id'], orderBy: [{ field: 'date' }] }
 * }
 */
export interface WindowIntent {
	readonly kind: 'window';

	/** Window function to apply */
	readonly function: WindowFunction;

	/** Field for aggregate/offset functions (required for sum/avg/count/min/max/lag/lead) */
	readonly field?: string;

	/** Result column alias (required) */
	readonly alias: string;

	/** OVER clause specification */
	readonly over: {
		/** PARTITION BY columns (optional) */
		readonly partitionBy?: readonly string[];
		/** ORDER BY specification (optional but recommended for ranking) */
		readonly orderBy?: readonly WindowOrderBy[];
	};
}

/**
 * Ranking window functions (no field required)
 */
export type RankingWindowFunction = 'row_number' | 'rank' | 'dense_rank';

/**
 * Aggregate window functions (field required)
 */
export type AggregateWindowFunction = 'sum' | 'avg' | 'count' | 'min' | 'max';

/**
 * Offset window functions (field required, offset/default deferred)
 */
export type OffsetWindowFunction = 'lag' | 'lead';

// ============================================================================
// Where Intent - Filter Conditions
// ============================================================================

/**
 * Comparison filter: field op value
 * Examples: eq, neq, gt, gte, lt, lte
 */
export interface WhereComparisonIntent {
	readonly kind: 'comparison';
	readonly field: string;
	readonly operator: ComparisonOperator;
	readonly value: unknown;
}

/**
 * String filter: field like pattern
 */
export interface WhereLikeIntent {
	readonly kind: 'like';
	readonly field: string;
	readonly pattern: string;
	/** Case-insensitive matching */
	readonly caseInsensitive?: boolean;
}

/**
 * Array filter: field in [values]
 */
export interface WhereInIntent {
	readonly kind: 'in';
	readonly field: string;
	readonly values: readonly unknown[];
}

/**
 * Null filter: field is null / is not null
 */
export interface WhereNullIntent {
	readonly kind: 'null';
	readonly field: string;
	readonly operator: NullOperator;
}

/**
 * Logical AND: all conditions must match
 */
export interface WhereAndIntent {
	readonly kind: 'and';
	readonly conditions: readonly WhereIntent[];
}

/**
 * Logical OR: at least one condition must match
 */
export interface WhereOrIntent {
	readonly kind: 'or';
	readonly conditions: readonly WhereIntent[];
}

/**
 * Logical NOT: condition must not match
 */
export interface WhereNotIntent {
	readonly kind: 'not';
	readonly condition: WhereIntent;
}

/**
 * Relation exists filter: filter by existence of related records
 * Critical for Q1 golden test - enables EXISTS subquery strategy
 *
 * @example
 * // Find users who have at least one published post
 * { kind: 'exists', relation: 'posts', where: { kind: 'comparison', field: 'status', operator: 'eq', value: 'published' } }
 */
export interface WhereExistsIntent {
	readonly kind: 'exists';
	/** Relation name to check existence */
	readonly relation: string;
	/** Optional filter on related records */
	readonly where?: WhereIntent;
}

/**
 * Relation not exists filter: filter by absence of related records
 *
 * @example
 * // Find users who have no posts
 * { kind: 'notExists', relation: 'posts' }
 */
export interface WhereNotExistsIntent {
	readonly kind: 'notExists';
	/** Relation name to check absence */
	readonly relation: string;
	/** Optional filter on related records */
	readonly where?: WhereIntent;
}

/**
 * Relation filter: filter parent by conditions on related records
 * More flexible than exists - allows filtering by related record attributes
 *
 * @example
 * // Find users whose latest post was created in 2024
 * { kind: 'relationFilter', relation: 'posts', where: {...}, mode: 'some' }
 */
export interface WhereRelationFilterIntent {
	readonly kind: 'relationFilter';
	/** Relation name */
	readonly relation: string;
	/** Filter conditions on related records */
	readonly where: WhereIntent;
	/**
	 * Match mode:
	 * - 'some': At least one related record matches (default)
	 * - 'every': All related records match
	 * - 'none': No related records match
	 */
	readonly mode: 'some' | 'every' | 'none';
}

// ============================================================================
// Subquery Intent - Scalar Subquery in WHERE
// ============================================================================

/**
 * Reference to a parent query column in a subquery.
 * Used to create correlated subqueries.
 *
 * @example
 * // Reference parent 'id' column in subquery WHERE
 * { kind: 'ref', column: 'id' }
 * { kind: 'ref', column: 't0.id' }  // with alias
 */
export interface SubqueryRefIntent {
	readonly kind: 'ref';
	/** Column name or aliased column (e.g., 'id' or 't0.id') */
	readonly column: string;
}

/**
 * Subquery intent for scalar subquery comparisons.
 * Produces correlated subqueries in SQL.
 *
 * @example
 * // Find products where price equals max price of category
 * {
 *   kind: 'subquery',
 *   field: 'price',
 *   operator: 'eq',
 *   subquery: { from: 'products', select: { kind: 'aggregate', fn: 'max', field: 'price' } }
 * }
 */
export interface WhereSubqueryIntent {
	readonly kind: 'subquery';
	/** Field to compare on the parent query */
	readonly field: string;
	/** Comparison operator */
	readonly operator: ComparisonOperator;
	/** Subquery producing scalar value */
	readonly subquery: ScalarSubqueryIntent;
}

/**
 * Scalar subquery intent - produces a single value.
 * Simplified QueryIntent for subquery context.
 */
export interface ScalarSubqueryIntent {
	/** Target table for subquery */
	readonly from: string;
	/** Field to select (single scalar) */
	readonly select: string;
	/** Optional filter (can include SubqueryRefIntent values) */
	readonly where?: WhereIntent;
	/** Optional aggregate function */
	readonly aggregate?: {
		readonly fn: 'count' | 'sum' | 'avg' | 'min' | 'max';
		readonly field: string;
	};
}

/**
 * Where intent - filter conditions union type
 * Discriminated union using 'kind' field
 */
export type WhereIntent =
	| WhereComparisonIntent
	| WhereLikeIntent
	| WhereInIntent
	| WhereNullIntent
	| WhereAndIntent
	| WhereOrIntent
	| WhereNotIntent
	| WhereExistsIntent
	| WhereNotExistsIntent
	| WhereRelationFilterIntent
	| WhereSubqueryIntent;

// ============================================================================
// Include Intent - Relation Loading
// ============================================================================

/**
 * Include intent - load related records
 * Supports nested includes for deep relation loading
 */
export interface IncludeIntent {
	/** Relation name to include */
	readonly relation: string;

	/** What columns to select from related records */
	readonly select?: SelectIntent;

	/** Filter conditions on related records */
	readonly where?: WhereIntent;

	/** Nested includes for deep loading */
	readonly include?: readonly IncludeIntent[];

	/**
	 * Explicit relation path for disambiguation.
	 * Use when multiple relations exist between same tables.
	 * @example 'author' or 'editor' when User has both relations to Post
	 */
	readonly via?: string;

	/**
	 * Maximum number of related records to include per parent.
	 * Only effective with LATERAL JOIN strategy (PostgreSQL/DuckDB/MSSQL).
	 * @example limit: 5 - fetch at most 5 related records per parent
	 */
	readonly limit?: number;

	/**
	 * Order by for related records (used with limit).
	 * @example orderBy: [{ field: 'createdAt', direction: 'desc' }]
	 */
	readonly orderBy?: readonly OrderByIntent[];
}

// ============================================================================
// OrderBy Intent - Sorting
// ============================================================================

/**
 * OrderBy intent - sort results
 */
export interface OrderByIntent {
	/** Field name to sort by */
	readonly field: string;

	/** Sort direction */
	readonly direction: SortDirection;

	/**
	 * Where to place NULL values
	 * @default 'last' for 'asc', 'first' for 'desc' (database default)
	 */
	readonly nulls?: NullsPosition;
}

// ============================================================================
// Query Intent - Complete Query Definition
// ============================================================================

/**
 * Query intent - complete query definition
 * Main entry point for the intent AST
 */
export interface QueryIntent {
	/** Query type - currently only 'select' supported */
	readonly type: 'select';

	/** Target table name */
	readonly from: string;

	/** Columns to retrieve */
	readonly select?: SelectIntent;

	/** Filter conditions */
	readonly where?: WhereIntent;

	/** Relations to include */
	readonly include?: readonly IncludeIntent[];

	/** Sort order */
	readonly orderBy?: readonly OrderByIntent[];

	/**
	 * Fields to group by for aggregate queries.
	 * When specified, SELECT must include only grouped fields and aggregates.
	 */
	readonly groupBy?: readonly string[];

	/** Maximum number of rows */
	readonly limit?: number;

	/** Number of rows to skip */
	readonly offset?: number;
}

// ============================================================================
// Recursive CTE Intent - Hierarchical Data Traversal (RFC-001)
// ============================================================================

/**
 * Node ID expression for recursive CTE anchor.
 * Used to define the join key for recursive traversal.
 */
export type RecursiveNodeIdExpr =
	| { readonly kind: 'column'; readonly name: string; readonly as?: string }
	| {
			readonly kind: 'literal';
			readonly value: unknown;
			readonly as?: string;
	  }
	| {
			readonly kind: 'binary';
			readonly left: RecursiveNodeIdExpr;
			readonly op: string;
			readonly right: RecursiveNodeIdExpr;
			readonly as?: string;
	  };

/**
 * Adjacency-list traversal (self-referential table).
 * Example: roles.parent_id → roles.id
 */
export interface AdjacencyTraversal {
	readonly kind: 'adjacency';

	/** Table containing hierarchical data */
	readonly nodeTable: string;

	/** Primary key column (e.g., "id") */
	readonly nodeId: string;

	/** Foreign key pointing to parent (e.g., "parent_id") */
	readonly parentId: string;

	/** Traversal direction */
	readonly direction: 'descendants' | 'ancestors';

	/** Filter applied to each step (e.g., active = true) */
	readonly stepWhere?: WhereIntent;
}

/**
 * Edge-table traversal (separate join table).
 * Example: role_inheritance(from_role_id, to_role_id)
 */
export interface EdgeTableTraversal {
	readonly kind: 'edge-table';

	/** Node table containing hierarchical data */
	readonly nodeTable: string;

	/** Edge table containing relationships */
	readonly edgeTable: string;

	/** Primary key column in node table (e.g., "id") */
	readonly nodeId: string;

	/** Source column in edge table (e.g., "from_role_id") */
	readonly edgeFrom: string;

	/** Target column in edge table (e.g., "to_role_id") */
	readonly edgeTo: string;

	/** Traversal direction */
	readonly direction: 'out' | 'in' | 'both';

	/** Filter on edges (e.g., relationship_type = 'inheritance') */
	readonly edgeWhere?: WhereIntent;

	/** Filter on nodes (e.g., active = true) */
	readonly nodeWhere?: WhereIntent;

	/** Edge attributes to include in result */
	readonly edgeSelect?: readonly string[];

	/**
	 * Hint for edge storage semantics (only affects `direction: 'both'`).
	 *
	 * - 'unknown' (default): Edges may exist in both directions (A→B and B→A).
	 *   Uses UNION (distinct) to avoid duplicates. Safe but slower.
	 * - 'directed-only': Caller guarantees edges are stored once only.
	 *   Uses UNION ALL for performance. INCORRECT if duplicates exist.
	 */
	readonly edgeStorageHint?: 'unknown' | 'directed-only';
}

/**
 * Custom traversal for complex cases (P2 escape hatch).
 */
export interface CustomTraversal {
	readonly kind: 'custom';
	/** Explicit step query builder - reserved for P2 */
	readonly stepBuilder?: unknown;
}

/**
 * Recursive traversal type union.
 */
export type RecursiveTraversal =
	| AdjacencyTraversal
	| EdgeTableTraversal
	| CustomTraversal;

/**
 * Tracking options for recursive traversal.
 */
export interface RecursiveTrackOptions {
	/** Depth counter (starts at 0) */
	readonly depth?: {
		readonly as?: string; // Default: "depth"
	};

	/** Path tracking for cycle detection + debugging */
	readonly path?: {
		/** Columns to trace in path (default: nodeId only) */
		readonly by?: 'nodeId' | readonly string[];
		/** Result column name (default: "path") */
		readonly as?: string;
		/** Storage strategy (default: 'array' for PostgreSQL, 'string' for others) */
		readonly strategy?: 'array' | 'string';
		/** Separator for string strategy (default: '/') */
		readonly separator?: string;
	};

	/** Cycle detection marker */
	readonly isCycle?: {
		readonly as?: string; // Default: "is_cycle"
	};
}

/**
 * Join clause for CTE emit composition.
 * Allows joining the CTE result with additional tables for final projection.
 */
export interface EmitJoinClause {
	/** Table to join with */
	readonly table: string;

	/** Join type (default: 'inner') */
	readonly type?: 'inner' | 'left';

	/** Alias for this table (auto-generated if not provided) */
	readonly as?: string;

	/** Join condition */
	readonly on: {
		/** Column from CTE or previous joined table */
		readonly left: string;
		/** Column from this table */
		readonly right: string;
	};

	/** Columns to select from this table */
	readonly select?: readonly (
		| string
		| { readonly column: string; readonly as: string }
	)[];
}

/**
 * Emit options for recursive CTE final projection.
 */
export interface RecursiveEmitOptions {
	/** Fields to select from CTE */
	readonly select?: readonly string[];
	/** Filter on generated rows */
	readonly where?: WhereIntent;
	/** Ordering */
	readonly orderBy?: readonly OrderByIntent[];
	/** Join CTE result with additional tables for composition */
	readonly joinWith?: readonly EmitJoinClause[];
	/** Apply DISTINCT to final result */
	readonly distinct?: boolean;
}

/**
 * PostgreSQL-specific options for recursive CTE (capability-gated).
 */
export interface RecursiveAdvancedOptions {
	/**
	 * Cycle detection strategy (adapter-specific implementation).
	 * - 'error': Throw on cycle detection
	 * - 'stop': Stop traversal at cycle (prune branch)
	 * - 'mark': Add is_cycle column to results
	 *
	 * PostgreSQL 14+ uses native CYCLE clause.
	 * Other adapters may use application-level detection.
	 */
	readonly cycle?: 'error' | 'stop' | 'mark';

	/**
	 * Traversal search order (adapter-specific implementation).
	 * - 'depth': Depth-first search order
	 * - 'breadth': Breadth-first search order
	 *
	 * PostgreSQL 14+ uses native SEARCH clause.
	 * Other adapters may use ORDER BY on depth column.
	 */
	readonly search?: 'depth' | 'breadth';
}

/**
 * Deduplication strategy for recursive CTE.
 *
 * - 'none': No dedup. May return same node multiple times via different paths.
 *   Fastest. Use when you need all paths or when graph is known to be a tree.
 *
 * - 'final': One row per nodeId in final output.
 *   Implemented via `DISTINCT ON (nodeId)` (PostgreSQL) or
 *   `ROW_NUMBER() OVER (PARTITION BY nodeId)` fallback.
 *   ⚠️ NOT the same as `query.distinct()` which dedupes on entire row!
 *
 * Note: 'global' (UNION instead of UNION ALL) was considered but not implemented.
 * 'final' provides the same end result with better performance characteristics.
 */
export type RecursiveDedupe = 'none' | 'final';

/**
 * Recursive CTE intent for hierarchical data traversal.
 *
 * Key invariant: anchor and step MUST produce identical column shape.
 * The planner validates this and auto-injects nodeIdExpr.
 *
 * @see RFC-001 for detailed specification
 */
export interface RecursiveIntent {
	readonly type: 'recursive';

	/** CTE name for the recursive query */
	readonly cteName: string;

	// ─────────────────────────────────────────────────────────────────────────
	// START (anchor/seed)
	// ─────────────────────────────────────────────────────────────────────────

	readonly start: {
		/** Source table for anchor query */
		readonly from: string;

		/** Filter for seed rows (e.g., where id = $userId) */
		readonly where?: WhereIntent;

		/**
		 * REQUIRED: Expression for node ID. Auto-injected into select.
		 * This ensures the recursive join always has the key column.
		 */
		readonly nodeIdExpr: RecursiveNodeIdExpr;

		/** Additional fields to select (beyond nodeId) */
		readonly select?: readonly string[];
	};

	// ─────────────────────────────────────────────────────────────────────────
	// TRAVERSAL
	// ─────────────────────────────────────────────────────────────────────────

	/** Traversal configuration (adjacency-list or edge-table) */
	readonly traversal: RecursiveTraversal;

	// ─────────────────────────────────────────────────────────────────────────
	// TRACKING (system columns)
	// ─────────────────────────────────────────────────────────────────────────

	/** Tracking options for depth, path, and cycle detection */
	readonly track?: RecursiveTrackOptions;

	// ─────────────────────────────────────────────────────────────────────────
	// SAFETY
	// ─────────────────────────────────────────────────────────────────────────

	/** Maximum recursion depth (REQUIRED) */
	readonly maxDepth: number;

	/** Maximum rows (optional safety limit) */
	readonly maxRows?: number;

	/** Deduplication strategy */
	readonly dedupe?: RecursiveDedupe;

	// ─────────────────────────────────────────────────────────────────────────
	// EMIT (final projection)
	// ─────────────────────────────────────────────────────────────────────────

	/** Final projection options */
	readonly emit?: RecursiveEmitOptions;

	// ─────────────────────────────────────────────────────────────────────────
	// ADVANCED OPTIONS (capability-gated, adapter-specific implementation)
	// ─────────────────────────────────────────────────────────────────────────

	/** Advanced recursive options (cycle detection, search order) */
	readonly advancedOptions?: RecursiveAdvancedOptions;
}

// ============================================================================
// Mutation Intents - Insert, Update, Delete (DX-010)
// ============================================================================

/**
 * Insert intent - insert one or more rows into a table.
 * @example { type: 'insert', table: 'users', values: [{ name: 'Alice' }] }
 */
export interface InsertIntent {
	readonly type: 'insert';

	/** Target table name */
	readonly table: string;

	/** Values to insert (single object or array for bulk insert) */
	readonly values: readonly Record<string, unknown>[];

	/**
	 * Columns to return from inserted rows (DX-026).
	 * Requires adapter capability: supportsReturning
	 * @example ['id', 'created_at']
	 */
	readonly returning?: readonly string[];
}

/**
 * Update intent - update rows matching a condition.
 * @example { type: 'update', table: 'users', set: { name: 'Bob' }, where: ... }
 */
export interface UpdateIntent {
	readonly type: 'update';

	/** Target table name */
	readonly table: string;

	/** Fields to update with new values */
	readonly set: Record<string, unknown>;

	/** Filter condition (required for safety, unless allowAll is true) */
	readonly where?: WhereIntent;

	/** Explicitly allow update without WHERE (for updateAll) */
	readonly allowAll?: boolean;

	/**
	 * Columns to return from updated rows (DX-026).
	 * Requires adapter capability: supportsReturning
	 * @example ['id', 'updated_at']
	 */
	readonly returning?: readonly string[];
}

/**
 * Delete intent - delete rows matching a condition.
 * @example { type: 'delete', table: 'users', where: ... }
 */
export interface DeleteIntent {
	readonly type: 'delete';

	/** Target table name */
	readonly table: string;

	/** Filter condition (required for safety, unless allowAll is true) */
	readonly where?: WhereIntent;

	/** Explicitly allow delete without WHERE (for deleteAll) */
	readonly allowAll?: boolean;

	/**
	 * Relations to cascade delete.
	 * - undefined: no cascade
	 * - true: cascade all relations
	 * - string[]: cascade specific relations
	 */
	readonly cascade?: boolean | readonly string[];

	/**
	 * Columns to return from deleted rows (DX-026).
	 * Requires adapter capability: supportsReturning
	 * @example ['id', 'email']
	 */
	readonly returning?: readonly string[];
}

/**
 * Upsert conflict target - specifies which columns determine uniqueness.
 */
export type UpsertConflictTarget =
	| { readonly columns: readonly string[] }
	| { readonly constraint: string };

/**
 * Upsert conflict action - what to do when conflict occurs.
 */
export type UpsertConflictAction =
	| { readonly type: 'doNothing' }
	| {
			readonly type: 'doUpdate';
			/** Fields to update on conflict. If undefined, updates all non-conflict columns. */
			readonly set?: Record<string, unknown>;
			/** Optional WHERE clause for conditional update */
			readonly where?: WhereIntent;
	  };

/**
 * Upsert intent - insert or update on conflict (DX-026).
 * Implements INSERT ... ON CONFLICT ... DO UPDATE/NOTHING pattern.
 *
 * @example doNothing
 * {
 *   type: 'upsert',
 *   table: 'users',
 *   values: [{ email: 'a@b.com', name: 'Alice' }],
 *   onConflict: { columns: ['email'] },
 *   action: { type: 'doNothing' }
 * }
 *
 * @example doUpdate
 * {
 *   type: 'upsert',
 *   table: 'users',
 *   values: [{ email: 'a@b.com', name: 'Alice' }],
 *   onConflict: { columns: ['email'] },
 *   action: { type: 'doUpdate', set: { name: 'Alice Updated' } }
 * }
 */
export interface UpsertIntent {
	readonly type: 'upsert';

	/** Target table name */
	readonly table: string;

	/** Values to insert (single object or array for bulk upsert) */
	readonly values: readonly Record<string, unknown>[];

	/** Conflict target - columns or constraint name */
	readonly onConflict: UpsertConflictTarget;

	/** Action to take on conflict */
	readonly action: UpsertConflictAction;

	/**
	 * Columns to return from affected rows (DX-026).
	 * Requires adapter capability: supportsReturning
	 * @example ['id', 'created_at', 'updated_at']
	 */
	readonly returning?: readonly string[];
}

/**
 * Union of all mutation intents.
 */
export type MutationIntent =
	| InsertIntent
	| UpdateIntent
	| DeleteIntent
	| UpsertIntent;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a where intent is a comparison
 */

// ============================================================================
// Window Intent Type Guards
// ============================================================================

/**
 * Check if an intent is a window function intent
 */
export function isWindowIntent(intent: unknown): intent is WindowIntent {
	return (
		typeof intent === 'object' &&
		intent !== null &&
		'kind' in intent &&
		(intent as { kind: unknown }).kind === 'window'
	);
}

/**
 * Check if a window function requires a field (aggregate or offset functions)
 */
export function isAggregateWindowFunction(
	fn: WindowFunction,
): fn is AggregateWindowFunction | OffsetWindowFunction {
	return ['sum', 'avg', 'count', 'min', 'max', 'lag', 'lead'].includes(fn);
}

/**
 * Check if a window function is a ranking function (no field required)
 */
export function isRankingWindowFunction(
	fn: WindowFunction,
): fn is RankingWindowFunction {
	return ['row_number', 'rank', 'dense_rank'].includes(fn);
}
export function isWhereComparison(
	where: WhereIntent,
): where is WhereComparisonIntent {
	return where.kind === 'comparison';
}

/**
 * Check if a where intent is a like filter
 */
export function isWhereLike(where: WhereIntent): where is WhereLikeIntent {
	return where.kind === 'like';
}

/**
 * Check if a where intent is a subquery filter
 */
export function isWhereSubquery(
	where: WhereIntent,
): where is WhereSubqueryIntent {
	return where.kind === 'subquery';
}

/**
 * Check if a value is a subquery ref (column reference in subquery)
 */
export function isSubqueryRef(value: unknown): value is SubqueryRefIntent {
	return (
		typeof value === 'object' &&
		value !== null &&
		'kind' in value &&
		(value as { kind: unknown }).kind === 'ref'
	);
}

/**
 * Check if a where intent is an in filter
 */
export function isWhereIn(where: WhereIntent): where is WhereInIntent {
	return where.kind === 'in';
}

/**
 * Check if a where intent is a null filter
 */
export function isWhereNull(where: WhereIntent): where is WhereNullIntent {
	return where.kind === 'null';
}

/**
 * Check if a where intent is a logical AND
 */
export function isWhereAnd(where: WhereIntent): where is WhereAndIntent {
	return where.kind === 'and';
}

/**
 * Check if a where intent is a logical OR
 */
export function isWhereOr(where: WhereIntent): where is WhereOrIntent {
	return where.kind === 'or';
}

/**
 * Check if a where intent is a logical NOT
 */
export function isWhereNot(where: WhereIntent): where is WhereNotIntent {
	return where.kind === 'not';
}

/**
 * Check if a where intent is an exists filter
 */
export function isWhereExists(where: WhereIntent): where is WhereExistsIntent {
	return where.kind === 'exists';
}

/**
 * Check if a where intent is a not exists filter
 */
export function isWhereNotExists(
	where: WhereIntent,
): where is WhereNotExistsIntent {
	return where.kind === 'notExists';
}

/**
 * Check if a where intent is a relation filter
 */
export function isWhereRelationFilter(
	where: WhereIntent,
): where is WhereRelationFilterIntent {
	return where.kind === 'relationFilter';
}

/**
 * Check if a where intent is any relation-based filter
 */
export function isWhereRelationBased(
	where: WhereIntent,
): where is
	| WhereExistsIntent
	| WhereNotExistsIntent
	| WhereRelationFilterIntent {
	return (
		where.kind === 'exists' ||
		where.kind === 'notExists' ||
		where.kind === 'relationFilter'
	);
}

/**
 * Check if a where intent is a logical operator (and/or/not)
 */
export function isWhereLogical(
	where: WhereIntent,
): where is WhereAndIntent | WhereOrIntent | WhereNotIntent {
	return where.kind === 'and' || where.kind === 'or' || where.kind === 'not';
}

/**
 * Check if a select intent selects all columns
 */
export function isSelectAll(select: SelectIntent): select is SelectAllIntent {
	return select.type === 'all';
}

/**
 * Check if a select intent selects specific fields
 */
export function isSelectFields(
	select: SelectIntent,
): select is SelectFieldsIntent {
	return select.type === 'fields';
}

/**
 * Check if a select intent is an aggregate select
 */
export function isSelectAggregate(
	select: SelectIntent,
): select is SelectAggregateIntent {
	return select.type === 'aggregate';
}

/**
 * Check if a select intent has expressions
 */
export function isSelectWithExpressions(
	select: SelectIntent,
): select is SelectWithExpressionsIntent {
	return select.type === 'expressions';
}

/**
 * Check if an expression is a COALESCE expression
 */
export function isCoalesceExpression(
	expr: ExpressionIntent,
): expr is CoalesceExpressionIntent {
	return expr.kind === 'coalesce';
}

/**
 * Check if an expression is a raw SQL expression
 */
export function isRawExpression(
	expr: ExpressionIntent,
): expr is RawExpressionIntent {
	return expr.kind === 'raw';
}

// ============================================================================
// Recursive CTE Type Guards
// ============================================================================

/**
 * Check if a traversal is adjacency-list based
 */
export function isAdjacencyTraversal(
	traversal: RecursiveTraversal,
): traversal is AdjacencyTraversal {
	return traversal.kind === 'adjacency';
}

/**
 * Check if a traversal is edge-table based
 */
export function isEdgeTableTraversal(
	traversal: RecursiveTraversal,
): traversal is EdgeTableTraversal {
	return traversal.kind === 'edge-table';
}

/**
 * Check if a traversal is custom
 */
export function isCustomTraversal(
	traversal: RecursiveTraversal,
): traversal is CustomTraversal {
	return traversal.kind === 'custom';
}

/**
 * Check if an intent is a recursive CTE intent
 */
export function isRecursiveIntent(
	intent: QueryIntent | RecursiveIntent,
): intent is RecursiveIntent {
	return intent.type === 'recursive';
}

// ============================================================================
// Mutation Intent Type Guards
// ============================================================================

/**
 * Check if an intent is an insert intent
 */
export function isInsertIntent(
	intent: QueryIntent | RecursiveIntent | MutationIntent,
): intent is InsertIntent {
	return intent.type === 'insert';
}

/**
 * Check if an intent is an update intent
 */
export function isUpdateIntent(
	intent: QueryIntent | RecursiveIntent | MutationIntent,
): intent is UpdateIntent {
	return intent.type === 'update';
}

/**
 * Check if an intent is a delete intent
 */
export function isDeleteIntent(
	intent: QueryIntent | RecursiveIntent | MutationIntent,
): intent is DeleteIntent {
	return intent.type === 'delete';
}

/**
 * Check if an intent is an upsert intent (DX-026)
 */
export function isUpsertIntent(
	intent: QueryIntent | RecursiveIntent | MutationIntent,
): intent is UpsertIntent {
	return intent.type === 'upsert';
}

/**
 * Check if an intent is any mutation intent
 */
export function isMutationIntent(
	intent: QueryIntent | RecursiveIntent | MutationIntent,
): intent is MutationIntent {
	return (
		intent.type === 'insert' ||
		intent.type === 'update' ||
		intent.type === 'delete' ||
		intent.type === 'upsert'
	);
}
