/**
 * @fileoverview ES6 Symbols for type-safe query API metadata.
 *
 * These symbols are used as property keys in TableRef, ColumnRef, and RelationRef
 * to store metadata without colliding with user-defined column names.
 *
 * @example
 * ```typescript
 * import { TABLE_META, COLUMN_META } from './symbols';
 *
 * // Access table name from TableRef
 * const tableName = users[TABLE_META]; // 'users'
 *
 * // Access column name from ColumnRef
 * const columnName = users.id[COLUMN_META]; // 'id'
 * ```
 *
 * @module symbols
 * @since DX-040
 */

/**
 * Symbol for accessing table name metadata from a TableRef.
 *
 * @description
 * Used internally to retrieve the table name from a TableRef object.
 * Uses `Symbol.for()` to create a global symbol that survives serialization
 * and can be accessed across module boundaries.
 *
 * @example
 * ```typescript
 * const { users } = schema.tables;
 * const tableName = users[TABLE_META]; // 'users'
 * ```
 */
export const TABLE_META: unique symbol = Symbol.for('dbsp:table');

/**
 * Symbol for accessing column name metadata from a ColumnRef.
 *
 * @description
 * Used internally to retrieve the column name from a ColumnRef object.
 * Uses `Symbol.for()` for cross-module accessibility.
 *
 * @example
 * ```typescript
 * const { users } = schema.tables;
 * const columnName = users.id[COLUMN_META]; // 'id'
 * ```
 */
export const COLUMN_META: unique symbol = Symbol.for('dbsp:column');

/**
 * Symbol for accessing relation metadata from a RelationRef.
 *
 * @description
 * Used internally to retrieve relation information (target table, relation type)
 * from a RelationRef object. Uses `Symbol.for()` for cross-module accessibility.
 *
 * @example
 * ```typescript
 * const { users } = schema.tables;
 * const relInfo = users.posts[RELATION_META];
 * // { target: 'posts', type: 'hasMany' }
 * ```
 */
export const RELATION_META: unique symbol = Symbol.for('dbsp:relation');

/**
 * Symbol for type branding (internal use).
 *
 * @description
 * Used internally to distinguish between TableRef, ColumnRef, and RelationRef
 * at runtime. This enables type guards and runtime validation.
 * Uses `Symbol.for()` for cross-module accessibility.
 *
 * @example
 * ```typescript
 * function isTableRef(value: unknown): value is TableRef<any, any> {
 *   return typeof value === 'object' && value !== null && BRAND in value
 *     && (value as any)[BRAND] === 'TableRef';
 * }
 * ```
 */
export const BRAND: unique symbol = Symbol.for('dbsp:brand');

/**
 * Symbol for tracking the relation path through which a column was accessed.
 *
 * @description
 * Used to enable cross-table queries. When a column is accessed through a relation
 * (e.g., `users.posts.published`), this symbol stores the relation path.
 * This allows the query builder to generate EXISTS subqueries automatically.
 * Uses `Symbol.for()` for cross-module accessibility.
 *
 * @example
 * ```typescript
 * const { users } = schema.tables;
 * const col = users.posts.published;
 * const path = col[RELATION_PATH]; // ['posts']
 * // Multiple hops: users.posts.comments.author
 * // path would be ['posts', 'comments']
 * ```
 */
export const RELATION_PATH: unique symbol = Symbol.for('dbsp:relationPath');

/**
 * Accessor on a RelationRef returning a RelationRef for the same target with an
 * empty relation path: its columns compile to the bare column, so a relation
 * predicate binds them to its own range.
 *
 * @internal Used by `every`/`some`/`none`; not part of the public surface.
 */
export const RELATION_REROOT: unique symbol = Symbol('dbsp:relationReroot');

/**
 * Set on a RelationRef whose relation chain starts at a TableRef
 * (`orm.tables.users.writings`), and on the ColumnRefs reached through it,
 * unlike one re-rooted for a quantifier callback; its value is that table's
 * model name. Inside a body the resolver reads the path from that table's
 * range (#1014).
 *
 * @internal
 */
export const RELATION_FROM_TABLE: unique symbol = Symbol.for(
	'dbsp:relationFromTable',
);

/**
 * Non-enumerable token of the quantifier callback a ref comes from, carried by
 * the re-rooted RelationRef, its chained relations, their ColumnRefs and the
 * intents built from them; the resolver reads such a node from the range of the
 * quantifier occurrence that issued the token (#1014).
 *
 * @internal
 */
export const CALLBACK_SCOPE: unique symbol = Symbol.for('dbsp:callbackScope');

/**
 * Non-enumerable token a quantifier intent carries for its own callback: the
 * resolver binds every node carrying that token as `CALLBACK_SCOPE` to the
 * range this quantifier occurrence creates (#1014).
 *
 * @internal
 */
export const QUANTIFIER_SCOPE: unique symbol = Symbol.for(
	'dbsp:quantifierScope',
);

/**
 * Non-enumerable mark of a relation predicate the planner rewrote from a
 * foreign-key-inverse `inSubquery`; its value is the `in` node's field. Its
 * target range stays a query root for the resolver's origins (#1014).
 *
 * @internal
 */
export const REWRITTEN_SUBQUERY: unique symbol = Symbol.for(
	'dbsp:rewrittenSubquery',
);

/**
 * Type declarations for Symbol keys to enable TypeScript inference.
 *
 * These types allow TypeScript to understand the shape of objects
 * that use these symbols as keys.
 */
export type TableMetaKey = typeof TABLE_META;
export type ColumnMetaKey = typeof COLUMN_META;
export type RelationMetaKey = typeof RELATION_META;
export type BrandKey = typeof BRAND;

// ============================================================================
// Type Guards for Symbol-keyed Properties
// ============================================================================

/**
 * Type-safe check for the presence of a symbol-keyed property on an unknown value.
 *
 * Replaces `SYMBOL in (value as unknown as object)` casts throughout the DX layer.
 *
 * @param value - The value to check (any type)
 * @param sym - The symbol key to look for
 * @returns `true` if `value` is a non-null object containing `sym`
 *
 * @example
 * ```typescript
 * if (hasSymbolMeta(value, COLUMN_META)) {
 *   // value is narrowed to Record<typeof COLUMN_META, unknown>
 * }
 * ```
 */
export function hasSymbolMeta<S extends symbol>(
	value: unknown,
	sym: S,
): value is Record<S, unknown> {
	return typeof value === 'object' && value !== null && sym in value;
}

/**
 * Brand of a select query builder (`orm.select()`, `orm.from()`), set on its
 * prototype. ADR 0011 turns such a builder, passed as a scalar leaf, into a
 * subquery carrying the builder's filter policy.
 */
export const SELECT_BUILDER_BRAND: unique symbol = Symbol.for(
	'dbsp:select-builder',
);

/**
 * Brand of every other builder (set operations, CTE, recursive, NQL, insert,
 * update, upsert, delete), set on its prototype. Passed as a scalar leaf or as
 * a subquery, such a builder is refused by name: it is never planned as a
 * subquery body and never bound as a parameter.
 */
export const NON_SUBQUERY_BUILDER_BRAND: unique symbol = Symbol.for(
	'dbsp:non-subquery-builder',
);
