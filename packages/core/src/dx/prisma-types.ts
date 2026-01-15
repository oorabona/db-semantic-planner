/**
 * DX-110: Prisma-like Type Inference
 *
 * This module provides advanced type inference for query results,
 * including conditional types based on include() calls.
 *
 * Key types:
 * - TypedSchema: Schema with relations defined per-table
 * - InferColumns: Extract column types from a table
 * - InferRelationNames: Extract available relation names for a table
 * - InferIncludeResult: Compute result type based on includes
 */

import type {
	GeneratedColumn,
	GeneratedColumnType,
	GeneratedTable,
} from './schema-bridge.js';

// ============================================================================
// Schema with Per-Table Relations
// ============================================================================

/**
 * Relation kind for type discrimination.
 */
export type RelationKind = 'hasOne' | 'hasMany' | 'belongsTo' | 'belongsToMany';

/**
 * Base relation definition with target table.
 */
export interface RelationDef<
	Kind extends RelationKind = RelationKind,
	Target extends string = string,
> {
	readonly kind: Kind;
	readonly target: Target;
	readonly foreignKey?: string;
	readonly through?: string;
	readonly otherKey?: string;
}

/**
 * HasOne relation: source has exactly one target.
 */
export interface HasOneDef<Target extends string = string>
	extends RelationDef<'hasOne', Target> {
	readonly kind: 'hasOne';
}

/**
 * HasMany relation: source has multiple targets.
 */
export interface HasManyDef<Target extends string = string>
	extends RelationDef<'hasMany', Target> {
	readonly kind: 'hasMany';
}

/**
 * BelongsTo relation: source belongs to a single target.
 */
export interface BelongsToDef<Target extends string = string>
	extends RelationDef<'belongsTo', Target> {
	readonly kind: 'belongsTo';
}

/**
 * BelongsToMany relation: many-to-many via junction table.
 */
export interface BelongsToManyDef<Target extends string = string>
	extends RelationDef<'belongsToMany', Target> {
	readonly kind: 'belongsToMany';
	readonly through: string;
}

/**
 * Union of all relation definitions.
 */
export type AnyRelationDef = HasOneDef | HasManyDef | BelongsToDef | BelongsToManyDef;

/**
 * Table definition with columns and relations.
 */
export interface TypedTableDef<
	TColumns extends Record<string, GeneratedColumn> = Record<string, GeneratedColumn>,
	TRelations extends Record<string, AnyRelationDef> = Record<string, AnyRelationDef>,
> {
	readonly columns: TColumns;
	readonly relations?: TRelations;
}

/**
 * Schema with typed tables including relations.
 *
 * @example
 * ```typescript
 * const schema = {
 *   tables: {
 *     users: {
 *       columns: { id: { type: 'uuid' }, name: { type: 'string' } },
 *       relations: { posts: { kind: 'hasMany', target: 'posts', foreignKey: 'authorId' } }
 *     },
 *     posts: {
 *       columns: { id: { type: 'uuid' }, title: { type: 'string' }, authorId: { type: 'uuid' } },
 *       relations: { author: { kind: 'belongsTo', target: 'users', foreignKey: 'authorId' } }
 *     }
 *   }
 * } as const satisfies TypedSchema;
 * ```
 */
export interface TypedSchema<
	TTables extends Record<string, TypedTableDef> = Record<string, TypedTableDef>,
> {
	readonly tables: TTables;
}

// ============================================================================
// Relation Helper Functions
// ============================================================================

/**
 * Define a hasOne relation.
 */
export function hasOne<Target extends string>(
	target: Target,
	options: { foreignKey: string },
): HasOneDef<Target> {
	return {
		kind: 'hasOne',
		target,
		foreignKey: options.foreignKey,
	};
}

/**
 * Define a hasMany relation.
 */
export function hasMany<Target extends string>(
	target: Target,
	options: { foreignKey: string },
): HasManyDef<Target> {
	return {
		kind: 'hasMany',
		target,
		foreignKey: options.foreignKey,
	};
}

/**
 * Define a belongsTo relation.
 */
export function belongsTo<Target extends string>(
	target: Target,
	options: { foreignKey: string },
): BelongsToDef<Target> {
	return {
		kind: 'belongsTo',
		target,
		foreignKey: options.foreignKey,
	};
}

/**
 * Define a belongsToMany relation.
 */
export function belongsToMany<Target extends string>(
	target: Target,
	options: { through: string; foreignKey?: string; otherKey?: string },
): BelongsToManyDef<Target> {
	return {
		kind: 'belongsToMany',
		target,
		through: options.through,
		...(options.foreignKey !== undefined && { foreignKey: options.foreignKey }),
		...(options.otherKey !== undefined && { otherKey: options.otherKey }),
	};
}

// ============================================================================
// Type Inference Utilities
// ============================================================================

/**
 * Map GeneratedColumnType to TypeScript type.
 */
export type ColumnTypeToTS<T extends GeneratedColumnType> = T extends
	| 'string'
	| 'text'
	| 'uuid'
	? string
	: T extends 'number' | 'integer' | 'decimal'
		? number
		: T extends 'bigint'
			? bigint
			: T extends 'boolean'
				? boolean
				: T extends 'date' | 'timestamp' | 'datetime'
					? Date
					: T extends 'json'
						? unknown
						: never;

/**
 * Infer TypeScript type for a single column.
 */
export type InferColumnType<C extends GeneratedColumn> = C['nullable'] extends true
	? ColumnTypeToTS<C['type']> | null
	: ColumnTypeToTS<C['type']>;

/**
 * Infer TypeScript row type from a table's columns.
 *
 * @example
 * ```typescript
 * type UserRow = InferColumns<typeof schema.tables.users.columns>;
 * // { id: string; name: string; email: string | null }
 * ```
 */
export type InferColumns<TColumns extends Record<string, GeneratedColumn>> = {
	[K in keyof TColumns]: InferColumnType<TColumns[K]>;
};

/**
 * Extract relation names from a typed table definition.
 *
 * @example
 * ```typescript
 * type UserRelations = InferRelationNames<typeof schema.tables.users>;
 * // 'posts' | 'profile'
 * ```
 */
export type InferRelationNames<T extends TypedTableDef> = T['relations'] extends Record<
	string,
	AnyRelationDef
>
	? keyof T['relations'] & string
	: never;

/**
 * Extract the target table name from a relation.
 */
export type RelationTarget<R extends AnyRelationDef> = R['target'];

/**
 * Determine if a relation is "to-many" (returns array).
 */
export type IsToManyRelation<R extends AnyRelationDef> = R['kind'] extends
	| 'hasMany'
	| 'belongsToMany'
	? true
	: false;

/**
 * Infer the base row type for a target table in a schema.
 */
export type InferTargetRowType<
	S extends TypedSchema,
	Target extends keyof S['tables'] & string,
> = S['tables'][Target] extends TypedTableDef<infer TColumns>
	? InferColumns<TColumns>
	: never;

/**
 * Infer the type of a single relation's result.
 * - hasOne/belongsTo → single object (or null for optional)
 * - hasMany/belongsToMany → array
 */
export type InferRelationType<
	S extends TypedSchema,
	T extends keyof S['tables'] & string,
	R extends InferRelationNames<S['tables'][T]>,
> = S['tables'][T]['relations'] extends Record<string, AnyRelationDef>
	? R extends keyof S['tables'][T]['relations']
		? S['tables'][T]['relations'][R] extends infer Rel
			? Rel extends AnyRelationDef
				? Rel['target'] extends keyof S['tables'] & string
					? IsToManyRelation<Rel> extends true
						? InferTargetRowType<S, Rel['target']>[]
						: InferTargetRowType<S, Rel['target']> | null
					: never
				: never
			: never
		: never
	: never;

// ============================================================================
// Include Types (Prisma-like conditional inference)
// ============================================================================

/**
 * Include specification: can be a boolean, or nested include object.
 */
export type IncludeSpec<S extends TypedSchema, T extends keyof S['tables'] & string> = {
	[R in InferRelationNames<S['tables'][T]>]?:
		| boolean
		| (S['tables'][T]['relations'] extends Record<string, AnyRelationDef>
				? S['tables'][T]['relations'][R] extends AnyRelationDef
					? S['tables'][T]['relations'][R]['target'] extends keyof S['tables'] & string
						? NestedIncludeSpec<S, S['tables'][T]['relations'][R]['target']>
						: never
					: never
				: never);
};

/**
 * Nested include specification with recursive includes.
 */
export interface NestedIncludeSpec<
	S extends TypedSchema,
	T extends keyof S['tables'] & string,
> {
	include?: IncludeSpec<S, T>;
}

/**
 * Resolve the type of included relations.
 * This is the core of Prisma-like type inference.
 */
export type ResolveIncludedRelations<
	S extends TypedSchema,
	T extends keyof S['tables'] & string,
	I extends IncludeSpec<S, T>,
> = {
	[R in keyof I & InferRelationNames<S['tables'][T]>]: I[R] extends true
		? InferRelationType<S, T, R>
		: I[R] extends NestedIncludeSpec<S, infer Target>
			? Target extends keyof S['tables'] & string
				? S['tables'][T]['relations'] extends Record<string, AnyRelationDef>
					? R extends keyof S['tables'][T]['relations']
						? S['tables'][T]['relations'][R] extends AnyRelationDef
							? IsToManyRelation<S['tables'][T]['relations'][R]> extends true
								? I[R] extends { include: infer NestedI }
									? NestedI extends IncludeSpec<S, Target>
										? Array<
												InferTargetRowType<S, Target> &
													ResolveIncludedRelations<S, Target, NestedI>
											>
										: InferTargetRowType<S, Target>[]
									: InferTargetRowType<S, Target>[]
								: I[R] extends { include: infer NestedI }
									? NestedI extends IncludeSpec<S, Target>
										? | (InferTargetRowType<S, Target> &
													ResolveIncludedRelations<S, Target, NestedI>)
											| null
										: InferTargetRowType<S, Target> | null
									: InferTargetRowType<S, Target> | null
							: never
						: never
					: never
				: never
			: never;
};

/**
 * Final query result type: base columns + included relations.
 *
 * @example
 * ```typescript
 * type Result = InferQueryResult<
 *   typeof schema,
 *   'users',
 *   { posts: true, profile: { include: { settings: true } } }
 * >;
 * // { id: string; name: string; posts: Post[]; profile: (Profile & { settings: Settings | null }) | null }
 * ```
 */
export type InferQueryResult<
	S extends TypedSchema,
	T extends keyof S['tables'] & string,
	// Relaxed constraint - I is inferred from query builder state
	I = undefined,
> = S['tables'][T] extends TypedTableDef<infer TColumns>
	? I extends IncludeSpec<S, T>
		? InferColumns<TColumns> & ResolveIncludedRelations<S, T, I>
		: InferColumns<TColumns>
	: never;

// ============================================================================
// Table Names Type Helper
// ============================================================================

/**
 * Extract all table names from a schema.
 */
export type TableNames<S extends TypedSchema> = keyof S['tables'] & string;

/**
 * Extract all column names from a table.
 */
export type ColumnNames<
	S extends TypedSchema,
	T extends TableNames<S>,
> = S['tables'][T] extends TypedTableDef<infer TColumns> ? keyof TColumns & string : never;
