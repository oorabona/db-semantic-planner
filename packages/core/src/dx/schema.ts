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

import type { WhereIntent } from '@dbsp/types';
import type { Mutable } from '@dbsp/types/internal';
import type { DbCasing } from '../adapter.js';
import { ModelIRImpl } from '../model-impl.js';
import type {
	CheckConstraintIR,
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
			dbType?: string;
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
	/** Target schema name (omit for same-schema references) */
	schema?: string;

	// FK column constraints
	/** Is this FK nullable? → optional relation */
	nullable?: boolean;
	/** Is this FK unique? → 1:1 instead of 1:N */
	unique?: boolean;

	// FK behavior
	/** ON DELETE action */
	onDelete?: OnDeleteAction;
	/** ON UPDATE action */
	onUpdate?: OnDeleteAction;

	// Relation naming
	/** Local relation name (e.g., 'createdBy' for createdById column) */
	as?: string;
	/** Inverse relation name on target table (e.g., 'writings' instead of 'author_posts') */
	inverse?: string;

	// Self-ref only (MANDATORY when source === target)
	/** Role names for self-referential relations */
	roles?: SelfRefRoles;

	/**
	 * Source columns forming a composite FK (table-level `foreignKeys` only).
	 */
	columns?: readonly string[];

	/**
	 * Target columns the FK references.
	 * - For column-level `ref()`: the target column on the referenced
	 *   table. Defaults to `['id']` by convention; the actual target
	 *   PK column is not auto-resolved. Length must be exactly 1.
	 * - For table-level composite FKs: the list of target columns.
	 */
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
export interface SchemaIndexOptions {
	/** Columns included in the index */
	columns: string[];
	/** Whether this is a unique index */
	unique?: boolean;
	/** Custom index name (auto-generated if not provided) */
	name?: string;
	/** Index access method (default: btree). E.g. 'gin', 'gist', 'hnsw', 'bm25' */
	method?: string;
	/** Partial index predicate (WHERE clause) */
	where?: string;
	/** Per-column operator class overrides. Key = column name, value = opclass name */
	opclass?: Record<string, string>;
	/** Index storage parameters (WITH clause). Key = param name, value = param value */
	with?: Record<string, string>;
}

export interface SchemaTableOptions {
	/** Indexes for this table (simple, composite, partial, GIN, HNSW, BM25, etc.) */
	indexes?: SchemaIndexOptions[];
	/** CHECK constraints for this table */
	checkConstraints?: Array<{
		name: string;
		expression: string;
	}>;
	/** Composite foreign keys for this table (use ref() with columns/references) */
	foreignKeys?: RefDefinition[];
}

/**
 * Per-table constraint options, keyed by table name.
 */
export type SchemaConstraints = Record<string, SchemaTableOptions>;

/**
 * Top-level schema-wide DDL objects: extensions, sequences.
 */
export interface SchemaExtras {
	/** PostgreSQL extensions to ensure (CREATE EXTENSION IF NOT EXISTS "name") */
	extensions?: string[];
	/** Sequences to create (CREATE SEQUENCE). Key = sequence name */
	sequences?: Record<
		string,
		{
			startWith?: number;
			incrementBy?: number;
			minValue?: number;
			maxValue?: number;
			cycle?: boolean;
		}
	>;
}

/**
 * Result of schema() function with strongly-typed table/column info.
 */
/**
 * Per-table default filters applied to all queries.
 * Commonly used for soft delete filtering.
 *
 * @example
 * ```typescript
 * import { isNull } from '@dbsp/core';
 *
 * const db = schema(tables, undefined, {
 *   defaultFilters: {
 *     products: isNull('deletedAt'),
 *     users: isNull('deletedAt'),
 *   },
 * });
 * ```
 */
export type DefaultFilters = Record<string, WhereIntent>;

/**
 * Options for schema() function.
 */
export interface SchemaOptions {
	/**
	 * Default filters applied automatically to all queries per table.
	 * Override with `.withoutDefaultFilters()` on the query builder.
	 */
	defaultFilters?: DefaultFilters;
	/**
	 * Column name treated as the implicit primary key for short-form column
	 * declarations. When set (default `'id'`), `inferPrimaryKey` resolves the
	 * implicit PK BEFORE falling back to FK columns: a column matching this name
	 * is treated as the PK whenever no explicit `primaryKey: true` flag is present
	 * on any column — regardless of whether the table also has FK columns.
	 *
	 * Default: `'id'` (matches existing codebase convention).
	 *
	 * Set to `null` to disable the implicit-PK convention entirely. Primary
	 * keys must then be declared explicitly with `primaryKey: true` (or are
	 * inferred from FK columns for junction tables). Empty string (`''`) and
	 * whitespace-only strings are rejected eagerly at `schema()` time
	 * (before any per-table processing) with a `SchemaValidationError`.
	 *
	 * Match the adapter's `defaultPkColumnName` if your project uses a
	 * different naming scheme (e.g. `'pk_uuid'`).
	 *
	 * @remarks
	 * `inferPrimaryKey` resolves PKs in this order:
	 *   1. Explicit `primaryKey: true` on column(s)
	 *   2. Column matching `defaultPkColumnName` (this option) — skipped when set to `null`
	 *   3. FK columns (composite, for junction tables — applies regardless of this option)
	 *   4. No primary key
	 *
	 * @example
	 * // Default — 'id' is implicit PK
	 * schema({ users: { id: 'uuid' } });
	 *
	 * // Custom convention
	 * schema({ users: { pk_uuid: 'uuid' } }, undefined, { defaultPkColumnName: 'pk_uuid' });
	 *
	 * // Strict — no implicit PK convention
	 * schema({ users: { id: 'uuid' } }, undefined, { defaultPkColumnName: null });
	 * // ↑ no PK declared — FKs targeting users.id will fail validation.
	 */
	defaultPkColumnName?: string | null;
}

export interface Schema<T extends SchemaDefinition> {
	/** The raw schema definition */
	readonly definition: T;
	/** Table-level constraints supplied to schema() or reconstructed from introspection */
	readonly constraints?: SchemaConstraints;
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
	/**
	 * Default filters per table (e.g., soft delete filtering).
	 * Applied automatically to all queries unless `.withoutDefaultFilters()` is called.
	 */
	readonly defaultFilters?: DefaultFilters;
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

function normalizeReferenceSchema(
	schemaName: string | null | undefined,
): string | undefined {
	if (schemaName == null) return undefined;
	return schemaName.trim().length > 0 ? schemaName : undefined;
}

function hasExternalSchema(schemaName: string | null | undefined): boolean {
	return normalizeReferenceSchema(schemaName) !== undefined;
}

function normalizeRefOptions<TOptions extends RefOptions>(
	options: TOptions,
): TOptions {
	const schemaName = normalizeReferenceSchema(options.schema);
	if (schemaName === options.schema) return options;

	const { schema: _schema, ...rest } = options;
	return (
		schemaName === undefined ? rest : { ...rest, schema: schemaName }
	) as TOptions;
}

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
		options: options ? normalizeRefOptions(options) : ({} as TOptions),
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
	options?: SchemaOptions,
	extras?: SchemaExtras,
): Schema<T> {
	// Validate and convert to ModelIR
	const model = schemaToModelIR(definition, constraints, extras, options);
	const tableNames = Object.keys(definition) as (keyof T)[];

	// Validate default filters reference existing tables
	const defaultFilters = options?.defaultFilters;
	if (defaultFilters) {
		const tableNameSet = new Set(tableNames as string[]);
		for (const tableName of Object.keys(defaultFilters)) {
			if (!tableNameSet.has(tableName)) {
				throw new SchemaValidationError(
					`Default filter for non-existent table '${tableName}'. ` +
						`Available: ${[...tableNameSet].join(', ')}`,
				);
			}
		}
	}

	// Create type-safe tables proxy (DX-040)
	const tables = createTablesProxy(
		model,
		tableNames as string[],
	) as InferTables<T>;

	return {
		definition,
		...(constraints !== undefined ? { constraints } : {}),
		model,
		tableNames,
		tables,
		...(defaultFilters ? { defaultFilters } : {}),
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
	extras?: SchemaExtras,
	options?: SchemaOptions,
): ModelIR {
	// R6-L1: fail-fast before any per-table work. Empty / whitespace-only
	// defaultPkColumnName is rejected here (once) rather than per-table in
	// inferPrimaryKey, because the error is a schema-level misconfiguration
	// and should be reported at the earliest possible point.
	if (
		typeof options?.defaultPkColumnName === 'string' &&
		options.defaultPkColumnName.trim().length === 0
	) {
		throw new SchemaValidationError(
			`defaultPkColumnName cannot be an empty or whitespace-only string. Pass null to disable the implicit-PK convention or omit the option for the default 'id'.`,
		);
	}

	const tableNames = Object.keys(definition);

	// Phase 1: Validate refs point to existing tables (existence + roles only)
	validateRefs(definition, tableNames);

	// Phase 2: Collect all refs and validate constraints
	const refsByTable = collectRefs(definition);

	// Phase 3: Build tables (columns, PKs, FKs, indexes) — inferPrimaryKey runs here
	const tables = buildTables(
		definition,
		refsByTable,
		tableNames,
		constraints,
		options,
	);

	// Phase 3.5: Validate FK targets exist and are referenceable (post-build, uses resolved PKs)
	validateFkTargets(tables);

	// Phase 4: Build relations from refs and table-level composite FK constraints
	const relations = buildRelations(
		definition,
		refsByTable,
		tableNames,
		constraints,
	);

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

	// Phase 6: Build extras (extensions, sequences)
	const extensions = extras?.extensions;
	const sequenceMap = extras?.sequences
		? new Map(
				Object.entries(extras.sequences).map(([name, seq]) => [
					name,
					{ name, ...seq },
				]),
			)
		: undefined;

	return new ModelIRImpl(
		tableMap,
		relationMap,
		undefined,
		extensions,
		sequenceMap,
	);
}

// ============================================================================
// Validation
// ============================================================================

function validateRefs(
	definition: SchemaDefinition,
	tableNames: string[],
): void {
	const tableSet = new Set(tableNames);

	for (const [tableName, tableDef] of Object.entries(definition)) {
		for (const [columnName, columnDef] of Object.entries(tableDef)) {
			if (isRef(columnDef)) {
				// Check target exists
				if (
					!hasExternalSchema(columnDef.options.schema) &&
					!tableSet.has(columnDef.target)
				) {
					throw new SchemaValidationError(
						`Foreign key '${columnName}' references non-existent table '${columnDef.target}'`,
						tableName,
						columnName,
					);
				}

				// Self-ref requires roles
				if (
					!hasExternalSchema(columnDef.options.schema) &&
					columnDef.target === tableName &&
					!columnDef.options.roles
				) {
					throw new SchemaValidationError(
						`Self-referential FK '${columnName}' must have 'roles' option with parent/children names`,
						tableName,
						columnName,
					);
				}

				// Roles only valid for self-ref
				if (
					(hasExternalSchema(columnDef.options.schema) ||
						columnDef.target !== tableName) &&
					columnDef.options.roles
				) {
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
 * PostgreSQL UNIQUE constraints only support btree and hash index methods.
 * Other methods (gin, gist, brin, spgist, hnsw, bm25, etc.) cannot enforce
 * uniqueness and therefore cannot back a foreign key target column.
 * Treat undefined as 'btree' (the PostgreSQL default).
 */
const UNIQUE_CAPABLE_INDEX_METHODS = new Set(['btree', 'hash']);

/**
 * Validates FK target columns exist and are referenceable.
 *
 * For ALL FKs (single-column and composite):
 *   - Source and target column counts must match.
 *
 * For local-target FKs:
 *   - Every referenced column must exist on the target table.
 *
 * For single-column FKs only (the case `buildRefColumn` produces where both
 * `fk.columns.length === 1` AND `fk.references.columns.length === 1`):
 *   - Referenced column must be referenceable: singleton primary key,
 *     column-level `unique: true`, or a single-column UNIQUE index declared
 *     via SchemaConstraints covering exactly the referenced column with no
 *     partial-index `WHERE` clause, no expression columns, and using a
 *     uniqueness-capable index method (btree or hash).
 *   - Mirrors PostgreSQL error 42830 ("there is no unique constraint matching
 *     given keys for referenced table") at schema()-time instead of at DDL
 *     apply time.
 *
 * Composite PK members alone do not qualify as referenceable (matches PG strict
 * semantics): a column that is part of a composite PK still needs an explicit
 * UNIQUE constraint to be the target of an FK.
 */
function validateFkTargets(tables: readonly TableIR[]): void {
	const tableMap = new Map(tables.map((t) => [t.name, t]));

	for (const table of tables) {
		for (const fk of table.foreignKeys) {
			// R4-1: Source-column existence — guard against constraint-level FKs that
			// declare `columns: [...]` referencing local columns that don't exist on
			// the source table. Column-level FKs (via buildRefColumn) can't trigger
			// this because the source column IS the column being declared, but
			// SchemaConstraints.foreignKeys does not validate this elsewhere.
			for (const srcCol of fk.columns) {
				if (!table.columns.some((c) => c.name === srcCol)) {
					throw new SchemaValidationError(
						`Foreign key in '${table.name}' uses non-existent source column '${srcCol}'`,
						table.name,
						srcCol,
					);
				}
			}

			// Validate column counts. Zero-length arrays on either side are malformed
			// and should be flagged here rather than silently passed to PG.
			if (fk.columns.length === 0 || fk.references.columns.length === 0) {
				throw new SchemaValidationError(
					`Foreign key in '${table.name}' has zero-length \`columns\` or \`references\` array`,
					table.name,
					fk.columns[0],
				);
			}

			// R6-3a: source and target column counts must match for ALL FKs (composite included).
			// PostgreSQL requires a 1-to-1 mapping between source and referenced columns.
			if (fk.columns.length !== fk.references.columns.length) {
				throw new SchemaValidationError(
					`Foreign key in '${table.name}' has mismatched column counts: ` +
						`${fk.columns.length} source column(s) but ${fk.references.columns.length} referenced column(s)`,
					table.name,
					fk.columns[0],
				);
			}

			if (hasExternalSchema(fk.references.schema)) continue;

			const target = tableMap.get(fk.references.table);
			// Defensive: column-level FKs are pre-validated by validateRefs (Phase 1),
			// but table-level constraints.foreignKeys bypass that — so this gate is
			// the only barrier against constraint-based FKs to non-existent tables.
			// Throw rather than skip silently.
			if (!target) {
				throw new SchemaValidationError(
					`Foreign key in '${table.name}' references non-existent table '${fk.references.table}'`,
					table.name,
					fk.columns[0],
				);
			}

			// R6-3b: every referenced column must exist on local target tables.
			for (const refCol of fk.references.columns) {
				if (!target.columns.some((c) => c.name === refCol)) {
					throw new SchemaValidationError(
						`Foreign key in '${table.name}' references non-existent column '${target.name}.${refCol}'`,
						table.name,
						fk.columns[0],
					);
				}
			}

			// Uniqueness check is single-column-only — composites left to PostgreSQL.
			if (fk.columns.length !== 1 || fk.references.columns.length !== 1)
				continue;

			for (const refCol of fk.references.columns) {
				// Existence already validated by R6-3b above for all FKs — targetCol is guaranteed defined here.
				const targetCol = target.columns.find((c) => c.name === refCol);
				if (!targetCol) continue; // defensive
				// Uniqueness — a column is referenceable when any of the following holds:
				//   1. It is the table's singleton resolved primaryKey (covers explicit column-level PK,
				//      table-level singleton PK, and the implicit-id convention resolved by inferPrimaryKey).
				//   2. It has explicit `unique: true`.
				//   3. It is the sole column of a non-partial, non-expression single-column UNIQUE index
				//      declared via SchemaConstraints (partial indexes with a WHERE clause, or expression
				//      indexes, do NOT make a column referenceable — PG error 42830).
				// Members of a composite PK alone do not qualify (matches PG strict semantics).
				const isSingletonPk =
					typeof target.primaryKey === 'string' && target.primaryKey === refCol;
				const isUnique = targetCol.unique === true;
				// R2-F2: PG only allows UNIQUE constraints on btree/hash indexes —
				// gin/gist/brin/spgist/hnsw/bm25 cannot enforce uniqueness even when
				// `unique: true` is declared. Fail at schema() time instead of DDL apply.
				const isUniqueIndex =
					target.indexes?.some((idx) => {
						const method = idx.method ?? 'btree';
						return (
							idx.unique === true &&
							idx.columns.length === 1 &&
							idx.columns[0] === refCol &&
							idx.where === undefined &&
							(idx.expressions === undefined || idx.expressions.length === 0) &&
							UNIQUE_CAPABLE_INDEX_METHODS.has(method)
						);
					}) ?? false;
				if (!isSingletonPk && !isUnique && !isUniqueIndex) {
					// R2-F1: tailor the remediation hint based on the target's PK shape.
					// - composite PK (string[]): no single PK column to target; suggest
					//   marking unique or using a table-level composite FK.
					// - resolved single PK (string): point at the existing PK column.
					// - no PK at all: suggest the defaultPkColumnName convention.
					const isCompositePk = Array.isArray(target.primaryKey);
					const hasSingleResolvedPk = typeof target.primaryKey === 'string';
					const suggestion = isCompositePk
						? `Either mark '${target.name}.${refCol}' with \`unique: true\` or add a single-column unique index via SchemaConstraints — '${target.name}' has a composite primary key, so a single-column FK cannot target the PK directly (use a table-level composite FK referencing all PK columns if that is the intent).`
						: hasSingleResolvedPk
							? `Either mark the target column with \`unique: true\`, add a single-column unique index via SchemaConstraints, or change the FK to target the existing primary key column '${target.primaryKey as string}'.`
							: `Either mark the target column with \`unique: true\`, add a single-column unique index via SchemaConstraints, or — if '${refCol}' is your primary-key column convention — pass \`{ defaultPkColumnName: '${refCol}' }\` as the third argument to \`schema()\` (or omit the option entirely if '${refCol}' is 'id').`;
					throw new SchemaValidationError(
						`Foreign key in '${table.name}' targets '${target.name}.${refCol}' which is neither primary key nor unique. ${suggestion}`,
						table.name,
						fk.columns[0],
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
 * Returns the ColumnType of the primary key in the target table definition.
 * Falls back to 'uuid' if the target is not found or has no explicit PK.
 */
function getTargetPkType(
	definition: SchemaDefinition,
	target: string,
): ColumnType {
	const targetDef = definition[target];
	if (!targetDef) return 'uuid';

	for (const [, colDef] of Object.entries(targetDef)) {
		if (isRef(colDef)) continue;
		const def = normalizeColumnDef(colDef);
		if (def.primaryKey) return def.type;
	}

	if ('id' in targetDef) {
		const idDef = targetDef.id;
		if (idDef && !isRef(idDef)) return normalizeColumnDef(idDef).type;
	}
	return 'uuid';
}

/**
 * Returns the ColumnType for a specific named column in a target table definition.
 * Used by buildRefColumn to derive the source column type when `references` points
 * to a non-PK unique column. Falls back to `undefined` when the column is not found
 * or is itself a ref (chain case handled by getTargetPkType).
 */
function getReferencedColumnType(
	targetDef: TableDef,
	referencedCol: string,
	definition?: SchemaDefinition,
	visited?: Set<string>,
): ColumnType | undefined {
	const colDef = targetDef[referencedCol];
	if (!colDef) return undefined;
	if (isRef(colDef)) {
		// R6-5 (chained ref): follow the chain to resolve the final concrete type.
		// Guard against cycles and runaway chains with a visited-key accumulator.
		if (!definition) return undefined;
		const chainedTableName = colDef.target;
		const chainedTargetDef = definition[chainedTableName];
		if (!chainedTargetDef) return undefined;
		// The chained ref's referenced column: options.references[0] ?? 'id'
		const chainedRefCols = colDef.options.references;
		const firstChainedRefCol =
			chainedRefCols && chainedRefCols.length === 1
				? chainedRefCols[0]
				: undefined;
		const chainedRefCol: string = firstChainedRefCol ?? 'id';
		// Visited key uniquely identifies the (tableDef, column) pair in the chain.
		const visitedKey = `${chainedTableName}.${chainedRefCol}`;
		const seen = visited ?? new Set<string>();
		if (seen.has(visitedKey)) return undefined; // cycle detected
		seen.add(visitedKey);
		return getReferencedColumnType(
			chainedTargetDef,
			chainedRefCol,
			definition,
			seen,
		);
	}
	return normalizeColumnDef(colDef).type;
}

/**
 * Builds a FK column + ForeignKeyIR pair from a ref definition.
 */
function buildRefColumn(
	columnName: string,
	columnDef: RefDefinition,
	definition: SchemaDefinition,
): { col: ColumnIR; fk: ForeignKeyIR } {
	// R5-1: When options.references specifies a single target column, derive the
	// source column type from THAT column's type rather than the target's PK type.
	// This prevents a type mismatch when the FK points at a unique non-PK column
	// that has a different type than the table's PK (e.g. email:string vs id:uuid).
	const targetDef = definition[columnDef.target];
	const externalSchema = normalizeReferenceSchema(columnDef.options.schema);
	if (externalSchema !== undefined) {
		throw new SchemaValidationError(
			`Cannot infer column type for foreign key column '${columnName}' to external table '${externalSchema}.${columnDef.target}'. Declare the source column with an explicit type and add the external foreign key at the table level with SchemaConstraints.foreignKeys.`,
			undefined,
			columnName,
		);
	}
	const targetCol =
		columnDef.options.references?.length === 1
			? columnDef.options.references[0]
			: undefined;
	const inferredType =
		targetCol && targetDef
			? (getReferencedColumnType(targetDef, targetCol, definition) ??
				getTargetPkType(definition, columnDef.target))
			: getTargetPkType(definition, columnDef.target);
	const col: Mutable<ColumnIR> = {
		name: columnName,
		type: inferredType,
		nullable: columnDef.options.nullable ?? false,
	};
	if (columnDef.options.unique) col.unique = true;

	if (
		columnDef.options.references &&
		columnDef.options.references.length !== 1
	) {
		throw new SchemaValidationError(
			`FK column '${columnName}' got 'references' with ${columnDef.options.references.length} columns; column-level FK requires exactly one target column (use table-level foreignKeys for composite FKs).`,
		);
	}
	const fk: Mutable<ForeignKeyIR> = {
		columns: [columnName],
		references: {
			table: columnDef.target,
			columns: columnDef.options.references ?? ['id'],
			...(externalSchema !== undefined ? { schema: externalSchema } : {}),
		},
	};
	if (columnDef.options.onDelete) fk.onDelete = columnDef.options.onDelete;
	if (columnDef.options.onUpdate) fk.onUpdate = columnDef.options.onUpdate;

	return { col: col as ColumnIR, fk: fk as ForeignKeyIR };
}

/**
 * Builds a regular ColumnIR from a normalized column definition.
 */
function buildRegularColumn(
	columnName: string,
	columnDef: ColumnDef,
): { col: ColumnIR; isPk: boolean } {
	const def = normalizeColumnDef(columnDef);
	const col: Mutable<ColumnIR> = {
		name: columnName,
		type: def.type,
		nullable: def.nullable ?? false,
	};
	if (def.dbType?.trim()) col.originalDbType = def.dbType.trim();
	if (def.unique) col.unique = def.unique;
	if (def.autoIncrement) col.autoIncrement = def.autoIncrement;
	if (def.default !== undefined) col.default = def.default;
	return { col: col as ColumnIR, isPk: def.primaryKey ?? false };
}

/**
 * Builds columns, foreign keys, and explicit primary key list for a table.
 */
function buildColumnsForTable(
	_tableName: string,
	tableDef: TableDef,
	definition: SchemaDefinition,
): { columns: ColumnIR[]; foreignKeys: ForeignKeyIR[]; primaryKey: string[] } {
	const columns: ColumnIR[] = [];
	const foreignKeys: ForeignKeyIR[] = [];
	const primaryKey: string[] = [];

	for (const [columnName, columnDef] of Object.entries(tableDef)) {
		if (isRef(columnDef)) {
			const { col, fk } = buildRefColumn(columnName, columnDef, definition);
			columns.push(col);
			foreignKeys.push(fk);
		} else {
			const { col, isPk } = buildRegularColumn(columnName, columnDef);
			columns.push(col);
			if (isPk) primaryKey.push(columnName);
		}
	}
	return { columns, foreignKeys, primaryKey };
}

/**
 * Infers the final primary key from explicit declarations, the implicit-PK name
 * convention, or FK columns (for junction tables).
 *
 * Resolution order:
 *   1. Explicit `primaryKey: true` on column(s)
 *   2. Column matching `defaultPkColumnName` (options.defaultPkColumnName) — skipped
 *      when set to `null` (strict mode)
 *   3. FK columns (composite PK for junction tables — applies regardless of option)
 *   4. No primary key
 */
function inferPrimaryKey(
	primaryKey: string[],
	foreignKeys: ForeignKeyIR[],
	columns: ColumnIR[],
	options?: { defaultPkColumnName?: string | null },
): string | readonly string[] | undefined {
	if (primaryKey.length > 0) {
		return primaryKey.length === 1 ? (primaryKey[0] as string) : primaryKey;
	}
	// Implicit PK convention BEFORE FK fallback. Honoured unless explicitly
	// disabled with `defaultPkColumnName: null`. Empty/whitespace-only strings
	// are rejected at schemaToModelIR() time (R6-L1 guard fires before this runs).
	const pkColName =
		options?.defaultPkColumnName === undefined
			? 'id'
			: options.defaultPkColumnName;
	if (pkColName !== null && columns.some((c) => c.name === pkColName)) {
		return pkColName;
	}
	// FK fallback for junction tables (applies regardless of the option above).
	const fkColumns = foreignKeys.flatMap((fk) => fk.columns);
	if (fkColumns.length > 0) {
		return fkColumns.length === 1 ? fkColumns[0] : fkColumns;
	}
	return undefined;
}

/**
 * Builds pseudo-columns for self-referential FKs with roles.
 */
function buildPseudoColumns(
	tableName: string,
	refsByTable: Map<string, CollectedRef[]>,
	finalPk: string | readonly string[] | undefined,
): PseudoColumnMetadata[] {
	const pseudoColumns: PseudoColumnMetadata[] = [];
	const refs = refsByTable.get(tableName) ?? [];
	const pkColumn =
		typeof finalPk === 'string' ? finalPk : (finalPk?.[0] ?? 'id');

	for (const ref of refs) {
		if (
			!hasExternalSchema(ref.options.schema) &&
			ref.options.roles &&
			ref.target === tableName
		) {
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
	return pseudoColumns;
}

/**
 * Builds IndexIR entries from column-level `index: true` declarations.
 */
function buildColumnIndexes(tableName: string, tableDef: TableDef): IndexIR[] {
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
	return indexes;
}

/**
 * Processes table-level constraints (indexes, CHECK constraints, composite FKs).
 */
function buildTableConstraints(
	tableName: string,
	constraints: SchemaConstraints | undefined,
): {
	extraIndexes: IndexIR[];
	checkConstraints: CheckConstraintIR[];
	extraForeignKeys: ForeignKeyIR[];
} {
	const extraIndexes: IndexIR[] = [];
	const checkConstraints: CheckConstraintIR[] = [];
	const extraForeignKeys: ForeignKeyIR[] = [];

	const tableConstraints = constraints?.[tableName];
	if (!tableConstraints) {
		return { extraIndexes, checkConstraints, extraForeignKeys };
	}

	if (tableConstraints.indexes) {
		for (const idx of tableConstraints.indexes) {
			const indexIR: Mutable<IndexIR> = {
				name: idx.name ?? `idx_${tableName}_${idx.columns.join('_')}`,
				columns: idx.columns,
				unique: idx.unique ?? false,
			};
			if (idx.method) indexIR.method = idx.method;
			if (idx.where) indexIR.where = idx.where;
			if (idx.opclass) indexIR.opclass = idx.opclass;
			if (idx.with) indexIR.with = idx.with;
			extraIndexes.push(indexIR as IndexIR);
		}
	}

	if (tableConstraints.checkConstraints) {
		for (const chk of tableConstraints.checkConstraints) {
			checkConstraints.push({
				name: chk.name,
				expression: `CHECK (${chk.expression})`,
			});
		}
	}

	if (tableConstraints.foreignKeys) {
		for (const fkRef of tableConstraints.foreignKeys) {
			if (!fkRef.options.columns?.length) {
				throw new SchemaValidationError(
					`Composite FK on "${tableName}" → "${fkRef.target}" requires 'columns' option`,
					tableName,
				);
			}
			const externalSchema = normalizeReferenceSchema(fkRef.options.schema);
			const fk: Mutable<ForeignKeyIR> = {
				columns: [...fkRef.options.columns],
				references: {
					table: fkRef.target,
					columns: fkRef.options.references
						? [...fkRef.options.references]
						: ['id'],
					...(externalSchema !== undefined ? { schema: externalSchema } : {}),
				},
			};
			if (fkRef.options.onDelete) fk.onDelete = fkRef.options.onDelete;
			if (fkRef.options.onUpdate) fk.onUpdate = fkRef.options.onUpdate;
			extraForeignKeys.push(fk as ForeignKeyIR);
		}
	}

	return { extraIndexes, checkConstraints, extraForeignKeys };
}

/**
 * Builds TableIR objects from schema definition.
 */
function buildTables(
	definition: SchemaDefinition,
	refsByTable: Map<string, CollectedRef[]>,
	tableNames: string[],
	constraints?: SchemaConstraints,
	options?: SchemaOptions,
): TableIR[] {
	const tables: TableIR[] = [];

	for (const tableName of tableNames) {
		const tableDef = definition[tableName];
		if (!tableDef) continue;

		const { columns, foreignKeys, primaryKey } = buildColumnsForTable(
			tableName,
			tableDef,
			definition,
		);
		const finalPk = inferPrimaryKey(primaryKey, foreignKeys, columns, options);
		const pseudoColumns = buildPseudoColumns(tableName, refsByTable, finalPk);
		const columnIndexes = buildColumnIndexes(tableName, tableDef);
		const { extraIndexes, checkConstraints, extraForeignKeys } =
			buildTableConstraints(tableName, constraints);

		const table: TableIR = {
			name: tableName,
			columns,
			...(finalPk !== undefined ? { primaryKey: finalPk } : {}),
			foreignKeys: [...foreignKeys, ...extraForeignKeys],
			indexes: [...columnIndexes, ...extraIndexes],
			...(checkConstraints.length > 0 ? { checkConstraints } : {}),
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
	dbType?: string;
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
	constraints?: SchemaConstraints,
): RelationIR[] {
	const relations: RelationIR[] = [];

	for (const tableName of tableNames) {
		const refs = refsByTable.get(tableName) || [];

		for (const ref of refs) {
			// RelationIR has no schema field; schema-qualified refs are DDL FKs only.
			if (hasExternalSchema(ref.options.schema)) continue;

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

	addCompositeConstraintRelations(relations, tableNames, constraints);

	return relations;
}

function relationKey(source: string, name: string): string {
	return `${source}.${name}`;
}

function pushRelationIfAbsent(
	relations: RelationIR[],
	relationKeys: Set<string>,
	relation: RelationIR,
): void {
	const key = relationKey(relation.source, relation.name);
	if (relationKeys.has(key)) return;
	relationKeys.add(key);
	relations.push(relation);
}

function deriveCompositeConstraintRelationName(
	fkColumn: string,
	options: RefOptions,
): string {
	return deriveLocalRelation(fkColumn, options);
}

function addCompositeConstraintRelations(
	relations: RelationIR[],
	tableNames: readonly string[],
	constraints?: SchemaConstraints,
): void {
	if (!constraints) return;

	const tableSet = new Set(tableNames);
	const relationKeys = new Set(
		relations.map((relation) => relationKey(relation.source, relation.name)),
	);

	for (const tableName of tableNames) {
		const foreignKeys = constraints[tableName]?.foreignKeys;
		if (!foreignKeys) continue;

		for (const fkRef of foreignKeys) {
			if (hasExternalSchema(fkRef.options.schema)) continue;
			if (!tableSet.has(fkRef.target)) continue;

			const columns = fkRef.options.columns;
			if (!columns?.length) continue;
			const references = fkRef.options.references ?? ['id'];

			// Column-level ref() already derives navigable single-column relations.
			if (columns.length === 1 && references.length === 1) continue;

			const foreignKey = [...columns];
			const referencedKey = [...references];
			const belongsToName = deriveCompositeConstraintRelationName(
				// biome-ignore lint/style/noNonNullAssertion: foreignKey copies columns whose length is guaranteed >= 1 by the "if (!columns?.length) continue;" guard above
				foreignKey[0]!,
				fkRef.options,
			);
			const inverseName = fkRef.options.inverse ?? tableName;
			const isUnique = fkRef.options.unique ?? false;
			const inverseType: RelationType = isUnique ? 'hasOne' : 'hasMany';
			const inverseCardinality = isUnique ? 'one' : 'many';

			pushRelationIfAbsent(relations, relationKeys, {
				name: belongsToName,
				type: 'belongsTo',
				source: tableName,
				target: fkRef.target,
				foreignKey,
				targetKey: referencedKey,
				cardinality: 'one',
				optionality: fkRef.options.nullable ? 'optional' : 'required',
				includeStrategy: 'auto',
				filterStrategy: 'auto',
				joinDefault: 'auto',
			});

			pushRelationIfAbsent(relations, relationKeys, {
				name: inverseName,
				type: inverseType,
				source: fkRef.target,
				target: tableName,
				foreignKey,
				sourceKey: referencedKey,
				cardinality: inverseCardinality,
				optionality: 'optional',
				includeStrategy: 'auto',
				filterStrategy: 'auto',
				joinDefault: 'auto',
			});
		}
	}
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
		Map<
			string,
			{
				target: string;
				refs: readonly string[];
				schema?: string;
				nullable: boolean;
				unique: boolean;
				onDelete?: OnDeleteAction;
				onUpdate?: RefOptions['onUpdate'];
			}
		>
	>();
	const compositeExternalFkLookup = new Map<string, ForeignKeyIR[]>();
	for (const table of model.tables.values()) {
		const tableFks = new Map<
			string,
			{
				target: string;
				refs: readonly string[];
				schema?: string;
				nullable: boolean;
				unique: boolean;
				onDelete?: OnDeleteAction;
				onUpdate?: RefOptions['onUpdate'];
			}
		>();
		for (const fk of table.foreignKeys) {
			const externalSchema = normalizeReferenceSchema(fk.references.schema);
			if (externalSchema !== undefined && fk.columns.length > 1) {
				const tableCompositeFks =
					compositeExternalFkLookup.get(table.name) ?? [];
				tableCompositeFks.push({
					...fk,
					references: {
						...fk.references,
						schema: externalSchema,
					},
				});
				compositeExternalFkLookup.set(table.name, tableCompositeFks);
				continue;
			}

			// Existing per-column emission path for same-schema FKs and single-column external FKs.
			const fkColumn = fk.columns[0];
			if (!fkColumn) continue;

			// Find the column to check nullable/unique
			const column = table.columns.find((c) => c.name === fkColumn);
			tableFks.set(fkColumn, {
				target: fk.references.table,
				refs: fk.references.columns,
				...(externalSchema !== undefined ? { schema: externalSchema } : {}),
				nullable: column?.nullable ?? true,
				unique: column?.unique ?? false,
				...(fk.onDelete !== undefined ? { onDelete: fk.onDelete } : {}),
				...(fk.onUpdate !== undefined ? { onUpdate: fk.onUpdate } : {}),
			});
		}
		fkLookup.set(table.name, tableFks);
	}

	// Convert ModelIR to SchemaDefinition
	const definition: Record<string, TableDef> = {};
	const constraints: SchemaConstraints = {};

	for (const table of model.tables.values()) {
		const tableDef: TableDef = {};
		const tableFks = fkLookup.get(table.name) ?? new Map();
		const compositeExternalFks =
			compositeExternalFkLookup.get(table.name) ?? [];

		for (const column of table.columns) {
			const fk = tableFks.get(column.name);

			if (fk) {
				if (fk.schema !== undefined) {
					const sourceColumn: Mutable<Exclude<ColumnDef, SchemaColumnType>> = {
						type: columnTypeToJsType(column.type),
						nullable: fk.nullable,
					};
					if (fk.unique) sourceColumn.unique = true;
					tableDef[column.name] = sourceColumn;
					const tableConstraints = (constraints[table.name] ??= {});
					const foreignKeys = (tableConstraints.foreignKeys ??= []);
					foreignKeys.push(
						ref(fk.target, {
							schema: fk.schema,
							columns: [column.name],
							references: fk.refs,
							...(fk.onDelete !== undefined ? { onDelete: fk.onDelete } : {}),
							...(fk.onUpdate !== undefined ? { onUpdate: fk.onUpdate } : {}),
						}),
					);
					continue;
				}

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

		for (const fk of compositeExternalFks) {
			const externalSchema = fk.references.schema;
			if (externalSchema === undefined) continue;
			const tableConstraints = (constraints[table.name] ??= {});
			const foreignKeys = (tableConstraints.foreignKeys ??= []);
			foreignKeys.push(
				ref(fk.references.table, {
					schema: externalSchema,
					columns: fk.columns,
					references: fk.references.columns,
					...(fk.onDelete !== undefined ? { onDelete: fk.onDelete } : {}),
					...(fk.onUpdate !== undefined ? { onUpdate: fk.onUpdate } : {}),
				}),
			);
		}

		definition[table.name] = tableDef;
	}

	const tableNames = Object.keys(definition) as (keyof T)[];
	const generatedConstraints =
		Object.keys(constraints).length > 0 ? constraints : undefined;

	// Create type-safe tables proxy
	const tables = createTablesProxy(
		model,
		tableNames as string[],
	) as InferTables<T>;

	// Build result with optional properties only if defined
	const result: Mutable<Schema<T>> = {
		definition: definition as T,
		model,
		tableNames,
		tables,
	};

	// Add optional properties only if they have values
	if (generatedConstraints !== undefined) {
		result.constraints = generatedConstraints;
	}
	if (adapter.dbCasing !== undefined) {
		result.dbCasing = adapter.dbCasing;
	}
	if (introspectedAt !== undefined) {
		result.introspectedAt = introspectedAt;
	}

	return result;
}
