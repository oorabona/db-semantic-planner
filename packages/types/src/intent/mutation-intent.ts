/**
 * @module intent/mutation-intent
 * Mutation intent types for Insert, Update, Delete, Upsert (DX-010).
 */

import type { QueryIntent } from './query-intent.js';
import type { WhereIntent } from './where-intent.js';

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
 * Insert-from intent - insert rows from a SELECT query.
 * @example { type: 'insert_from', table: 'archived_users', source: 'users', where: {...} }
 */
export interface InsertFromIntent {
	readonly type: 'insert_from';

	/** Target table to insert into */
	readonly table: string;

	/** Source table to select from (table name or bound reference) */
	readonly source: string;

	/** Optional source query (when source is a bound reference from `| bind`) */
	readonly sourceQuery?: QueryIntent | undefined;

	/** Optional column mapping (defaults to same column names) */
	readonly columns?: readonly string[] | undefined;

	/** Filter condition for source rows */
	readonly where?: WhereIntent | undefined;

	/** Limit number of rows to insert */
	readonly limit?: number | undefined;

	/**
	 * Columns to return from inserted rows (DX-026).
	 * Requires adapter capability: supportsReturning
	 * @example ['id', 'created_at']
	 */
	readonly returning?: readonly string[];
}

/**
 * Upsert from intent - bulk upsert by selecting rows from a source table or CTE.
 * Produces: INSERT INTO target SELECT ... FROM source ON CONFLICT (columns) DO UPDATE SET ...
 * @example upsert into authors on id from counts
 */
export interface UpsertFromIntent {
	readonly type: 'upsert_from';

	/** Target table to upsert into */
	readonly table: string;

	/** Source table or bound CTE reference */
	readonly source: string;

	/** Optional source query (when source is a bound reference from `| bind`) */
	readonly sourceQuery?: QueryIntent | undefined;

	/** Conflict target columns for ON CONFLICT */
	readonly conflictColumns: readonly string[];

	/** Optional column mapping (defaults to same column names) */
	readonly columns?: readonly string[] | undefined;

	/** Filter condition for source rows */
	readonly where?: WhereIntent | undefined;

	/** Limit number of rows */
	readonly limit?: number | undefined;

	/**
	 * Columns to return from affected rows.
	 * Requires adapter capability: supportsReturning
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

/**
 * Batch update intent - update multiple rows using unnest FROM strategy.
 * Generates: UPDATE "table" SET "col" = t."col" FROM unnest($1::type[], ...) AS t("match", "col") WHERE "table"."match" = t."match"
 *
 * @example { type: 'batchUpdate', table: 'calls', matchColumns: ['id'], updates: [{id: 1, callee_id: 42}] }
 */
export interface BatchUpdateIntent {
	readonly type: 'batchUpdate';

	/** Target table name */
	readonly table: string;

	/** Column(s) used to match rows (WHERE clause join condition) */
	readonly matchColumns: readonly string[];

	/** Array of row objects containing match + update column values */
	readonly updates: readonly Record<string, unknown>[];

	/** Optional scalar values applied to ALL rows (non-array SET clause) */
	readonly scalarSet?: Record<string, unknown>;

	/** Columns to return from updated rows (RETURNING clause) */
	readonly returning?: readonly string[];
}


export type MutationIntent =
	| InsertIntent
	| InsertFromIntent
	| UpsertFromIntent
	| UpdateIntent
	| BatchUpdateIntent
	| DeleteIntent
	| UpsertIntent;
