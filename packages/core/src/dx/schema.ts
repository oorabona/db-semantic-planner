/**
 * ARCH-005: Unified Schema API
 *
 * Replaces defineSchema(), TypedSchema, and GeneratedSchema with a single
 * schema() + ref() API. Relations are auto-inferred from FK declarations.
 *
 * @example
 * ```typescript
 * import { schema, ref } from '@dbsp/core';
 *
 * const db = schema({
 *   users: { id: 'uuid', email: { type: 'text', unique: true } },
 *   posts: { id: 'uuid', authorId: ref('users') },
 * });
 * ```
 */

import type { DbCasing } from '../adapter.js';
import { ModelIRImpl } from '../model-impl.js';
import type {
	ColumnIR,
	ColumnType,
	ForeignKeyIR,
	IndexIR,
	ModelIR,
	OnDeleteAction,
	PseudoColumnMetadata,
	RelationIR,
	RelationType,
	TableIR,
} from '../model-ir.js';
import { createPseudoColumnMetadata } from '../model-ir.js';
import type { InferTables } from './schema-tables-types.js';
import { createTablesProxy } from './table-ref-factory.js';

// ============================================================================
// Public Types
// ============================================================================

/**
 * Supported column types in schema definitions.
 * Maps to ColumnType from ModelIR.
 */
export type SchemaColumnType = ColumnType;

/**
 * Column definition - short form (just type) or long form (with options).
 */
export type ColumnDef =
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
 * Self-referential relation role names.
 * Required when declaring a ref() to the same table.
 */
export interface SelfRefRoles {
	/** Name for the direct parent relation (e.g., 'parent', 'manager') */
	parent: string;
	/** Name for the direct children relation (e.g., 'children', 'directReports') */
	children: string;
	/** Name for recursive ancestors (default: 'ancestors') */
	ancestors?: string;
	/** Name for recursive descendants (default: 'descendants') */
	descendants?: string;
}

/**
 * Options for ref() foreign key declarations.
 */
export interface RefOptions {
	// FK column constraints
	/** Is this FK nullable? → optional relation */
	nullable?: boolean;
	/** Is this FK unique? → 1:1 instead of 1:N */
	unique?: boolean;

	// FK behavior
	/** ON DELETE action */
	onDelete?: OnDeleteAction;
	/** ON UPDATE action */
	onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';

	// Relation naming
	/** Local relation name (e.g., 'createdBy' for createdById column) */
	as?: string;
	/** Inverse relation name on target table (e.g., 'writings' instead of 'author_posts') */
	inverse?: string;

	// Self-ref only (MANDATORY when source === target)
	/** Role names for self-referential relations */
	roles?: SelfRefRoles;

	// Composite FK support (table-level foreignKeys only)
	/** Source columns forming the composite FK */
	columns?: readonly string[];
	/** Target columns (defaults to target table's PK) */
	references?: readonly string[];
}

/**
 * Marker type for ref() declarations in schema.
 * Generic over target and options to preserve literal types for inference.
 * @internal
 */
export interface RefDefinition<
	TTarget extends string = string,
	TOptions extends RefOptions = RefOptions,
> {
	readonly __brand: 'ref';
	readonly target: TTarget;
	readonly options: TOptions;
}

/**
 * Table definition - a record of column names to column or ref definitions.
 */
export type TableDef = Record<string, ColumnDef | RefDefinition>;

/**
 * Schema definition - a record of table names to table definitions.
 */
export type SchemaDefinition = Record<string, TableDef>;

/**
 * Table-level constraints for composite indexes and foreign keys.
 * Used as the 2nd argument to schema() for constraints that span multiple columns.
 *
 * @example
 * ```typescript
 * schema({
 *   orderItems: {
 *     orderId: 'uuid',
 *     productId: 'uuid',
 *     quantity: 'integer',
 *   },
 * }, {
 *   orderItems: {
 *     indexes: [
 *       { columns: ['orderId', 'productId'], unique: true },
 *     ],
 *     foreignKeys: [
 *       ref('orders', { columns: ['orderId', 'productId'], references: ['orderId', 'productId'] }),
 *     ],
 *   },
 * });
 * ```
 */
export interface SchemaTableOptions {
	/** Composite indexes for this table */
	indexes?: Array<{
		columns: string[];
		unique?: boolean;
		name?: string;
	}>;
	/** Composite foreign keys for this table (use ref() with columns/references) */
	foreignKeys?: RefDefinition[];
}

/**
 * Per-table constraint options, keyed by table name.
 */
export type SchemaConstraints = Record<string, SchemaTableOptions>;

/**
 * Result of schema() function with strongly-typed table/column info.
 */
export interface Schema<T extends SchemaDefinition> {
	/** The raw schema definition */
	readonly definition: T;
	/** Converted ModelIR for use with ORM */
	readonly model: ModelIR;
	/** Table names */
	readonly tableNames: (keyof T)[];
	/**
	 * Type-safe table references for query building.
	 *
	 * Provides typed access to tables, columns, and relations:
	 * - `schema.tables.users` returns a TableRef with typed columns
	 * - `schema.tables.users.id` returns a ColumnRef
	 * - `schema.tables.users.posts` returns a RelationRef (if relation exists)
	 * - `schema.tables.users['*']` returns AllColumns for SELECT *
	 *
	 * @example
	 * ```typescript
	 * const { users, posts } = schema.tables;
	 *
	 * // Type-safe column access
	 * users.id        // ColumnRef<'users', 'id', string>
	 * users.name      // ColumnRef<'users', 'name', string>
	 *
	 * // Type-safe relation access
	 * users.posts     // RelationRef<'posts', Post[], 'hasMany'>
	 *
	 * // Wildcard for SELECT *
	 * users['*']      // AllColumns<'users', {...}>
	 * ```
	 *
	 * @since DX-040
	 */
	readonly tables: InferTables<T>;
	/**
	 * DB column casing — describes what casing the database uses.
	 * @see DbCasing
	 */
	readonly dbCasing?: DbCasing;
	/**
	 * Timestamp when this schema was introspected from the database.
	 * Only present for schemas created via getSchemaFromDb().
	 * Useful for detecting schema drift.
	 */
	readonly introspectedAt?: Date;
}

// ============================================================================
// Type Inference Helpers
// ============================================================================

/**
 * JSON-compatible value type for json/jsonb columns.
 */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

/**
 * Range value type for PostgreSQL range types.
 */
export interface InferredRangeValue<T> {
	readonly start: T | null;
	readonly end: T | null;
	readonly startInclusive?: boolean;
	readonly endInclusive?: boolean;
}

/**
 * Maps a ColumnType string to its TypeScript type.
 */
export type InferColumnType<T extends SchemaColumnType> =
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
							? JsonValue
							: // PostgreSQL range types
								T extends 'daterange'
								? InferredRangeValue<Date>
								: T extends 'tsrange' | 'tstzrange'
									? InferredRangeValue<Date>
									: T extends 'int4range' | 'int8range'
										? InferredRangeValue<number>
										: T extends 'numrange'
											? InferredRangeValue<number>
											: // Fallback
												unknown;

/**
 * Extracts the type string from a ColumnDef (handles short and long forms).
 */
type ExtractColumnType<C extends ColumnDef> = C extends SchemaColumnType
	? C
	: C extends { type: infer T extends SchemaColumnType }
		? T
		: never;

/**
 * Checks if a ColumnDef is nullable.
 */
type IsNullable<C extends ColumnDef> = C extends { nullable: true }
	? true
	: false;

/**
 * Infers the TypeScript type for a single column definition.
 * Handles both short form ('string') and long form ({ type: 'string', nullable: true }).
 */
export type InferColumn<C extends ColumnDef> =
	IsNullable<C> extends true
		? InferColumnType<ExtractColumnType<C>> | null
		: InferColumnType<ExtractColumnType<C>>;

/**
 * Infers the FK column type from a RefDefinition.
 *
 * ⚠️ **Limitation:** FK columns are typed as `number | string` because inferring
 * the target PK type at compile time would require resolving cross-table references,
 * which creates circular type dependencies in TypeScript.
 *
 * **Why not infer from target table?**
 * Given `ref('users')`, we'd need to:
 * 1. Find `users` table in the schema
 * 2. Find column with `primaryKey: true`
 * 3. Get its type
 *
 * This creates circular refs when tables reference each other (A→B→A).
 *
 * **Pragmatic trade-off:** `number | string` covers 99% of PKs (auto-increment int or UUID).
 *
 * @example
 * authorId: ref('users')                        // Type: number | string
 * editorId: ref('users', { nullable: true })    // Type: number | string | null
 */
export type InferRefColumn<R extends RefDefinition> = R extends {
	options: { nullable: true };
}
	? number | string | null
	: number | string;

/**
 * Infers the row type for a single table definition.
 * Maps each column to its TypeScript type.
 */
export type InferRow<T extends TableDef> = {
	[K in keyof T]: T[K] extends RefDefinition
		? InferRefColumn<T[K]>
		: T[K] extends ColumnDef
			? InferColumn<T[K]>
			: unknown;
};

/**
 * Infers the complete database type from a schema definition.
 * Maps each table name to its row type.
 *
 * @example
 * ```typescript
 * const mySchema = schema({
 *   users: { id: 'integer', email: 'string', bio: { type: 'text', nullable: true } },
 *   posts: { id: 'integer', title: 'string', authorId: ref('users') },
 * });
 *
 * type DB = InferDB<typeof mySchema.definition>;
 * // DB = {
 * //   users: { id: number; email: string; bio: string | null };
 * //   posts: { id: number; title: string; authorId: number | string };
 * // }
 * ```
 */
export type InferDB<S extends SchemaDefinition> = {
	[TableName in keyof S]: InferRow<S[TableName]>;
};

/**
 * Helper type to extract the inferred DB type from a Schema instance.
 */
export type InferSchemaDB<S extends Schema<SchemaDefinition>> =
	S extends Schema<infer T> ? InferDB<T> : never;

// ============================================================================
// Public API
// ============================================================================

/**
 * Declares a foreign key reference to another table.
 *
 * @param target - Target table name (must exist in schema)
 * @param options - Optional FK constraints and relation naming
 * @returns RefDefinition for use in table definitions
 *
 * @example
 * ```typescript
 * // Simple FK (1:N)
 * authorId: ref('users')
 *
 * // Optional FK
 * editorId: ref('users', { nullable: true })
 *
 * // 1:1 relation (unique FK)
 * userId: ref('users', { unique: true })
 *
 * // Custom naming
 * createdById: ref('users', { as: 'createdBy', inverse: 'createdDocuments' })
 *
 * // Self-ref (requires roles)
 * parentId: ref('categories', { roles: { parent: 'parent', children: 'children' } })
 * ```
 */
export function ref<
	TTarget extends string,
	TOptions extends RefOptions = Record<string, never>,
>(target: TTarget, options?: TOptions): RefDefinition<TTarget, TOptions> {
	return {
		__brand: 'ref',
		target,
		options: (options ?? {}) as TOptions,
	};
}

/**
 * Type guard for RefDefinition.
 */
export function isRef(
	value: ColumnDef | RefDefinition,
): value is RefDefinition {
	return (
		typeof value === 'object' &&
		value !== null &&
		'__brand' in value &&
		value.__brand === 'ref'
	);
}

/**
 * Creates a type-safe schema definition and converts it to ModelIR.
 *
 * @param definition - Schema definition with tables and columns
 * @returns Schema object with definition, model, and table names
 *
 * @example
 * ```typescript
 * const db = schema({
 *   users: {
 *     id: 'uuid',
 *     email: { type: 'text', unique: true },
 *   },
 *   posts: {
 *     id: 'uuid',
 *     title: 'text',
 *     authorId: ref('users'),
 *   },
 * });
 *
 * // Use with ORM
 * const orm = createOrm({ model: db.model, adapter });
 * ```
 */
export function schema<T extends SchemaDefinition>(
	definition: T,
	constraints?: SchemaConstraints,
): Schema<T> {
	// Validate and convert to ModelIR
	const model = schemaToModelIR(definition, constraints);
	const tableNames = Object.keys(definition) as (keyof T)[];

	// Create type-safe tables proxy (DX-040)
	const tables = createTablesProxy(
		model,
		tableNames as string[],
	) as InferTables<T>;

	return {
		definition,
		model,
		tableNames,
		tables,
	};
}

// ============================================================================
// Conversion to ModelIR
// ============================================================================

/**
 * Validation error during schema conversion.
 */
export class SchemaValidationError extends Error {
	constructor(
		message: string,
		public readonly table?: string,
		public readonly column?: string,
	) {
		super(message);
		this.name = 'SchemaValidationError';
	}
}

/**
 * Converts a schema definition to ModelIR.
 *
 * @internal
 */
export function schemaToModelIR(
	definition: SchemaDefinition,
	constraints?: SchemaConstraints,
): ModelIR {
	const tableNames = Object.keys(definition);

	// Phase 1: Validate refs point to existing tables
	validateRefs(definition, tableNames);

	// Phase 2: Collect all refs and validate constraints
	const refsByTable = collectRefs(definition);

	// Phase 3: Build tables (columns, PKs, FKs, indexes)
	const tables = buildTables(definition, refsByTable, tableNames, constraints);

	// Phase 4: Build relations from refs
	const relations = buildRelations(definition, refsByTable, tableNames);

	// Phase 5: Build ModelIR
	const tableMap = new Map<string, TableIR>();
	for (const table of tables) {
		tableMap.set(table.name, table);
	}

	const relationMap = new Map<string, RelationIR>();
	for (const relation of relations) {
		const qualifiedName = `${relation.source}.${relation.name}`;
		relationMap.set(qualifiedName, relation);
	}

	return new ModelIRImpl(tableMap, relationMap);
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validates that all refs point to existing tables.
 */
function validateRefs(
	definition: SchemaDefinition,
	tableNames: string[],
): void {
	const tableSet = new Set(tableNames);

	for (const [tableName, tableDef] of Object.entries(definition)) {
		for (const [columnName, columnDef] of Object.entries(tableDef)) {
			if (isRef(columnDef)) {
				// Check target exists
				if (!tableSet.has(columnDef.target)) {
					throw new SchemaValidationError(
						`Foreign key '${columnName}' references non-existent table '${columnDef.target}'`,
						tableName,
						columnName,
					);
				}

				// Self-ref requires roles
				if (columnDef.target === tableName && !columnDef.options.roles) {
					throw new SchemaValidationError(
						`Self-referential FK '${columnName}' must have 'roles' option with parent/children names`,
						tableName,
						columnName,
					);
				}

				// Roles only valid for self-ref
				if (columnDef.target !== tableName && columnDef.options.roles) {
					throw new SchemaValidationError(
						`'roles' option is only valid for self-referential FKs, but '${columnName}' references '${columnDef.target}'`,
						tableName,
						columnName,
					);
				}
			}
		}
	}
}

/**
 * Collected ref info for a table.
 */
interface CollectedRef {
	columnName: string;
	target: string;
	options: RefOptions;
	localRelation: string; // Derived relation name
	inverseRelation: string; // Derived inverse relation name
}

/**
 * Collects refs per table and validates multi-FK constraints.
 */
function collectRefs(
	definition: SchemaDefinition,
): Map<string, CollectedRef[]> {
	const refsByTable = new Map<string, CollectedRef[]>();

	for (const [tableName, tableDef] of Object.entries(definition)) {
		const refs: CollectedRef[] = [];
		const refsByTarget = new Map<string, string[]>(); // target -> column names

		for (const [columnName, columnDef] of Object.entries(tableDef)) {
			if (isRef(columnDef)) {
				// Track refs by target for multi-FK validation
				const existing = refsByTarget.get(columnDef.target) || [];
				existing.push(columnName);
				refsByTarget.set(columnDef.target, existing);

				// Derive relation names
				const localRelation = deriveLocalRelation(
					columnName,
					columnDef.options,
				);
				const inverseRelation = deriveInverseRelation(
					localRelation,
					tableName,
					columnDef.options,
					columnDef.target === tableName,
				);

				refs.push({
					columnName,
					target: columnDef.target,
					options: columnDef.options,
					localRelation,
					inverseRelation,
				});
			}
		}

		// Validate multi-FK to same table requires explicit naming
		for (const [target, columns] of refsByTarget) {
			if (columns.length > 1 && target !== tableName) {
				// Multiple FKs to same non-self table - all must have 'as'
				for (const columnName of columns) {
					const ref = refs.find((r) => r.columnName === columnName);
					if (ref && !ref.options.as) {
						throw new SchemaValidationError(
							`Multiple FKs to '${target}' require explicit 'as' naming. Column '${columnName}' has no 'as' option.`,
							tableName,
							columnName,
						);
					}
				}
			}
		}

		// Check for duplicate relation names within this table
		const seenRelations = new Set<string>();
		for (const ref of refs) {
			if (ref.options.roles) {
				// Self-ref - check all role names
				const roles = ref.options.roles;
				const allNames = [
					roles.parent,
					roles.children,
					roles.ancestors || 'ancestors',
					roles.descendants || 'descendants',
				];
				for (const name of allNames) {
					if (seenRelations.has(name)) {
						throw new SchemaValidationError(
							`Duplicate relation name '${name}'`,
							tableName,
							ref.columnName,
						);
					}
					seenRelations.add(name);
				}
			} else {
				if (seenRelations.has(ref.localRelation)) {
					throw new SchemaValidationError(
						`Duplicate relation name '${ref.localRelation}'`,
						tableName,
						ref.columnName,
					);
				}
				seenRelations.add(ref.localRelation);
			}
		}

		refsByTable.set(tableName, refs);
	}

	return refsByTable;
}

// ============================================================================
// Naming Derivation
// ============================================================================

/**
 * Derives local relation name from column name.
 * authorId -> author, user_id -> user
 */
function deriveLocalRelation(columnName: string, options: RefOptions): string {
	if (options.as) {
		return options.as;
	}

	// Remove 'Id' suffix (camelCase)
	if (columnName.endsWith('Id')) {
		return columnName.slice(0, -2);
	}

	// Remove '_id' suffix (snake_case - shouldn't happen but handle it)
	if (columnName.endsWith('_id')) {
		return columnName.slice(0, -3);
	}

	// Fallback: use column name as-is
	return columnName;
}

/**
 * Derives inverse relation name.
 * Default pattern: {localRelation}_{tableName}
 */
function deriveInverseRelation(
	localRelation: string,
	sourceTable: string,
	options: RefOptions,
	isSelfRef: boolean,
): string {
	// Self-ref doesn't use standard inverse naming
	if (isSelfRef) {
		return ''; // Handled via roles
	}

	if (options.inverse) {
		return options.inverse;
	}

	// Pattern: author -> author_posts (for source table 'posts')
	return `${localRelation}_${sourceTable}`;
}

// ============================================================================
// Table Building
// ============================================================================

/**
 * Builds TableIR objects from schema definition.
 */
function buildTables(
	definition: SchemaDefinition,
	refsByTable: Map<string, CollectedRef[]>,
	tableNames: string[],
	constraints?: SchemaConstraints,
): TableIR[] {
	const tables: TableIR[] = [];

	for (const tableName of tableNames) {
		const tableDef = definition[tableName];
		if (!tableDef) continue; // Should not happen, but TypeScript needs this

		const columns: ColumnIR[] = [];
		const foreignKeys: ForeignKeyIR[] = [];
		const primaryKey: string[] = [];

		// Find target table's PK type for ref columns
		const getTargetPkType = (target: string): ColumnType => {
			const targetDef = definition[target];
			if (!targetDef) return 'uuid'; // Fallback

			// Find the primary key column
			for (const [, colDef] of Object.entries(targetDef)) {
				if (isRef(colDef)) continue;
				const def = normalizeColumnDef(colDef);
				if (def.primaryKey) {
					return def.type;
				}
			}
			// Default: first 'id' column or uuid
			if ('id' in targetDef) {
				const idDef = targetDef.id;
				if (idDef && !isRef(idDef)) {
					return normalizeColumnDef(idDef).type;
				}
			}
			return 'uuid'; // Fallback
		};

		for (const [columnName, columnDef] of Object.entries(tableDef)) {
			if (isRef(columnDef)) {
				// FK column - type derived from target's PK
				const targetPkType = getTargetPkType(columnDef.target);

				const col: ColumnIR = {
					name: columnName,
					type: targetPkType,
					nullable: columnDef.options.nullable ?? false,
				};
				if (columnDef.options.unique) {
					(col as { unique?: boolean }).unique = true;
				}
				columns.push(col);

				const fk: ForeignKeyIR = {
					columns: [columnName],
					references: {
						table: columnDef.target,
						columns: ['id'], // Convention: FK targets 'id'
					},
				};
				if (columnDef.options.onDelete) {
					(fk as { onDelete?: OnDeleteAction }).onDelete =
						columnDef.options.onDelete;
				}
				foreignKeys.push(fk);
			} else {
				// Regular column
				const def = normalizeColumnDef(columnDef);
				const col: ColumnIR = {
					name: columnName,
					type: def.type,
					nullable: def.nullable ?? false,
				};
				if (def.unique) {
					(col as { unique?: boolean }).unique = def.unique;
				}
				if (def.autoIncrement) {
					(col as { autoIncrement?: boolean }).autoIncrement =
						def.autoIncrement;
				}
				if (def.default !== undefined) {
					(col as { default?: unknown }).default = def.default;
				}
				columns.push(col);

				if (def.primaryKey) {
					primaryKey.push(columnName);
				}
			}
		}

		// Determine PK: explicit > composite FK > 'id' column > omit
		let finalPk: string | readonly string[] | undefined;
		if (primaryKey.length > 0) {
			finalPk =
				primaryKey.length === 1 ? (primaryKey[0] as string) : primaryKey;
		} else {
			// No explicit PK — infer from FK columns or 'id'
			const fkColumns = foreignKeys.flatMap((fk) => fk.columns);
			if (fkColumns.length > 0) {
				finalPk = fkColumns.length === 1 ? fkColumns[0] : fkColumns;
			} else {
				const hasId = columns.some((c) => c.name === 'id');
				finalPk = hasId ? 'id' : undefined;
			}
		}

		// Generate pseudo-columns for self-referential FKs
		const pseudoColumns: PseudoColumnMetadata[] = [];
		const refs = refsByTable.get(tableName) || [];
		for (const ref of refs) {
			if (ref.options.roles && ref.target === tableName) {
				// Self-referential with roles - generate pseudo-column
				const pkColumn =
					typeof finalPk === 'string' ? finalPk : (finalPk?.[0] ?? 'id');
				pseudoColumns.push(
					createPseudoColumnMetadata(
						tableName,
						ref.columnName,
						pkColumn,
						ref.options.roles.parent,
						ref.options.roles.children,
					),
				);
			}
		}

		// Build indexes from column-level index: true declarations
		const indexes: IndexIR[] = [];
		for (const [columnName, columnDef] of Object.entries(tableDef)) {
			if (isRef(columnDef)) continue;
			const def = normalizeColumnDef(columnDef);
			if (def.index) {
				indexes.push({
					name: `idx_${tableName}_${columnName}`,
					columns: [columnName],
					unique: false,
				});
			}
		}

		// Process table-level constraints (2nd arg to schema())
		const tableConstraints = constraints?.[tableName];
		if (tableConstraints) {
			// Composite indexes
			if (tableConstraints.indexes) {
				for (const idx of tableConstraints.indexes) {
					indexes.push({
						name: idx.name ?? `idx_${tableName}_${idx.columns.join('_')}`,
						columns: idx.columns,
						unique: idx.unique ?? false,
					});
				}
			}

			// Composite foreign keys
			if (tableConstraints.foreignKeys) {
				for (const fkRef of tableConstraints.foreignKeys) {
					if (!fkRef.options.columns?.length) {
						throw new SchemaValidationError(
							`Composite FK on "${tableName}" → "${fkRef.target}" requires 'columns' option`,
							tableName,
						);
					}
					const fk: ForeignKeyIR = {
						columns: [...fkRef.options.columns],
						references: {
							table: fkRef.target,
							columns: fkRef.options.references
								? [...fkRef.options.references]
								: ['id'],
						},
					};
					if (fkRef.options.onDelete) {
						(fk as { onDelete?: OnDeleteAction }).onDelete =
							fkRef.options.onDelete;
					}
					foreignKeys.push(fk);
				}
			}
		}

		const table: TableIR = {
			name: tableName,
			columns,
			...(finalPk !== undefined ? { primaryKey: finalPk } : {}),
			foreignKeys,
			indexes,
			...(pseudoColumns.length > 0 ? { pseudoColumns } : {}),
		};
		tables.push(table);
	}

	return tables;
}

/**
 * Normalizes column definition to object form.
 */
function normalizeColumnDef(def: ColumnDef): {
	type: SchemaColumnType;
	nullable?: boolean;
	unique?: boolean;
	primaryKey?: boolean;
	autoIncrement?: boolean;
	default?: unknown;
	index?: boolean;
} {
	if (typeof def === 'string') {
		return { type: def };
	}
	return def;
}

// ============================================================================
// Relation Building
// ============================================================================

/**
 * Builds RelationIR objects from collected refs.
 */
function buildRelations(
	_definition: SchemaDefinition,
	refsByTable: Map<string, CollectedRef[]>,
	tableNames: string[],
): RelationIR[] {
	const relations: RelationIR[] = [];

	for (const tableName of tableNames) {
		const refs = refsByTable.get(tableName) || [];

		for (const ref of refs) {
			if (ref.options.roles) {
				// Self-referential - generate 4 relations
				const roles = ref.options.roles;

				// 1. Direct parent (belongsTo)
				relations.push({
					name: roles.parent,
					type: 'belongsTo',
					source: tableName,
					target: tableName,
					foreignKey: ref.columnName,
					cardinality: 'one',
					optionality: ref.options.nullable ? 'optional' : 'required',
					includeStrategy: 'auto',
					filterStrategy: 'auto',
					joinDefault: 'auto',
				});

				// 2. Direct children (hasMany)
				relations.push({
					name: roles.children,
					type: 'hasMany',
					source: tableName,
					target: tableName,
					foreignKey: ref.columnName,
					cardinality: 'many',
					optionality: 'optional', // Children are always optional
					includeStrategy: 'auto',
					filterStrategy: 'auto',
					joinDefault: 'auto',
				});

				// 3. Recursive ancestors (hasMany with recursive metadata)
				const ancestorsName = roles.ancestors || 'ancestors';
				relations.push({
					name: ancestorsName,
					type: 'hasMany',
					source: tableName,
					target: tableName,
					foreignKey: ref.columnName,
					cardinality: 'many',
					optionality: 'optional',
					includeStrategy: 'auto',
					filterStrategy: 'auto',
					joinDefault: 'auto',
					recursive: {
						direction: 'up',
						maxDepth: 10,
						through: roles.parent,
					},
				});

				// 4. Recursive descendants (hasMany with recursive metadata)
				const descendantsName = roles.descendants || 'descendants';
				relations.push({
					name: descendantsName,
					type: 'hasMany',
					source: tableName,
					target: tableName,
					foreignKey: ref.columnName,
					cardinality: 'many',
					optionality: 'optional',
					includeStrategy: 'auto',
					filterStrategy: 'auto',
					joinDefault: 'auto',
					recursive: {
						direction: 'down',
						maxDepth: 10,
						through: roles.children,
					},
				});
			} else {
				// Standard relation - generate belongsTo and inverse hasMany/hasOne
				const isUnique = ref.options.unique ?? false;

				// 1. belongsTo from source to target
				relations.push({
					name: ref.localRelation,
					type: 'belongsTo',
					source: tableName,
					target: ref.target,
					foreignKey: ref.columnName,
					cardinality: 'one',
					optionality: ref.options.nullable ? 'optional' : 'required',
					includeStrategy: 'auto',
					filterStrategy: 'auto',
					joinDefault: 'auto',
				});

				// 2. Inverse relation from target to source
				const inverseType: RelationType = isUnique ? 'hasOne' : 'hasMany';
				const inverseCardinality = isUnique ? 'one' : 'many';

				relations.push({
					name: ref.inverseRelation,
					type: inverseType,
					source: ref.target,
					target: tableName,
					foreignKey: ref.columnName,
					cardinality: inverseCardinality,
					optionality: 'optional', // Inverse is always optional
					includeStrategy: 'auto',
					filterStrategy: 'auto',
					joinDefault: 'auto',
				});
			}
		}
	}

	return relations;
}

// ============================================================================
// Database Introspection → Schema
// ============================================================================

/**
 * Options for getSchemaFromDb.
 */
export interface GetSchemaFromDbOptions {
	/** Schema name to introspect (default: 'public' for PostgreSQL) */
	readonly schema?: string;
	/** Tables to include (default: all). */
	readonly tables?: readonly string[];
	/** Tables to exclude (glob patterns supported). */
	readonly exclude?: readonly string[];
}

/**
 * Map ColumnType from ModelIR to JS-friendly runtime type strings.
 * Used by getSchemaFromDb to create user-friendly schema definitions.
 *
 * Tests expect: 'serial/integer' → 'number', 'varchar/text' → 'string'
 */
function columnTypeToJsType(type: ColumnType): SchemaColumnType {
	switch (type) {
		// Numeric types → 'number' (includes integer, bigint, decimal)
		case 'integer':
		case 'bigint':
		case 'decimal':
			return 'number';
		// String types → 'string' (includes text, uuid)
		case 'text':
		case 'uuid':
			return 'string';
		// All other types pass through as-is (they're valid SchemaColumnType)
		default:
			return type;
	}
}

/**
 * Adapter interface for introspection.
 * Must have introspect() method and optionally dbCasing.
 */
interface IntrospectableAdapter {
	readonly dbCasing?: DbCasing;
	introspect(options?: {
		schema?: string;
		include?: readonly string[];
		exclude?: readonly string[];
	}): Promise<ModelIR & { introspectedAt?: Date }>;
}

/**
 * Create a Schema from database introspection.
 *
 * This function introspects the database schema and returns a Schema<T>
 * that can be used with createOrm().
 *
 * @example
 * ```typescript
 * const adapter = createPgsqlAdapter(pool);
 * const schema = await getSchemaFromDb(adapter, { schema: 'public' });
 * const orm = createOrm({ schema, adapter });
 * ```
 *
 * @param adapter - An adapter that implements introspect()
 * @param options - Introspection options (schema name, table filters)
 * @returns A Schema<T> with definition, model, and type-safe tables
 */
export async function getSchemaFromDb<
	T extends SchemaDefinition = SchemaDefinition,
>(
	adapter: IntrospectableAdapter,
	options?: GetSchemaFromDbOptions,
): Promise<Schema<T>> {
	// Build introspection options, only including defined values
	const introspectOptions: {
		schema?: string;
		include?: readonly string[];
		exclude?: readonly string[];
	} = {};
	if (options?.schema !== undefined) introspectOptions.schema = options.schema;
	if (options?.tables !== undefined) introspectOptions.include = options.tables;
	if (options?.exclude !== undefined)
		introspectOptions.exclude = options.exclude;

	// Call adapter introspection
	const introspectionResult = await adapter.introspect(introspectOptions);

	const model = introspectionResult;
	const introspectedAt = introspectionResult.introspectedAt;

	// Build FK lookup: column name → target table
	// ForeignKeyIR uses columns[] array and references.table
	const fkLookup = new Map<
		string,
		Map<string, { target: string; nullable: boolean; unique: boolean }>
	>();
	for (const table of model.tables.values()) {
		const tableFks = new Map<
			string,
			{ target: string; nullable: boolean; unique: boolean }
		>();
		for (const fk of table.foreignKeys) {
			// Only handle single-column FKs for now (composite FKs are rare in schema defs)
			const fkColumn = fk.columns[0];
			if (!fkColumn) continue;

			// Find the column to check nullable/unique
			const column = table.columns.find((c) => c.name === fkColumn);
			tableFks.set(fkColumn, {
				target: fk.references.table,
				nullable: column?.nullable ?? true,
				unique: column?.unique ?? false,
			});
		}
		fkLookup.set(table.name, tableFks);
	}

	// Convert ModelIR to SchemaDefinition
	const definition: Record<string, TableDef> = {};

	for (const table of model.tables.values()) {
		const tableDef: TableDef = {};
		const tableFks = fkLookup.get(table.name) ?? new Map();

		for (const column of table.columns) {
			const fk = tableFks.get(column.name);

			if (fk) {
				// FK column → ref() definition
				tableDef[column.name] = ref(fk.target, {
					nullable: fk.nullable,
					unique: fk.unique,
				});
			} else {
				// Regular column → JS type
				tableDef[column.name] = columnTypeToJsType(column.type);
			}
		}

		definition[table.name] = tableDef;
	}

	const tableNames = Object.keys(definition) as (keyof T)[];

	// Create type-safe tables proxy
	const tables = createTablesProxy(
		model,
		tableNames as string[],
	) as InferTables<T>;

	// Build result with optional properties only if defined
	const result: Schema<T> = {
		definition: definition as T,
		model,
		tableNames,
		tables,
	};

	// Add optional properties only if they have values
	if (adapter.dbCasing !== undefined) {
		(result as { dbCasing?: DbCasing }).dbCasing = adapter.dbCasing;
	}
	if (introspectedAt !== undefined) {
		(result as { introspectedAt?: Date }).introspectedAt = introspectedAt;
	}

	return result;
}
