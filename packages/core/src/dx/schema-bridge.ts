/**
 * ARCH-002 Block 6: Schema Bridge
 *
 * Converts generated schema (from dbsp generate manifest) to ModelIR.
 * This enables sync createOrm usage with codegen-first schemas.
 */

import type { Mutable } from '@dbsp/types';
import * as v from 'valibot';
import { ModelIRImpl } from '../model-impl.js';
import {
	type Cardinality,
	type ColumnIR,
	type ColumnType,
	createPseudoColumnMetadata,
	type FilterStrategy,
	type ForeignKeyIR,
	type IncludeStrategy,
	type IndexIR,
	type JoinDefault,
	type ModelIR,
	type Optionality,
	type PseudoColumnMetadata,
	type RelationIR,
	type RelationType,
	type TableIR,
} from '../model-ir.js';
import type { ResolvedSchema } from '../schema-dsl-types.js';

// ============================================================================
// Generated Schema Types (from dbsp generate manifest)
// ============================================================================

/**
 * Column type in generated schema.
 */
export type GeneratedColumnType =
	| 'string'
	| 'text'
	| 'number'
	| 'integer'
	| 'bigint'
	| 'decimal'
	| 'boolean'
	| 'date'
	| 'timestamp'
	| 'datetime'
	| 'json'
	| 'uuid'
	| 'daterange'
	| 'tstzrange'
	| 'int4range';

/**
 * Column definition in generated schema.
 */
export interface GeneratedColumn {
	readonly type: GeneratedColumnType;
	readonly primaryKey?: boolean;
	readonly nullable?: boolean;
	readonly unique?: boolean;
	readonly autoIncrement?: boolean;
	readonly default?: string;
	readonly references?: {
		readonly table: string;
		readonly column?: string;
		readonly onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
		/** Role name for parent traversal in self-ref hierarchies (e.g., 'parent') */
		readonly parentRole?: string;
		/** Role name for child traversal in self-ref hierarchies (e.g., 'children') */
		readonly childRole?: string;
	};
	/** Create an index on this column (true for auto-name, string for custom name) */
	readonly index?: boolean | string;
}

/**
 * Table definition in generated schema.
 */
export type GeneratedTable = Record<string, GeneratedColumn>;

/**
 * Relation kind in generated schema (discriminated union).
 */
export type GeneratedRelationKind = 'belongsTo' | 'hasMany' | 'manyToMany';

/**
 * Include strategy for relations.
 */
export type GeneratedIncludeStrategy =
	| 'join'
	| 'subquery'
	| 'cte'
	| 'lateral'
	| 'json_agg'
	| 'auto';

/**
 * BelongsTo relation in generated schema.
 */
export interface GeneratedBelongsTo {
	readonly kind: 'belongsTo';
	readonly target: string;
	readonly foreignKey: string;
	readonly targetKey?: string;
	readonly includeStrategy?: GeneratedIncludeStrategy;
}

/**
 * HasMany relation in generated schema.
 */
export interface GeneratedHasMany {
	readonly kind: 'hasMany';
	readonly target: string;
	readonly foreignKey: string;
	readonly sourceKey?: string;
	readonly includeStrategy?: GeneratedIncludeStrategy;
	readonly cardinality?: 'one' | 'many';
}

/**
 * ManyToMany relation in generated schema.
 */
export interface GeneratedManyToMany {
	readonly kind: 'manyToMany';
	readonly target: string;
	readonly through: string;
	readonly sourceFk: string;
	readonly targetFk: string;
	readonly includeStrategy?: GeneratedIncludeStrategy;
}

/**
 * Relation definition in generated schema.
 */
export type GeneratedRelation =
	| GeneratedBelongsTo
	| GeneratedHasMany
	| GeneratedManyToMany;

/**
 * Hint definition in generated schema.
 */
export interface GeneratedHint {
	readonly defaultStrategy?: 'exists' | 'join';
	readonly cardinality?: 'one' | 'many';
}

/**
 * Conventions in generated schema.
 */
export interface GeneratedConventions {
	readonly fkPattern: string;
	readonly pluralize: boolean;
	readonly timestamps: readonly string[];
	readonly fkAutoIndex: boolean;
}

/**
 * Complete generated schema (output of dbsp generate manifest).
 *
 * @typeParam TTables - The tables type, preserving literal table names for autocomplete.
 *   When using `as const` on your schema definition, table names will be preserved.
 *
 * @example
 * ```typescript
 * const schema = {
 *   tables: {
 *     users: { id: { type: 'uuid', primaryKey: true }, name: { type: 'string' } },
 *     posts: { id: { type: 'uuid', primaryKey: true }, title: { type: 'string' } },
 *   },
 *   relations: {},
 *   hints: {},
 *   conventions: { fkPattern: '{singular}Id', pluralize: true, timestamps: [], fkAutoIndex: true },
 * } as const satisfies GeneratedSchema;
 *
 * // TypeScript knows: keyof typeof schema.tables = 'users' | 'posts'
 * ```
 */
export interface GeneratedSchema<
	TTables extends Record<string, GeneratedTable> = Record<
		string,
		GeneratedTable
	>,
> {
	readonly tables: TTables;
	readonly relations: Record<string, GeneratedRelation>;
	readonly hints: Record<string, GeneratedHint>;
	readonly conventions: GeneratedConventions;
}

// ============================================================================
// Type Utilities for Schema Inference
// ============================================================================

/**
 * Map a GeneratedColumnType to its TypeScript runtime type.
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
 * Infer the TypeScript row type from a GeneratedTable definition.
 */
export type InferRowType<T extends GeneratedTable> = {
	[K in keyof T]: T[K]['nullable'] extends true
		? ColumnTypeToTS<T[K]['type']> | null
		: ColumnTypeToTS<T[K]['type']>;
};

/**
 * Infer the database type from a GeneratedSchema.
 * Maps each table name to its row type.
 *
 * @example
 * ```typescript
 * const schema = { tables: { users: { id: { type: 'uuid' } } } } as const satisfies GeneratedSchema;
 * type DB = InferDBFromSchema<typeof schema>;
 * // DB = { users: { id: string } }
 * ```
 */
export type InferDBFromSchema<S extends GeneratedSchema> = {
	[TableName in keyof S['tables'] & string]: InferRowType<
		S['tables'][TableName]
	>;
};

// ============================================================================
// Conversion Functions
// ============================================================================

/**
 * Map generated column type to ModelIR column type.
 */
function generatedTypeToColumnType(genType: GeneratedColumnType): ColumnType {
	switch (genType) {
		case 'string':
		case 'text':
			return 'string';
		case 'number':
		case 'decimal':
			return 'number';
		case 'integer':
			return 'integer';
		case 'bigint':
			return 'bigint';
		case 'boolean':
			return 'boolean';
		case 'date':
			return 'date';
		case 'timestamp':
		case 'datetime':
			return 'datetime';
		case 'json':
			return 'json';
		case 'uuid':
			return 'uuid';
		case 'daterange':
			return 'daterange';
		case 'tstzrange':
			return 'tstzrange';
		case 'int4range':
			return 'int4range';
	}
}

/**
 * Map generated relation kind to ModelIR relation type.
 */
function mapRelationType(kind: GeneratedRelationKind): RelationType {
	switch (kind) {
		case 'belongsTo':
			return 'belongsTo';
		case 'hasMany':
			return 'hasMany';
		case 'manyToMany':
			return 'belongsToMany';
	}
}

/**
 * Build a TableIR from generated table definition.
 */
function buildTableIRFromDefinition(
	tableName: string,
	genTable: GeneratedTable,
	fkAutoIndex: boolean,
): TableIR {
	const columns: ColumnIR[] = [];
	const foreignKeys: ForeignKeyIR[] = [];
	const indexes: IndexIR[] = [];
	const primaryKeys: string[] = [];
	// Track columns that already have explicit indexes
	const indexedColumns = new Set<string>();

	for (const [colName, colDef] of Object.entries(genTable)) {
		// Column (with unique support)
		const col: Mutable<ColumnIR> = {
			name: colName,
			type: generatedTypeToColumnType(colDef.type),
			nullable: colDef.nullable ?? false,
			default: colDef.default,
		};
		if (colDef.unique !== undefined) {
			col.unique = colDef.unique;
		}
		if (colDef.autoIncrement !== undefined) {
			col.autoIncrement = colDef.autoIncrement;
		}
		columns.push(col);

		// Primary key
		if (colDef.primaryKey) {
			primaryKeys.push(colName);
		}

		// Foreign key (with onDelete support)
		if (colDef.references) {
			const fk: Mutable<ForeignKeyIR> = {
				columns: [colName],
				references: {
					table: colDef.references.table,
					columns: [colDef.references.column ?? 'id'],
				},
			};
			if (colDef.references.onDelete) {
				fk.onDelete = colDef.references.onDelete;
			}
			foreignKeys.push(fk);
		}

		// Column-level index (explicit)
		if (colDef.index) {
			const indexName =
				typeof colDef.index === 'string'
					? colDef.index
					: `idx_${tableName}_${colName}`;
			indexes.push({
				name: indexName,
				columns: [colName],
				unique: false,
			});
			indexedColumns.add(colName);
		}

		// Auto-index for FK columns if fkAutoIndex is enabled and no explicit index
		if (fkAutoIndex && colDef.references && !colDef.index) {
			indexes.push({
				name: `idx_${tableName}_${colName}`,
				columns: [colName],
				unique: false,
			});
			indexedColumns.add(colName);
		}
	}

	// Extract pseudo-columns from self-referential FKs
	const pseudoColumns: PseudoColumnMetadata[] = [];
	for (const fk of foreignKeys) {
		// Check if FK points to same table (self-referential)
		const fkColumn = fk.columns[0];
		const targetColumn = fk.references.columns[0];
		if (
			fk.references.table === tableName &&
			fkColumn !== undefined &&
			targetColumn !== undefined
		) {
			// Get column definition for role extraction
			const colDef = genTable[fkColumn];
			// Infer role names from column name or explicit references
			const inferredName = fkColumn.endsWith('Id')
				? fkColumn.slice(0, -2)
				: 'parent';
			const parentRole = colDef?.references?.parentRole ?? inferredName;
			const childRole =
				colDef?.references?.childRole ??
				(parentRole === 'parent' ? 'children' : `${parentRole}s`);

			pseudoColumns.push(
				createPseudoColumnMetadata(
					tableName,
					fkColumn,
					targetColumn,
					parentRole,
					childRole,
				),
			);
		}
	}

	// Determine PK: explicit > composite FK > 'id' column > omit
	let primaryKey: string | readonly string[] | undefined;
	if (primaryKeys.length > 0) {
		primaryKey =
			primaryKeys.length === 1 ? (primaryKeys[0] as string) : primaryKeys;
	} else {
		// No explicit PK — infer from FK columns or 'id'
		const fkColumns = foreignKeys.flatMap((fk) => fk.columns);
		if (fkColumns.length > 0) {
			primaryKey = fkColumns.length === 1 ? fkColumns[0] : fkColumns;
		} else {
			const hasId = columns.some((c) => c.name === 'id');
			primaryKey = hasId ? 'id' : undefined;
		}
	}

	// Freeze columns array for runtime immutability
	const frozenColumns = Object.freeze(columns);

	// Freeze and return the table object
	return Object.freeze({
		name: tableName,
		columns: frozenColumns,
		...(primaryKey !== undefined ? { primaryKey } : {}),
		foreignKeys: Object.freeze(foreignKeys),
		indexes: Object.freeze(indexes),
		...(pseudoColumns.length > 0 && {
			pseudoColumns: Object.freeze(pseudoColumns),
		}),
	});
}

/**
 * Build a RelationIR from generated relation definition.
 */
function buildRelationIR(
	qualifiedName: string,
	genRelation: GeneratedRelation,
	hints: Record<string, GeneratedHint>,
): RelationIR {
	// Extract source table and relation name from qualified name (e.g., "posts.author")
	const dotIndex = qualifiedName.indexOf('.');
	const sourceTable =
		dotIndex > 0 ? qualifiedName.slice(0, dotIndex) : qualifiedName;
	const relationName =
		dotIndex > 0 ? qualifiedName.slice(dotIndex + 1) : qualifiedName;

	// Get hints for this relation
	const hint = hints[qualifiedName];
	// Check cardinality from: hint > relation definition > inferred from kind
	const relCardinality =
		genRelation.kind === 'hasMany'
			? (genRelation as GeneratedHasMany).cardinality
			: undefined;
	const cardinality: Cardinality =
		hint?.cardinality === 'one'
			? 'one'
			: relCardinality === 'one'
				? 'one'
				: genRelation.kind === 'belongsTo'
					? 'one'
					: 'many';

	// Determine optionality from nullable FK (for belongsTo) or default to 'optional' for hasMany
	const optionality: Optionality =
		genRelation.kind === 'belongsTo' ? 'optional' : 'optional';

	// Determine relation type - hasMany with cardinality 'one' becomes 'hasOne'
	let relationType = mapRelationType(genRelation.kind);
	if (genRelation.kind === 'hasMany' && cardinality === 'one') {
		relationType = 'hasOne';
	}

	// Build base relation
	const baseRelation = {
		name: relationName,
		source: sourceTable,
		target: genRelation.target,
		type: relationType,
		cardinality,
		optionality,
		includeStrategy: (genRelation.includeStrategy ?? 'auto') as IncludeStrategy,
		filterStrategy: (hint?.defaultStrategy ?? 'auto') as FilterStrategy,
		joinDefault: 'auto' as JoinDefault,
	};

	// Add relation-specific fields
	switch (genRelation.kind) {
		case 'belongsTo':
			return {
				...baseRelation,
				foreignKey: genRelation.foreignKey,
			};
		case 'hasMany':
			return {
				...baseRelation,
				foreignKey: genRelation.foreignKey,
			};
		case 'manyToMany':
			return {
				...baseRelation,
				through: genRelation.through,
				foreignKey: genRelation.sourceFk,
				otherKey: genRelation.targetFk,
			};
	}
}

/**
 * Build a ModelIR from a generated schema.
 *
 * This is the main entry point for the schema bridge.
 * It converts the output of `dbsp generate manifest` into a ModelIR
 * that can be used with createOrm.
 *
 * @example
 * ```typescript
 * import { schema } from './generated/dbsp/schema';
 * import { buildModelFromSchema, createOrm } from '@dbsp/core';
 *
 * const model = buildModelFromSchema(schema);
 * const orm = createOrm({ model, adapter });
 * ```
 */
export function buildModelFromSchema(schema: GeneratedSchema): ModelIR {
	const tables = new Map<string, TableIR>();
	const relations = new Map<string, RelationIR>();
	const fkAutoIndex = schema.conventions.fkAutoIndex;

	// Build tables
	for (const [tableName, genTable] of Object.entries(schema.tables)) {
		tables.set(
			tableName,
			buildTableIRFromDefinition(tableName, genTable, fkAutoIndex),
		);
	}

	// Build relations
	for (const [qualifiedName, genRelation] of Object.entries(schema.relations)) {
		relations.set(
			qualifiedName,
			buildRelationIR(qualifiedName, genRelation, schema.hints),
		);
	}

	return new ModelIRImpl(tables, relations);
}

/**
 * Build ModelIR directly from ResolvedSchema.
 *
 * Combines the conversion steps: ResolvedSchema → GeneratedSchema → ModelIR.
 * This is the canonical path for creating ModelIR from user-defined schemas.
 *
 * @example
 * ```typescript
 * import { defineSchema, buildModelFromResolvedSchema } from '@dbsp/core';
 *
 * const schema = defineSchema({ users: { ... } }, { relations: { ... } });
 * const model = buildModelFromResolvedSchema(schema);
 * ```
 */
export function buildModelFromResolvedSchema(schema: ResolvedSchema): ModelIR {
	const generatedSchema = assertResolvedSchemaToGeneratedSchema(schema);
	return buildModelFromSchema(generatedSchema);
}

/**
 * Type guard for GeneratedSchema.
 *
 * Note: Both GeneratedSchema and ResolvedSchema have the same structure,
 * so this check will return true for both. Use `isResolvedSchema()` to
 * specifically detect ResolvedSchema (from @dbsp/schema).
 */
export function isGeneratedSchema(value: unknown): value is GeneratedSchema {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const obj = value as Record<string, unknown>;
	return (
		typeof obj.tables === 'object' &&
		obj.tables !== null &&
		typeof obj.relations === 'object' &&
		obj.relations !== null &&
		typeof obj.hints === 'object' &&
		obj.hints !== null &&
		typeof obj.conventions === 'object' &&
		obj.conventions !== null
	);
}

/**
 * Column types that exist only in ResolvedSchema (from @dbsp/schema).
 * These types are PostgreSQL-specific and not present in GeneratedSchema.
 */
const RESOLVED_SCHEMA_ONLY_TYPES = new Set(['time', 'jsonb']);

/**
 * Column types that exist only in GeneratedSchema.
 * These are dialect-agnostic types not present in ResolvedSchema.
 */
const GENERATED_SCHEMA_ONLY_TYPES = new Set(['number', 'datetime']);

/**
 * Check if any column in the schema has a type only found in ResolvedSchema.
 */
function hasResolvedSchemaOnlyTypes(
	tables: Record<string, Record<string, { type?: string }>>,
): boolean {
	for (const table of Object.values(tables)) {
		for (const column of Object.values(table)) {
			if (column?.type && RESOLVED_SCHEMA_ONLY_TYPES.has(column.type)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Check if any column in the schema has a type only found in GeneratedSchema.
 */
function hasGeneratedSchemaOnlyTypes(
	tables: Record<string, Record<string, { type?: string }>>,
): boolean {
	for (const table of Object.values(tables)) {
		for (const column of Object.values(table)) {
			if (column?.type && GENERATED_SCHEMA_ONLY_TYPES.has(column.type)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Type guard for ResolvedSchema (from @dbsp/schema).
 *
 * Detects ResolvedSchema by checking for PostgreSQL-specific column types
 * like 'time' and 'jsonb' that only exist in ResolvedSchema.
 *
 * Note: If the schema has no such types, this may return false even for
 * a valid ResolvedSchema. In that case, the schema can be used directly
 * as a GeneratedSchema since both have the same structure.
 */
export function isResolvedSchema(value: unknown): boolean {
	if (!isGeneratedSchema(value)) {
		return false;
	}
	// If it has ResolvedSchema-only types, it's definitely a ResolvedSchema
	if (
		hasResolvedSchemaOnlyTypes(
			value.tables as Record<string, Record<string, { type?: string }>>,
		)
	) {
		return true;
	}
	// If it has GeneratedSchema-only types, it's definitely NOT a ResolvedSchema
	if (
		hasGeneratedSchemaOnlyTypes(
			value.tables as Record<string, Record<string, { type?: string }>>,
		)
	) {
		return false;
	}
	// Ambiguous case: no distinguishing types. Assume GeneratedSchema (more common at runtime).
	return false;
}

/**
 * Normalize a schema input to GeneratedSchema.
 *
 * This function accepts either a GeneratedSchema or a ResolvedSchema
 * and returns a GeneratedSchema. If the input is already a GeneratedSchema,
 * it is returned as-is. If it's a ResolvedSchema, it is converted.
 *
 * This is the recommended way to accept schemas in APIs that need to
 * support both schema formats transparently.
 *
 * @param input - Either a GeneratedSchema or ResolvedSchema
 * @returns GeneratedSchema (possibly converted from ResolvedSchema)
 * @throws Error if the input is not a valid schema
 *
 * @example
 * ```typescript
 * import { normalizeSchema } from '@dbsp/core';
 *
 * // Works with GeneratedSchema (from codegen)
 * const schema1 = normalizeSchema(generatedSchema);
 *
 * // Works with ResolvedSchema (from defineSchema())
 * const schema2 = normalizeSchema(resolvedSchema);
 * ```
 */
export function normalizeSchema(input: unknown): GeneratedSchema {
	// First check if it has the basic structure
	if (!isGeneratedSchema(input)) {
		throw new Error(
			'Invalid schema: must have tables, relations, hints, and conventions properties',
		);
	}

	// Check if it looks like a ResolvedSchema (has PostgreSQL-specific types)
	if (isResolvedSchema(input)) {
		// Convert using the existing converter
		const result = resolvedSchemaToGeneratedSchema(input);
		if (!result.success) {
			const messages = result.errors.map((e) => e.message).join(', ');
			throw new Error(`Schema conversion failed: ${messages}`);
		}
		return result.schema;
	}

	// Already a GeneratedSchema (or ambiguous but structurally valid)
	return input;
}

// ============================================================================
// Valibot Validation Schemas (CORE-005)
// ============================================================================

/**
 * Schema column type from @dbsp/schema
 */
const SchemaColumnTypeSchema = v.picklist([
	'uuid',
	'string',
	'text',
	'integer',
	'bigint',
	'decimal',
	'boolean',
	'timestamp',
	'date',
	'time',
	'json',
	'jsonb',
	'daterange',
	'tstzrange',
	'int4range',
]);

/**
 * Foreign key reference schema
 */
const ForeignKeyReferenceSchema = v.object({
	table: v.string(),
	column: v.optional(v.string()),
	onDelete: v.optional(
		v.picklist(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION']),
	),
	parentRole: v.optional(v.string()),
	childRole: v.optional(v.string()),
});

/**
 * Column definition schema (from @dbsp/schema)
 */
const ColumnDefinitionSchema = v.object({
	type: SchemaColumnTypeSchema,
	primaryKey: v.optional(v.boolean()),
	nullable: v.optional(v.boolean()),
	unique: v.optional(v.boolean()),
	autoIncrement: v.optional(v.boolean()),
	default: v.optional(v.union([v.string(), v.number(), v.boolean()])),
	references: v.optional(ForeignKeyReferenceSchema),
	index: v.optional(v.union([v.boolean(), v.string()])),
});

/**
 * Table definition schema - flat format (column name -> column def).
 */
const FlatTableDefinitionSchema = v.record(v.string(), ColumnDefinitionSchema);

/**
 * Table definition with config - supports composite primary keys.
 * Format: { columns: { col1: ColumnDef }, primaryKey: ['col1', 'col2'] }
 */
const TableDefWithConfigSchema = v.object({
	columns: FlatTableDefinitionSchema,
	primaryKey: v.array(v.string()),
	indexes: v.optional(
		v.array(
			v.object({
				columns: v.array(v.string()),
				unique: v.optional(v.boolean()),
				name: v.optional(v.string()),
			}),
		),
	),
});

/**
 * Table definition schema - accepts both flat and with-config formats.
 */
const TableDefinitionSchema = v.union([
	TableDefWithConfigSchema,
	FlatTableDefinitionSchema,
]);

/**
 * Tables definition schema
 */
const TablesDefinitionSchema = v.record(v.string(), TableDefinitionSchema);

/**
 * BelongsTo relation schema
 */
/**
 * Include strategy schema for relations
 */
const IncludeStrategySchema = v.optional(
	v.picklist(['join', 'subquery', 'cte', 'lateral', 'json_agg', 'auto']),
);

const BelongsToRelationSchema = v.object({
	kind: v.literal('belongsTo'),
	target: v.string(),
	foreignKey: v.string(),
	targetKey: v.optional(v.string()),
	includeStrategy: IncludeStrategySchema,
});

/**
 * HasMany relation schema
 */
const HasManyRelationSchema = v.object({
	kind: v.literal('hasMany'),
	target: v.string(),
	foreignKey: v.string(),
	sourceKey: v.optional(v.string()),
	includeStrategy: IncludeStrategySchema,
});

/**
 * ManyToMany relation schema
 */
const ManyToManyRelationSchema = v.object({
	kind: v.literal('manyToMany'),
	target: v.string(),
	through: v.string(),
	sourceFk: v.string(),
	targetFk: v.string(),
	includeStrategy: IncludeStrategySchema,
});

/**
 * Relation definition schema (discriminated union)
 */
const RelationDefinitionSchema = v.variant('kind', [
	BelongsToRelationSchema,
	HasManyRelationSchema,
	ManyToManyRelationSchema,
]);

/**
 * Relations definition schema
 */
const RelationsDefinitionSchema = v.record(
	v.string(),
	RelationDefinitionSchema,
);

/**
 * Hint definition schema
 */
const HintDefinitionSchema = v.object({
	defaultStrategy: v.optional(v.picklist(['exists', 'join'])),
	cardinality: v.optional(v.picklist(['one', 'many'])),
});

/**
 * Hints definition schema
 */
const HintsDefinitionSchema = v.record(v.string(), HintDefinitionSchema);

/**
 * Conventions definition schema (resolved = all required)
 */
const ConventionsDefinitionSchema = v.object({
	fkPattern: v.string(),
	pluralize: v.boolean(),
	timestamps: v.array(v.string()),
	fkAutoIndex: v.boolean(),
});

/**
 * Index definition schema
 */
const IndexDefinitionSchema = v.object({
	columns: v.array(v.string()),
	unique: v.optional(v.boolean()),
	name: v.optional(v.string()),
});

/**
 * Indexes definition schema - mapping table name to array of indexes
 */
const IndexesDefinitionSchema = v.record(
	v.string(),
	v.array(IndexDefinitionSchema),
);

/**
 * Complete ResolvedSchema validation schema
 */
export const ResolvedSchemaValidation = v.object({
	tables: TablesDefinitionSchema,
	relations: RelationsDefinitionSchema,
	hints: HintsDefinitionSchema,
	conventions: ConventionsDefinitionSchema,
	indexes: v.optional(IndexesDefinitionSchema),
});

/**
 * Type inferred from ResolvedSchemaValidation
 */
export type ValidatedResolvedSchema = v.InferOutput<
	typeof ResolvedSchemaValidation
>;

// ============================================================================
// ResolvedSchema → GeneratedSchema Converter (CORE-005)
// ============================================================================

/**
 * Map schema column type to generated column type.
 * Handles type differences between the two systems.
 */
function mapSchemaColumnType(
	schemaType: v.InferOutput<typeof SchemaColumnTypeSchema>,
): GeneratedColumnType {
	switch (schemaType) {
		case 'uuid':
			return 'uuid';
		case 'string':
			return 'string';
		case 'text':
			return 'text';
		case 'integer':
			return 'integer';
		case 'bigint':
			return 'bigint';
		case 'decimal':
			return 'decimal';
		case 'boolean':
			return 'boolean';
		case 'timestamp':
			return 'timestamp';
		case 'date':
			return 'date';
		case 'time':
			// 'time' maps to 'timestamp' (closest match in GeneratedColumnType)
			return 'timestamp';
		case 'json':
			return 'json';
		case 'jsonb':
			// 'jsonb' maps to 'json' (GeneratedColumnType doesn't distinguish)
			return 'json';
		case 'daterange':
			return 'daterange';
		case 'tstzrange':
			return 'tstzrange';
		case 'int4range':
			return 'int4range';
	}
}

/**
 * Convert a validated column definition to GeneratedColumn.
 */
function convertColumn(
	col: v.InferOutput<typeof ColumnDefinitionSchema>,
): GeneratedColumn {
	const result: Mutable<GeneratedColumn> = {
		type: mapSchemaColumnType(col.type),
	};
	if (col.primaryKey !== undefined) {
		result.primaryKey = col.primaryKey;
	}
	if (col.nullable !== undefined) {
		result.nullable = col.nullable;
	}
	if (col.unique !== undefined) {
		result.unique = col.unique;
	}
	if (col.autoIncrement !== undefined) {
		result.autoIncrement = col.autoIncrement;
	}
	if (col.default !== undefined) {
		result.default = col.default as string;
	}
	if (col.references) {
		const refs: { table: string; column?: string } = {
			table: col.references.table,
		};
		if (col.references.column !== undefined) {
			refs.column = col.references.column;
		}
		result.references = refs;
	}
	return result as GeneratedColumn;
}

/**
 * Convert a validated relation definition to GeneratedRelation.
 */
function convertRelation(
	rel: v.InferOutput<typeof RelationDefinitionSchema>,
): GeneratedRelation {
	switch (rel.kind) {
		case 'belongsTo': {
			const result: Mutable<GeneratedBelongsTo> = {
				kind: 'belongsTo',
				target: rel.target,
				foreignKey: rel.foreignKey,
			};
			if (rel.targetKey !== undefined) {
				result.targetKey = rel.targetKey;
			}
			if (rel.includeStrategy !== undefined) {
				result.includeStrategy = rel.includeStrategy;
			}
			return result as GeneratedBelongsTo;
		}
		case 'hasMany': {
			const result: Mutable<GeneratedHasMany> = {
				kind: 'hasMany',
				target: rel.target,
				foreignKey: rel.foreignKey,
			};
			if (rel.sourceKey !== undefined) {
				result.sourceKey = rel.sourceKey;
			}
			if (rel.includeStrategy !== undefined) {
				result.includeStrategy = rel.includeStrategy;
			}
			return result as GeneratedHasMany;
		}
		case 'manyToMany': {
			const result: Mutable<GeneratedManyToMany> = {
				kind: 'manyToMany',
				target: rel.target,
				through: rel.through,
				sourceFk: rel.sourceFk,
				targetFk: rel.targetFk,
			};
			if (rel.includeStrategy !== undefined) {
				result.includeStrategy = rel.includeStrategy;
			}
			return result as GeneratedManyToMany;
		}
	}
}

/**
 * Convert a validated hint definition to GeneratedHint.
 */
function convertHint(
	hint: v.InferOutput<typeof HintDefinitionSchema>,
): GeneratedHint {
	const result: Mutable<GeneratedHint> = {};
	if (hint.defaultStrategy !== undefined) {
		result.defaultStrategy = hint.defaultStrategy;
	}
	if (hint.cardinality !== undefined) {
		result.cardinality = hint.cardinality;
	}
	return result as GeneratedHint;
}

/**
 * Result of schema conversion.
 */
export type SchemaConversionResult =
	| { success: true; schema: GeneratedSchema }
	| { success: false; errors: v.BaseIssue<unknown>[] };

/**
 * Convert a ResolvedSchema (from @dbsp/schema) to GeneratedSchema.
 *
 * This function validates the input using Valibot and then converts the
 * schema structure to the format expected by createOrm().
 *
 * @param input - The ResolvedSchema to convert (output of defineSchema())
 * @returns Conversion result with either the converted schema or validation errors
 *
 * @example
 * ```typescript
 * import { defineSchema } from '@dbsp/schema';
 * import { resolvedSchemaToGeneratedSchema, createOrm } from '@dbsp/core';
 *
 * const resolved = defineSchema({ tables: { users: { id: { type: 'uuid' } } } });
 * const result = resolvedSchemaToGeneratedSchema(resolved);
 *
 * if (result.success) {
 *   const orm = createOrm({ schema: result.schema, adapter });
 * } else {
 *   console.error('Schema validation failed:', result.errors);
 * }
 * ```
 */
export function resolvedSchemaToGeneratedSchema(
	input: unknown,
): SchemaConversionResult {
	// Validate input
	const parseResult = v.safeParse(ResolvedSchemaValidation, input);

	if (!parseResult.success) {
		return {
			success: false,
			errors: parseResult.issues,
		};
	}

	const validated = parseResult.output;

	// Convert tables (handles both flat and with-config formats)
	const tables: Record<string, GeneratedTable> = {};
	for (const [tableName, tableDef] of Object.entries(validated.tables)) {
		const convertedTable: Record<string, GeneratedColumn> = {};

		// Check if this is the with-config format (has 'columns' property)
		const isWithConfig =
			tableDef !== null &&
			typeof tableDef === 'object' &&
			'columns' in tableDef &&
			typeof tableDef.columns === 'object';

		const tableObj = tableDef as Record<string, unknown>;
		const columns = isWithConfig
			? (tableObj.columns as Record<string, unknown>)
			: tableObj;

		for (const [colName, colDef] of Object.entries(columns)) {
			convertedTable[colName] = convertColumn(
				colDef as v.InferOutput<typeof ColumnDefinitionSchema>,
			);
		}
		tables[tableName] = convertedTable;
	}

	// Convert relations
	const relations: Record<string, GeneratedRelation> = {};
	for (const [relName, relDef] of Object.entries(validated.relations)) {
		relations[relName] = convertRelation(relDef);
	}

	// Convert hints
	const hints: Record<string, GeneratedHint> = {};
	for (const [hintName, hintDef] of Object.entries(validated.hints)) {
		hints[hintName] = convertHint(hintDef);
	}

	// Convert conventions
	const conventions: GeneratedConventions = {
		fkPattern: validated.conventions.fkPattern,
		pluralize: validated.conventions.pluralize,
		timestamps: validated.conventions.timestamps,
		fkAutoIndex: validated.conventions.fkAutoIndex,
	};

	return {
		success: true,
		schema: {
			tables,
			relations,
			hints,
			conventions,
		},
	};
}

/**
 * Assert and convert a ResolvedSchema to GeneratedSchema.
 *
 * Throws an error if validation fails. Use this when you're confident
 * the input is valid and want cleaner code without result checking.
 *
 * @param input - The ResolvedSchema to convert
 * @returns The converted GeneratedSchema
 * @throws Error if validation fails
 */
export function assertResolvedSchemaToGeneratedSchema(
	input: unknown,
): GeneratedSchema {
	const result = resolvedSchemaToGeneratedSchema(input);
	if (!result.success) {
		const messages = result.errors
			.map((e) => {
				const path = e.path?.map((p) => p.key).join('.') || 'root';
				return `[${path}] ${e.message} (expected: ${e.expected}, received: ${e.received})`;
			})
			.join('\n');
		throw new Error(`Schema validation failed:\n${messages}`);
	}
	return result.schema;
}
