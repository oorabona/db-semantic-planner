/**
 * @fileoverview Type-safe table and column reference types for the query API.
 *
 * This module defines the core reference types used in the type-safe query builder:
 * - `TableRef`: Reference to a table with typed columns and relations
 * - `ColumnRef`: Reference to a column with table, name, and TypeScript type
 * - `RelationRef`: Reference to a relation (FK-based join path)
 * - `AliasedColumn`: Column with an alias for result type inference
 * - `AllColumns`: Wildcard type for SELECT *
 *
 * These types use ES6 Symbols for internal metadata to avoid collision
 * with user-defined column names (see symbols.ts).
 *
 * @example
 * ```typescript
 * const { users } = schema.tables;
 *
 * // TableRef with columns
 * users.id           // ColumnRef<'users', 'id', number>
 * users.name         // ColumnRef<'users', 'name', string>
 * users['*']         // AllColumns<'users', {...}>
 *
 * // RelationRef for cross-table queries
 * users.posts        // RelationRef<'posts', Post[], 'hasMany'>
 * users.posts.title  // ColumnRef<'posts', 'title', string>
 * ```
 *
 * @module table-ref
 * @since DX-040
 */

import {
	BRAND,
	COLUMN_META,
	hasSymbolMeta,
	RELATION_META,
	RELATION_PATH,
	TABLE_META,
} from './symbols.js';

// Re-export symbols for convenience
export {
	TABLE_META,
	COLUMN_META,
	RELATION_META,
	RELATION_PATH,
	BRAND,
	hasSymbolMeta,
};

/**
 * Relation types supported by the ORM.
 */
export type RelationType = 'belongsTo' | 'hasMany' | 'hasOne';

/**
 * Base interface for ColumnRef metadata (using Symbols).
 * @internal
 */
interface ColumnRefBase<TTable extends string, TColumn extends string, TType> {
	/** @internal Table name metadata (via Symbol) */
	readonly [TABLE_META]: TTable;

	/** @internal Column name metadata (via Symbol) */
	readonly [COLUMN_META]: TColumn;

	/** @internal Type brand for runtime identification */
	readonly [BRAND]: 'ColumnRef';

	/**
	 * Phantom type for TypeScript inference.
	 * @internal Not used at runtime - only for type inference.
	 */
	readonly _type: TType;
}

/**
 * Reference to a column in a table.
 *
 * @typeParam TTable - The table name as a string literal type (e.g., 'users')
 * @typeParam TColumn - The column name as a string literal type (e.g., 'id')
 * @typeParam TType - The TypeScript type of the column value (e.g., number, string)
 *
 * @description
 * ColumnRef carries type information for compile-time inference while also
 * containing runtime metadata accessible via Symbols. The `_type` property
 * is a phantom type (never instantiated at runtime) used for inference.
 *
 * @example
 * ```typescript
 * // users.id is ColumnRef<'users', 'id', number>
 * const id: ColumnRef<'users', 'id', number>;
 *
 * // Access metadata (rarely needed by users)
 * id[TABLE_META]  // 'users'
 * id[COLUMN_META] // 'id'
 *
 * // Create alias for result type
 * id.as('userId') // AliasedColumn<'users', 'id', number, 'userId'>
 * ```
 */
export type ColumnRef<
	TTable extends string,
	TColumn extends string,
	TType,
> = ColumnRefBase<TTable, TColumn, TType> & {
	/**
	 * Create an aliased version of this column for result type inference.
	 *
	 * @typeParam TAlias - The alias name as a string literal type
	 * @param alias - Must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/` (validated at runtime)
	 * @returns AliasedColumn with the specified alias
	 * @throws Error if alias doesn't match the valid identifier pattern
	 *
	 * @example
	 * ```typescript
	 * users.id.as('userId')
	 * // Result type will use 'userId' instead of 'id'
	 * ```
	 */
	as<TAlias extends string>(
		alias: TAlias,
	): AliasedColumn<TTable, TColumn, TType, TAlias>;
};

/**
 * Column with an alias for result type inference.
 *
 * @typeParam TTable - The source table name
 * @typeParam TColumn - The source column name
 * @typeParam TType - The TypeScript type of the column value
 * @typeParam TAlias - The alias name that will appear in query results
 *
 * @description
 * Extends ColumnRef with an `_alias` property. When used in a query,
 * the result type will use the alias instead of the original column name.
 *
 * @example
 * ```typescript
 * const query = orm.from(users)
 *   .select(users.id.as('userId'))
 *   .all();
 * // Result type: { userId: number }[]
 * ```
 */
export type AliasedColumn<
	TTable extends string,
	TColumn extends string,
	TType,
	TAlias extends string,
> = ColumnRef<TTable, TColumn, TType> & {
	/**
	 * The alias name for this column.
	 * Used to determine the property name in query results.
	 */
	readonly _alias: TAlias;
};

/**
 * Represents all columns from a table for SELECT * operations.
 *
 * @typeParam TTable - The table name
 * @typeParam TColumns - Record mapping column names to their TypeScript types
 *
 * @description
 * Used when accessing the wildcard property `table['*']`.
 * When used in a query, selects all columns from the table.
 *
 * @example
 * ```typescript
 * orm.from(users).select(users['*']).all()
 * // SQL: SELECT * FROM users
 * // Result type: User[]
 * ```
 */
export interface AllColumns<
	TTable extends string,
	TColumns extends Record<string, unknown>,
> {
	/** @internal Type brand for runtime identification */
	readonly [BRAND]: 'AllColumns';

	/** @internal Table name metadata */
	readonly [TABLE_META]: TTable;

	/**
	 * Phantom type containing all column types.
	 * @internal Used for result type inference.
	 */
	readonly _columns: TColumns;
}

/**
 * Base interface for RelationRef metadata (using Symbols).
 * @internal
 */
interface RelationRefBase<
	TTarget extends string,
	TTargetType,
	TRelationType extends RelationType,
> {
	/** @internal Relation metadata containing target and type */
	readonly [RELATION_META]: { target: TTarget; type: TRelationType };

	/** @internal Type brand for runtime identification */
	readonly [BRAND]: 'RelationRef';

	/**
	 * Phantom type for the related records.
	 * @internal Used for result type inference with include().
	 */
	readonly _type: TTargetType;
}

/**
 * Reference to a relation (FK-based join path).
 *
 * @typeParam TTarget - The target table name (e.g., 'posts')
 * @typeParam TTargetType - The TypeScript type of related records (e.g., Post[])
 * @typeParam TRelationType - The relation type: 'belongsTo' | 'hasMany' | 'hasOne'
 * @typeParam TTargetColumns - Record mapping target column names to their types
 *
 * @description
 * RelationRef enables cross-table queries by allowing access to columns
 * from related tables. It also supports the wildcard `'*'` for selecting
 * all columns from the related table.
 *
 * @example
 * ```typescript
 * // users.posts is RelationRef<'posts', Post[], 'hasMany'>
 *
 * // Access related table's columns
 * users.posts.title   // ColumnRef<'posts', 'title', string>
 * users.posts['*']    // AllColumns<'posts', {...}>
 *
 * // Use in cross-table queries
 * orm.from(users).where(eq(users.posts.published, true))
 * // Generates EXISTS subquery
 * ```
 */
export type RelationRef<
	TTarget extends string,
	TTargetType,
	TRelationType extends RelationType,
	TTargetColumns extends Record<string, unknown> = Record<string, unknown>,
> = RelationRefBase<TTarget, TTargetType, TRelationType> & {
	/**
	 * Access columns through relation (for cross-table queries).
	 */
	readonly [K in keyof TTargetColumns]: ColumnRef<
		TTarget,
		K & string,
		TTargetColumns[K]
	>;
} & {
	/**
	 * Wildcard for selecting all columns from the related table.
	 *
	 * @example
	 * ```typescript
	 * users.posts['*']  // AllColumns<'posts', {...}>
	 * ```
	 */
	readonly '*': AllColumns<TTarget, TTargetColumns>;
};

/**
 * Base interface for TableRef metadata (using Symbols).
 * @internal
 */
interface TableRefBase<TName extends string> {
	/** @internal Table name metadata (via Symbol) */
	readonly [TABLE_META]: TName;

	/** @internal Type brand for runtime identification */
	readonly [BRAND]: 'TableRef';
}

/**
 * Reference to a table in the schema.
 *
 * @typeParam TName - The table name as a string literal type (e.g., 'users')
 * @typeParam TColumns - Record mapping column names to ColumnRef types
 * @typeParam TRelations - Record mapping relation names to RelationRef types
 *
 * @description
 * TableRef is the primary type for type-safe queries. It provides:
 * - Access to all columns as ColumnRef properties
 * - Access to all relations as RelationRef properties
 * - A `'*'` wildcard for SELECT * operations
 * - Internal metadata via Symbols (no collision with user columns)
 *
 * TableRef objects are created by the schema builder and accessed via
 * `schema.tables.tableName`.
 *
 * @example
 * ```typescript
 * const { users, posts } = schema.tables;
 *
 * // Access columns
 * users.id        // ColumnRef<'users', 'id', number>
 * users.name      // ColumnRef<'users', 'name', string>
 *
 * // Access relations
 * users.posts     // RelationRef<'posts', Post[], 'hasMany'>
 *
 * // Wildcard
 * users['*']      // AllColumns<'users', {...}>
 *
 * // Internal metadata (rarely needed)
 * users[TABLE_META]  // 'users'
 * ```
 */
export type TableRef<
	TName extends string,
	TColumns extends Record<string, ColumnRef<TName, string, unknown>>,
	TRelations extends Record<
		string,
		RelationRef<string, unknown, RelationType>
	> = Record<never, never>,
> = TableRefBase<TName> & {
	/**
	 * All columns as ColumnRef properties.
	 */
	readonly [K in keyof TColumns]: TColumns[K];
} & {
	/**
	 * All relations as RelationRef properties (excluding column name conflicts).
	 */
	readonly [K in keyof TRelations as K extends keyof TColumns
		? never
		: K]: TRelations[K];
} & {
	/**
	 * Wildcard for SELECT * operations.
	 * The `'*'` character is never a valid SQL identifier, preventing collisions.
	 *
	 * @example
	 * ```typescript
	 * orm.from(users).select(users['*']).all()
	 * // SQL: SELECT * FROM users
	 * ```
	 */
	readonly '*': AllColumns<TName, InferColumnTypes<TColumns>>;
};

/**
 * Helper type to extract column types from a TColumns record.
 *
 * @typeParam TColumns - Record of column names to ColumnRef types
 * @returns Record mapping column names to their TypeScript types
 *
 * @internal
 */
export type InferColumnTypes<
	TColumns extends Record<string, ColumnRef<string, string, unknown>>,
> = {
	[K in keyof TColumns]: TColumns[K] extends ColumnRef<string, string, infer T>
		? T
		: never;
};

/**
 * Helper type to infer the row type from a TableRef.
 *
 * @typeParam T - A TableRef type
 * @returns The TypeScript type representing a single row from the table
 *
 * @example
 * ```typescript
 * type UserRow = InferTableRow<typeof users>;
 * // { id: number; name: string; email: string }
 * ```
 */
export type InferTableRow<T> =
	T extends TableRef<string, infer TColumns, infer _TRelations>
		? InferColumnTypes<TColumns>
		: never;

/**
 * Type guard to check if a value is a TableRef.
 *
 * @param value - The value to check
 * @returns True if the value is a TableRef
 *
 * @example
 * ```typescript
 * if (isTableRef(value)) {
 *   const tableName = value[TABLE_META];
 * }
 * ```
 */
export function isTableRef(
	value: unknown,
): value is TableRef<
	string,
	Record<string, ColumnRef<string, string, unknown>>
> {
	return (
		typeof value === 'object' &&
		value !== null &&
		BRAND in value &&
		(value as Record<symbol, unknown>)[BRAND] === 'TableRef'
	);
}

/**
 * Type guard to check if a value is a ColumnRef.
 *
 * @param value - The value to check
 * @returns True if the value is a ColumnRef
 *
 * @example
 * ```typescript
 * if (isColumnRef(value)) {
 *   const columnName = value[COLUMN_META];
 * }
 * ```
 */
export function isColumnRef(
	value: unknown,
): value is ColumnRef<string, string, unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		BRAND in value &&
		(value as Record<symbol, unknown>)[BRAND] === 'ColumnRef'
	);
}

/**
 * Type guard to check if a value is a RelationRef.
 *
 * @param value - The value to check
 * @returns True if the value is a RelationRef
 *
 * @example
 * ```typescript
 * if (isRelationRef(value)) {
 *   const relInfo = value[RELATION_META];
 * }
 * ```
 */
export function isRelationRef(
	value: unknown,
): value is RelationRef<string, unknown, RelationType> {
	return (
		typeof value === 'object' &&
		value !== null &&
		BRAND in value &&
		(value as Record<symbol, unknown>)[BRAND] === 'RelationRef'
	);
}

/**
 * Type guard to check if a value is an AllColumns.
 *
 * @param value - The value to check
 * @returns True if the value is an AllColumns
 *
 * @example
 * ```typescript
 * if (isAllColumns(value)) {
 *   const tableName = value[TABLE_META];
 * }
 * ```
 */
export function isAllColumns(
	value: unknown,
): value is AllColumns<string, Record<string, unknown>> {
	return (
		typeof value === 'object' &&
		value !== null &&
		BRAND in value &&
		(value as Record<symbol, unknown>)[BRAND] === 'AllColumns'
	);
}

/**
 * Type guard to check if a value is an AliasedColumn.
 *
 * @param value - The value to check
 * @returns True if the value is an AliasedColumn
 */
export function isAliasedColumn(
	value: unknown,
): value is AliasedColumn<string, string, unknown, string> {
	return isColumnRef(value) && '_alias' in value;
}
