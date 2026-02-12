/**
 * @fileoverview Type utilities for inferring TableRef types from schema definitions.
 *
 * This module provides the type-level infrastructure for DX-040's type-safe query API.
 * It infers ColumnRef, RelationRef, and TableRef types from schema definitions.
 *
 * @module schema-tables-types
 * @since DX-040
 */

import type { ColumnRef, RelationRef, TableRef } from './table-ref.js';

// ============================================================================
// Import schema types (we'll use type-only imports to avoid circular deps)
// ============================================================================

/**
 * Supported column types in schema definitions.
 * Matches SchemaColumnType from schema.ts.
 */
type SchemaColumnType =
	| 'string'
	| 'text'
	| 'uuid'
	| 'number'
	| 'integer'
	| 'decimal'
	| 'bigint'
	| 'boolean'
	| 'date'
	| 'time'
	| 'datetime'
	| 'timestamp'
	| 'json'
	| 'jsonb'
	| 'daterange'
	| 'tsrange'
	| 'tstzrange'
	| 'int4range'
	| 'int8range'
	| 'numrange';

/**
 * Column definition - short form or long form.
 */
type ColumnDef =
	| SchemaColumnType
	| {
			type: SchemaColumnType;
			nullable?: boolean;
			unique?: boolean;
			primaryKey?: boolean;
			autoIncrement?: boolean;
			default?: unknown;
			index?: boolean;
	  };

/**
 * Ref definition marker.
 * Generic over target and options to preserve literal types for inference.
 */
interface RefDefinition<
	TTarget extends string = string,
	TOptions extends RefOptionsShape = RefOptionsShape,
> {
	readonly __brand: 'ref';
	readonly target: TTarget;
	readonly options: TOptions;
}

/** Shape of ref options (structural, avoids importing RefOptions). */
interface RefOptionsShape {
	as?: string;
	inverse?: string;
	nullable?: boolean;
	unique?: boolean;
	onDelete?: string;
	onUpdate?: string;
	roles?: unknown;
}

/**
 * Table definition - columns and refs.
 */
type TableDef = Record<string, ColumnDef | RefDefinition>;

/**
 * Schema definition - tables.
 */
type SchemaDefinition = Record<string, TableDef>;

// ============================================================================
// Type utilities
// ============================================================================

/**
 * Check if a definition is a RefDefinition.
 */
type IsRef<T> = T extends { __brand: 'ref' } ? true : false;

/**
 * Extract the column type from a ColumnDef.
 */
type ExtractColumnType<C> = C extends SchemaColumnType
	? C
	: C extends { type: infer T extends SchemaColumnType }
		? T
		: never;

/**
 * Check if a column is nullable.
 */
type IsNullable<C> = C extends { nullable: true } ? true : false;

/**
 * Map schema column types to TypeScript types.
 */
type MapColumnTypeToTS<T extends SchemaColumnType> =
	// String types
	T extends 'string' | 'text' | 'uuid'
		? string
		: // Numeric types
			T extends 'number' | 'integer' | 'decimal'
			? number
			: // BigInt
				T extends 'bigint'
				? bigint
				: // Boolean
					T extends 'boolean'
					? boolean
					: // Date/time types
						T extends 'date' | 'time' | 'datetime' | 'timestamp'
						? Date
						: // JSON types
							T extends 'json' | 'jsonb'
							? unknown
							: // Range types
								T extends
										| 'daterange'
										| 'tsrange'
										| 'tstzrange'
										| 'int4range'
										| 'int8range'
										| 'numrange'
								? unknown
								: // Fallback
									unknown;

/**
 * Infer the TypeScript type for a column definition.
 */
type InferColumnTSType<C> =
	IsRef<C> extends true
		? never
		: C extends ColumnDef
			? IsNullable<C> extends true
				? MapColumnTypeToTS<ExtractColumnType<C>> | null
				: MapColumnTypeToTS<ExtractColumnType<C>>
			: never;

/**
 * Extract only column definitions (not refs) from a TableDef.
 */
type ExtractColumns<T extends TableDef> = {
	[K in keyof T as IsRef<T[K]> extends true ? never : K]: T[K];
};

/**
 * Extract only ref definitions from a TableDef.
 */
type ExtractRefs<T extends TableDef> = {
	[K in keyof T as IsRef<T[K]> extends true ? K : never]: T[K];
};

/**
 * Build ColumnRef types for all columns in a table.
 */
type BuildColumnRefs<TName extends string, TTable extends TableDef> = {
	[K in keyof ExtractColumns<TTable> as K extends string
		? K
		: never]: K extends string
		? ColumnRef<TName, K, InferColumnTSType<TTable[K]>>
		: never;
};

/**
 * Get the relation name for a ref (uses 'as' option or defaults to column name without 'Id' suffix).
 */
type GetRelationName<
	TColName extends string,
	TRef extends RefDefinition,
> = TRef['options'] extends { as: infer A extends string }
	? A
	: TColName extends `${infer Base}Id`
		? Base
		: TColName;

/**
 * Get the target table name from a ref.
 */
type GetRefTarget<TRef> = TRef extends { target: infer T extends string }
	? T
	: never;

/**
 * Infer the row type for a table (used for relation target types).
 */
type InferRowType<TTable extends TableDef> = {
	[K in keyof ExtractColumns<TTable> as K extends string
		? K
		: never]: InferColumnTSType<TTable[K]>;
};

/**
 * Build RelationRef for a local relation (belongsTo - FK in this table).
 */
type BuildLocalRelation<
	_TColName extends string,
	TRef extends RefDefinition,
	TSchema extends SchemaDefinition,
> = GetRefTarget<TRef> extends keyof TSchema
	? RelationRef<
			GetRefTarget<TRef> & string,
			InferRowType<TSchema[GetRefTarget<TRef>]> | null,
			'belongsTo',
			InferRowType<TSchema[GetRefTarget<TRef>]>
		>
	: never;

/**
 * Build local relations (belongsTo) for a table.
 */
type BuildLocalRelations<
	_TName extends string,
	TTable extends TableDef,
	TSchema extends SchemaDefinition,
> = {
	[K in keyof ExtractRefs<TTable> as K extends string
		? GetRelationName<K, TTable[K] & RefDefinition>
		: never]: K extends string
		? BuildLocalRelation<K, TTable[K] & RefDefinition, TSchema>
		: never;
};

/**
 * Find inverse relations (hasMany/hasOne) from other tables pointing to this table.
 */
type FindInverseRelations<
	TName extends string,
	TSchema extends SchemaDefinition,
> = {
	[TTable in keyof TSchema as TTable extends string
		? {
				[K in keyof TSchema[TTable]]: TSchema[TTable][K] extends RefDefinition
					? GetRefTarget<TSchema[TTable][K]> extends TName
						? TSchema[TTable][K] extends {
								options: { inverse: infer I extends string };
							}
							? I
							: TTable extends `${string}s`
								? TTable
								: `${TTable & string}s`
						: never
					: never;
			}[keyof TSchema[TTable]]
		: never]: TTable extends string
		? RelationRef<
				TTable,
				Array<InferRowType<TSchema[TTable]>>,
				'hasMany',
				InferRowType<TSchema[TTable]>
			>
		: never;
};

/**
 * Combine local and inverse relations for a table.
 */
type BuildAllRelations<
	TName extends string,
	TTable extends TableDef,
	TSchema extends SchemaDefinition,
> = BuildLocalRelations<TName, TTable, TSchema> &
	FindInverseRelations<TName, TSchema>;

/**
 * Build a complete TableRef for a table in the schema.
 */
type BuildTableRef<
	TName extends string,
	TTable extends TableDef,
	TSchema extends SchemaDefinition,
> = TableRef<
	TName,
	BuildColumnRefs<TName, TTable>,
	BuildAllRelations<TName, TTable, TSchema>
>;

/**
 * Infer the tables property type from a schema definition.
 *
 * @typeParam TSchema - The schema definition type
 * @returns A record mapping table names to their TableRef types
 *
 * @example
 * ```typescript
 * const s = schema({
 *   users: { id: 'uuid', name: 'text' },
 *   posts: { id: 'uuid', authorId: ref('users'), title: 'text' },
 * });
 *
 * // s.tables.users is TableRef<'users', { id: ColumnRef<...>, name: ColumnRef<...> }, { posts: RelationRef<...> }>
 * // s.tables.users.id is ColumnRef<'users', 'id', string>
 * // s.tables.users.posts is RelationRef<'posts', Post[], 'hasMany'>
 * ```
 */
export type InferTables<TSchema extends SchemaDefinition> = {
	[TName in keyof TSchema as TName extends string
		? TName
		: never]: TName extends string
		? BuildTableRef<TName, TSchema[TName], TSchema>
		: never;
};

