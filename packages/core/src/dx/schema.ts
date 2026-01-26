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

import { ModelIRImpl } from '../model-impl.js';
import type {
	ColumnIR,
	ColumnType,
	ForeignKeyIR,
	ModelIR,
	OnDeleteAction,
	PseudoColumnMetadata,
	RelationIR,
	RelationType,
	TableIR,
} from '../model-ir.js';
import { createPseudoColumnMetadata } from '../model-ir.js';

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
}

/**
 * Marker type for ref() declarations in schema.
 * @internal
 */
export interface RefDefinition {
	readonly __brand: 'ref';
	readonly target: string;
	readonly options: RefOptions;
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
 * Result of schema() function with strongly-typed table/column info.
 */
export interface Schema<T extends SchemaDefinition> {
	/** The raw schema definition */
	readonly definition: T;
	/** Converted ModelIR for use with ORM */
	readonly model: ModelIR;
	/** Table names */
	readonly tableNames: (keyof T)[];
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
 * FK columns are typically number (auto-increment) or string (uuid).
 * Since we can't know the target PK type at compile time without circular refs,
 * we use a union of common PK types.
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
export function ref(target: string, options: RefOptions = {}): RefDefinition {
	return {
		__brand: 'ref',
		target,
		options,
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
export function schema<T extends SchemaDefinition>(definition: T): Schema<T> {
	// Validate and convert to ModelIR
	const model = schemaToModelIR(definition);

	return {
		definition,
		model,
		tableNames: Object.keys(definition) as (keyof T)[],
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
export function schemaToModelIR(definition: SchemaDefinition): ModelIR {
	const tableNames = Object.keys(definition);

	// Phase 1: Validate refs point to existing tables
	validateRefs(definition, tableNames);

	// Phase 2: Collect all refs and validate constraints
	const refsByTable = collectRefs(definition);

	// Phase 3: Build tables (columns, PKs, FKs)
	const tables = buildTables(definition, refsByTable, tableNames);

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

		// Default PK to 'id' if none specified
		let finalPk: string | readonly string[];
		if (primaryKey.length === 0) {
			finalPk = 'id';
		} else if (primaryKey.length === 1) {
			finalPk = primaryKey[0] as string;
		} else {
			finalPk = primaryKey;
		}

		// Generate pseudo-columns for self-referential FKs
		const pseudoColumns: PseudoColumnMetadata[] = [];
		const refs = refsByTable.get(tableName) || [];
		for (const ref of refs) {
			if (ref.options.roles && ref.target === tableName) {
				// Self-referential with roles - generate pseudo-column
				const pkColumn =
					typeof finalPk === 'string' ? finalPk : (finalPk[0] ?? 'id');
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

		const table: TableIR = {
			name: tableName,
			columns,
			primaryKey: finalPk,
			foreignKeys,
			indexes: [],
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
