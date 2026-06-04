/**
 * @module intent/expression-intent
 * Expression intent types for computed/derived values in SELECT.
 */

import type { QueryIntent } from './query-intent.js';
import type { AggregateFunction } from './select-intent.js';
import type { WhereIntent } from './where-intent.js';

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
 * Simple column expression: just a column reference, optionally aliased
 * Used by NQL when a column is selected without modification
 * @example { kind: 'column', column: 'name' }
 *          → SELECT "name"
 * @example { kind: 'column', column: 'name', as: 'userName' }
 *          → SELECT "name" AS "userName"
 */
export interface ColumnExpressionIntent {
	readonly kind: 'column';
	/** Column name to select */
	readonly column: string;
	/** Optional alias for the result column */
	readonly as?: string;
}

/**
 * Column alias expression: simple column reference with alias
 * Uses native Kysely eb.ref().as() - type-safe and dialect-portable
 * @example { kind: 'columnAlias', column: 'name', alias: 'userName' }
 *          → SELECT "name" AS "userName"
 */
export interface ColumnAliasIntent {
	readonly kind: 'columnAlias';
	/** Column name to select */
	readonly column: string;
	/** Alias for the result column */
	readonly alias: string;
}

/**
 * Relation column expression: select a column from a related table
 * Auto-creates JOIN via include mechanism and selects with custom alias
 * @example { kind: 'relationColumn', relation: 'category', column: 'name', as: 'categoryName' }
 *          → SELECT t1."name" AS "categoryName" (where t1 is the joined category table)
 * @example { kind: 'relationColumn', relation: 'category.parent', column: 'name', as: 'parentCategoryName' }
 *          → Multi-level join: products → category → parent, select parent.name
 */
export interface RelationColumnIntent {
	readonly kind: 'relationColumn';
	/** Relation path to traverse (dot-separated for multi-level) */
	readonly relation: string;
	/** Column name to select from the target relation */
	readonly column: string;
	/** Alias for the result column */
	readonly as: string;
}

/**
 * Aggregate expression intent for SELECT expressions
 * @example { kind: 'aggregate', function: 'count', as: 'total' } → COUNT(*) AS total
 * @example { kind: 'aggregate', function: 'sum', field: 'price', as: 'total_price' } → SUM(price) AS total_price
 * @example { kind: 'aggregate', function: 'count', field: 'id', distinct: true, as: 'unique_count' }
 *          → COUNT(DISTINCT id) AS unique_count
 */
export interface AggregateExpressionIntent {
	readonly kind: 'aggregate';
	/** Aggregate function */
	readonly function: AggregateFunction;
	/** Field to aggregate (or '*' for count) */
	readonly field: string | '*';
	/** Alias for result column */
	readonly as?: string | undefined;
	/** Whether to apply DISTINCT to the aggregate */
	readonly distinct?: boolean | undefined;
	/** Extra arguments for multi-arg aggregates like string_agg(field, separator) */
	readonly extraArgs?: readonly unknown[] | undefined;
	/** FILTER (WHERE ...) clause for conditional aggregation */
	readonly filter?: WhereIntent | undefined;
}

/**
 * Pseudo-column traversal keyword for self-referential relations.
 * Used by NQL to traverse hierarchical/tree structures.
 *
 * Default keywords: 'parent', 'child', 'ascendant', 'descendant'.
 * Custom keywords are supported via schema configuration
 * (e.g., 'manager', 'managee' via parentRole/childRole).
 */
export type PseudoColumnTraversal = string;

/**
 * Pseudo-column expression intent for self-referential traversal.
 * Enables access to columns on related rows in hierarchical structures.
 *
 * @example { kind: 'pseudoColumn', traversal: 'parent', targetColumn: 'name', as: 'parent.name' }
 *          → SELECT parent_row.name AS "parent.name" via CTE join
 * @example { kind: 'pseudoColumn', traversal: 'ascendant', targetColumn: 'title', as: 'ancestor_title' }
 *          → Recursive CTE to find all ancestors, return their title column
 */
export interface PseudoColumnExpressionIntent {
	readonly kind: 'pseudoColumn';
	/** Traversal type: single-hop (parent/child) or recursive (ascendant/descendant) */
	readonly traversal: PseudoColumnTraversal;
	/** The column to access on the target row(s) */
	readonly targetColumn: string;
	/** Alias for result column (required) */
	readonly as: string;
	/** Optional bounded depth for ascendant[N] / descendant[N] syntax */
	readonly depth?: number;
	/** Custom role name for multi-FK tables (e.g., 'manager' in manager.ascendant) */
	readonly role?: string;
	/**
	 * Chained traversals for multi-hop navigation (e.g., parent.parent.name → ['parent', 'parent']).
	 * When present, overrides single `traversal` field. Each element generates a successive self-join.
	 */
	readonly traversals?: readonly PseudoColumnTraversal[];
}

/**
 * Generic function expression (e.g., now(), upper(name), coalesce(a, b)).
 * Used for SQL functions that are not aggregates.
 */
export interface FunctionExpressionIntent {
	readonly kind: 'function';
	/** Function name (e.g., 'upper', 'now', 'coalesce') */
	readonly name: string;
	/** Function arguments */
	readonly args: readonly unknown[];
	/** Alias for result column */
	readonly as?: string | undefined;
}

/**
 * Scalar subquery in SELECT clause.
 * Produces a single value from a nested query.
 */
export interface SubqueryExpressionIntent {
	readonly kind: 'subquery';
	/** The nested query */
	readonly query: QueryIntent;
	/** Alias for result column */
	readonly as?: string | undefined;
}

/**
 * Arithmetic expression (e.g., price * quantity).
 * Binary operation with left operand, operator, and right operand.
 */
export interface ArithmeticExpressionIntent {
	readonly kind: 'arithmetic';
	/** Left operand (column name or value) */
	readonly left: string | number | unknown;
	/** Arithmetic operator */
	readonly operator: '+' | '-' | '*' | '/' | '%';
	/** Right operand (column name or value) */
	readonly right: string | number | unknown;
	/** Alias for result column */
	readonly as?: string | undefined;
}

/**
 * Literal value expression: string, number, boolean, or null.
 * Used in CASE THEN/ELSE clauses for constant values.
 */
export interface LiteralExpressionIntent {
	readonly kind: 'literal';
	/** The literal value */
	readonly value: string | number | boolean | null;
	/** Optional alias */
	readonly as?: string | undefined;
}

/**
 * Comparison expression: left operator right.
 * Used in CASE WHEN conditions.
 */
export interface ComparisonExpressionIntent {
	readonly kind: 'comparison';
	/** Left side column reference */
	readonly column: string;
	/** Comparison operator */
	readonly operator: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like';
	/** Right side value */
	readonly value: unknown;
}

/**
 * CASE expression: conditional logic in SELECT.
 * CASE WHEN condition THEN result [WHEN ...] [ELSE default] END
 */
export interface CaseExpressionIntent {
	readonly kind: 'case';
	/** Array of WHEN-THEN pairs */
	readonly when: ReadonlyArray<{
		readonly condition: WhereIntent;
		readonly result: ExpressionIntent;
	}>;
	/** Optional ELSE clause */
	readonly else?: ExpressionIntent | undefined;
	/** Alias for result column */
	readonly as?: string | undefined;
}

// ============================================================================
// JSON/JSONB Operators (E13)
// ============================================================================

/**
 * JSON path extraction: col->'key' or col->>'key' (chained paths supported).
 * Also used for function notation: json_extract(col, 'key'), json_extract_text(col, 'key').
 */
export interface JsonExtractIntent {
	readonly kind: 'jsonExtract';
	readonly field: string;
	readonly path: readonly string[];
	/** 'json' = returns JSON value (->), 'text' = returns text (->>) */
	readonly mode: 'json' | 'text';
	readonly as?: string | undefined;
}

/**
 * JSON containment: col @> value (contains) or col <@ value (contained by).
 */
export interface JsonContainsIntent {
	readonly kind: 'jsonContains';
	readonly field: string;
	readonly value: unknown;
	/** true = <@ (contained by), false = @> (contains) */
	readonly reversed: boolean;
}

/**
 * JSON key existence: col ? 'key'.
 */
export interface JsonExistsIntent {
	readonly kind: 'jsonExists';
	readonly field: string;
	readonly key: string;
}

/**
 * JSON path extraction with array path: col #> '{a,b}' or col #>> '{a,b}'.
 */
export interface JsonPathExtractIntent {
	readonly kind: 'jsonPathExtract';
	readonly field: string;
	/** PostgreSQL array literal path, e.g. '{a,b,c}' */
	readonly path: string;
	/** 'json' = returns JSON (#>), 'text' = returns text (#>>) */
	readonly mode: 'json' | 'text';
	readonly as?: string | undefined;
}

/** Custom binary operator expression (e.g., <=> for pgvector) */
export interface CustomOpExpressionIntent {
	readonly kind: 'customOp';
	readonly operator: string;
	readonly left: ExpressionIntent;
	readonly right: ExpressionIntent;
	readonly as?: string;
}

/** Custom function call (e.g., paradedb.score) */
/** Represents a single ORDER BY entry inside an aggregate function. */
export interface AggOrderByArg {
	/** Discriminator to distinguish from regular expression args. */
	readonly __aggOrderBy: true;
	readonly field: string;
	readonly direction: 'asc' | 'desc';
}

export interface CustomFnExpressionIntent {
	readonly kind: 'customFn';
	readonly name: string;
	readonly args: readonly ExpressionIntent[];
	readonly as?: string;
	/** FILTER (WHERE ...) clause for conditional aggregation */
	readonly filter?: WhereIntent | undefined;
	/** ORDER BY clause for ordered aggregates (e.g. array_agg(x ORDER BY y)) */
	readonly aggOrderBy?: readonly AggOrderByArg[] | undefined;
}

/** Column reference in custom expressions */
export interface RefExpressionIntent {
	readonly kind: 'ref';
	readonly column: string;
}

/** Parameterized value with automatic $N binding */
export interface ParamExpressionIntent {
	readonly kind: 'param';
	readonly value: unknown;
}

/** Type cast expression */
export interface CastExpressionIntent {
	readonly kind: 'cast';
	readonly expr: ExpressionIntent;
	readonly typeName: string;
}

/** Named argument in a function call: name => value */
export interface NamedArgExpressionIntent {
	readonly kind: 'namedArg';
	readonly name: string;
	readonly value: ExpressionIntent;
}

/** Star/wildcard expression (*) — used in COUNT(*), SELECT *, etc. */
export interface StarExpressionIntent {
	readonly kind: 'star';
}

/** PostgreSQL ARRAY constructor: ARRAY[item1, item2, ...] */
export interface ArrayExpressionIntent {
	readonly kind: 'array';
	readonly elements: readonly ExpressionIntent[];
	readonly as?: string;
}

/** Unary operator expression (e.g., NOT, -, ~) */
export interface UnaryExpressionIntent {
	readonly kind: 'unary';
	readonly operator: string;
	readonly operand: ExpressionIntent;
	readonly as?: string;
}

/**
 * Expression intent union type - computed/derived values in SELECT
 * Extensible for future expression types
 */
export type ExpressionIntent =
	| ColumnExpressionIntent
	| CoalesceExpressionIntent
	| RawExpressionIntent
	| ColumnAliasIntent
	| RelationColumnIntent
	| WindowIntent
	| AggregateExpressionIntent
	| PseudoColumnExpressionIntent
	| FunctionExpressionIntent
	| SubqueryExpressionIntent
	| ArithmeticExpressionIntent
	| LiteralExpressionIntent
	| ComparisonExpressionIntent
	| CaseExpressionIntent
	| JsonExtractIntent
	| JsonContainsIntent
	| JsonExistsIntent
	| JsonPathExtractIntent
	| CustomOpExpressionIntent
	| CustomFnExpressionIntent
	| RefExpressionIntent
	| ParamExpressionIntent
	| CastExpressionIntent
	| UnaryExpressionIntent
	| NamedArgExpressionIntent
	| StarExpressionIntent
	| ArrayExpressionIntent;

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
/**
 * Window function intent (ranking branch): ROW_NUMBER / RANK / DENSE_RANK — no field required.
 *
 * @example
 * { kind: 'window', function: 'row_number', alias: 'rn', over: { orderBy: [{ field: 'created_at', direction: 'desc' }] } }
 */
export interface RankingWindowIntent {
	readonly kind: 'window';
	readonly function: RankingWindowFunction;
	readonly field?: never;
	/** Result column alias (required) */
	readonly alias: string;
	readonly offset?: never;
	readonly defaultValue?: never;
	/** OVER clause specification */
	readonly over: {
		readonly partitionBy?: readonly string[] | undefined;
		readonly orderBy?: readonly WindowOrderBy[] | undefined;
	};
}

/**
 * Window function intent (aggregate branch): SUM / AVG / COUNT / MIN / MAX — field required.
 *
 * @example
 * { kind: 'window', function: 'sum', field: 'amount', alias: 'running_total', over: { partitionBy: ['account_id'] } }
 */
/**
 * Window function intent (aggregate branch): SUM / AVG / COUNT / MIN / MAX.
 * Field is required for sum/avg/min/max; COUNT omits field to produce COUNT(*) OVER (...).
 *
 * @example SUM with field
 * { kind: 'window', function: 'sum', field: 'amount', alias: 'running_total', over: { partitionBy: ['account_id'] } }
 * @example COUNT(*)
 * { kind: 'window', function: 'count', alias: 'total', over: {} }
 */
export interface AggregateWindowIntent {
	readonly kind: 'window';
	readonly function: AggregateWindowFunction;
	/**
	 * Field to aggregate over.
	 * Required for sum/avg/min/max. Omit (or undefined) for COUNT(*) OVER (...).
	 */
	readonly field?: string | undefined;
	/** Result column alias (required) */
	readonly alias: string;
	readonly offset?: never;
	readonly defaultValue?: never;
	/** OVER clause specification */
	readonly over: {
		readonly partitionBy?: readonly string[] | undefined;
		readonly orderBy?: readonly WindowOrderBy[] | undefined;
	};
}

/**
 * Window function intent (offset branch): LAG / LEAD — field required, offset optional.
 *
 * @example
 * { kind: 'window', function: 'lag', field: 'salary', alias: 'prev_salary', over: { orderBy: [{ field: 'date', direction: 'asc' }] } }
 */
export interface OffsetWindowIntent {
	readonly kind: 'window';
	readonly function: OffsetWindowFunction;
	/** Field to access from the offset row (required for lag/lead) */
	readonly field: string;
	/** Result column alias (required) */
	readonly alias: string;
	/** Offset for lag/lead (default: 1 in PostgreSQL) */
	readonly offset?: number | undefined;
	/** Default value for lag/lead when row doesn't exist */
	readonly defaultValue?: unknown;
	/** OVER clause specification */
	readonly over: {
		readonly partitionBy?: readonly string[] | undefined;
		readonly orderBy?: readonly WindowOrderBy[] | undefined;
	};
}

/**
 * Window function intent for analytics over partitions.
 * Discriminated by function group:
 * - RankingWindowIntent: row_number / rank / dense_rank (no field)
 * - AggregateWindowIntent: sum / avg / count / min / max (field required)
 * - OffsetWindowIntent: lag / lead (field required, offset optional)
 */
export type WindowIntent =
	| RankingWindowIntent
	| AggregateWindowIntent
	| OffsetWindowIntent;

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
