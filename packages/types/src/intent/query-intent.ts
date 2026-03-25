/**
 * @module intent/query-intent
 * Query intent - complete query definition, main entry point for the intent AST.
 */

import type { IncludeIntent, OrderByIntent } from './include-intent.js';
import type { LockIntent } from './lock-intent.js';
import type { SelectIntent } from './select-intent.js';
import type { WhereIntent } from './where-intent.js';

// ============================================================================
// Join Intent - Explicit SQL JOIN (non-hydrating, flat result)
// ============================================================================

/**
 * Join intent — represents a SQL JOIN clause on the root query.
 *
 * Two discrimination modes (based on `on` presence):
 * - **Relation mode** (`relation` set, no `on`): FK auto-resolved, like `include` but flat (no hydration).
 * - **Table mode** (`table` set, `on` required): Explicit table name + ON condition. Required for self-joins.
 *
 * @example
 * ```typescript
 * // Relation mode — FK auto-resolved
 * orm.from(calls).join('caller')
 * orm.from(calls).join('callerFile', { type: 'left' })
 *
 * // Table mode — explicit ON condition
 * orm.from(embeddings).join('embeddings', {
 *   on: lt(ref('embeddings.id'), ref('e2.id')),
 *   as: 'e2',
 *   type: 'inner',
 * })
 * ```
 */
export type JoinIntent =
	| {
			/** FK-based join — relation name resolved to table + FK automatically */
			readonly relation: string;
			readonly table?: never;
			readonly on?: never;
			readonly alias?: string;
			readonly type: 'inner' | 'left';
	  }
	| {
			/** Explicit table join — ON condition required */
			readonly table: string;
			readonly relation?: never;
			readonly on: WhereIntent;
			readonly alias?: string;
			readonly type: 'inner' | 'left';
	  };

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

	/**
	 * Filter on aggregate results (applied after GROUP BY).
	 * Similar to WHERE but operates on aggregated values.
	 */
	readonly having?: WhereIntent;

	/**
	 * Whether to apply SELECT DISTINCT to deduplicate rows.
	 */
	readonly distinct?: boolean;

	/**
	 * Columns for PostgreSQL DISTINCT ON (...) clause.
	 * Produces: SELECT DISTINCT ON ("col1", "col2") ...
	 * Takes precedence over `distinct` when set.
	 */
	readonly distinctOn?: readonly string[];

	/** Maximum number of rows */
	readonly limit?: number;

	/** Number of rows to skip */
	readonly offset?: number;

	/**
	 * When true, the adapter wraps the query in SELECT EXISTS(...).
	 * The inner SELECT list is replaced with `1` and the result is `{ exists: boolean }`.
	 */
	readonly existsWrap?: boolean;

	/**
	 * Row-level lock for SELECT queries (e.g., FOR UPDATE SKIP LOCKED).
	 * Only valid in SELECT context — incompatible with GROUP BY, set operations.
	 */
	readonly lock?: LockIntent;

	/**
	 * Explicit SQL JOIN clauses (non-hydrating, flat result).
	 * Columns from joined tables appear in the flat result row.
	 * Two modes: relation-based (FK auto-resolved) or table-based (explicit ON condition).
	 */
	readonly joins?: readonly JoinIntent[];
}

// ============================================================================
// Set Operation Intent - UNION / INTERSECT / EXCEPT
// ============================================================================

/**
 * Set operation type: SQL standard set operations.
 */
export type SetOperationType = 'union' | 'intersect' | 'except';

/**
 * Set operation that combines two queries.
 * The result is a tree: each side can itself be a SetOperationIntent.
 *
 * @example
 * ```
 * users | select name | union (admins | select name)
 * → { op: 'union', all: false, left: QueryIntent, right: QueryIntent }
 * ```
 */
export interface SetOperationIntent {
	readonly kind: 'setOperation';
	readonly op: SetOperationType;
	readonly all: boolean;
	readonly left: QueryIntent | SetOperationIntent;
	readonly right: QueryIntent | SetOperationIntent;
}
