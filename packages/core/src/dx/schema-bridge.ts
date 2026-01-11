/**
 * ARCH-002 Block 6: Schema Bridge
 *
 * Converts generated schema (from dbsp generate manifest) to ModelIR.
 * This enables sync createOrm usage with codegen-first schemas.
 */

import * as v from 'valibot';
import { ModelIRImpl } from '../model-impl.js';
import type {
	Cardinality,
	ColumnIR,
	ColumnType,
	FilterStrategy,
	ForeignKeyIR,
	IncludeStrategy,
	JoinDefault,
	ModelIR,
	Optionality,
	RelationIR,
	RelationType,
	TableIR,
} from '../model-ir.js';

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
	| 'uuid';

/**
 * Column definition in generated schema.
 */
export interface GeneratedColumn {
	readonly type: GeneratedColumnType;
	readonly primaryKey?: boolean;
	readonly nullable?: boolean;
	readonly unique?: boolean;
	readonly default?: string;
	readonly references?: {
		readonly table: string;
		readonly column?: string;
	};
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
 * BelongsTo relation in generated schema.
 */
export interface GeneratedBelongsTo {
	readonly kind: 'belongsTo';
	readonly target: string;
	readonly foreignKey: string;
	readonly targetKey?: string;
}

/**
 * HasMany relation in generated schema.
 */
export interface GeneratedHasMany {
	readonly kind: 'hasMany';
	readonly target: string;
	readonly foreignKey: string;
	readonly sourceKey?: string;
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
}

/**
 * Complete generated schema (output of dbsp generate manifest).
 */
export interface GeneratedSchema {
	readonly tables: Record<string, GeneratedTable>;
	readonly relations: Record<string, GeneratedRelation>;
	readonly hints: Record<string, GeneratedHint>;
	readonly conventions: GeneratedConventions;
}

// ============================================================================
// Conversion Functions
// ============================================================================

/**
 * Map generated column type to ModelIR column type.
 */
function mapColumnType(genType: GeneratedColumnType): ColumnType {
	switch (genType) {
		case 'string':
		case 'text':
			return 'string';
		case 'number':
		case 'integer':
		case 'decimal':
			return 'number';
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
function buildTableIR(tableName: string, genTable: GeneratedTable): TableIR {
	const columns: ColumnIR[] = [];
	const foreignKeys: ForeignKeyIR[] = [];
	const primaryKeys: string[] = [];

	for (const [colName, colDef] of Object.entries(genTable)) {
		// Column
		columns.push({
			name: colName,
			type: mapColumnType(colDef.type),
			nullable: colDef.nullable ?? false,
			default: colDef.default,
		});

		// Primary key
		if (colDef.primaryKey) {
			primaryKeys.push(colName);
		}

		// Foreign key
		if (colDef.references) {
			foreignKeys.push({
				columns: [colName],
				references: {
					table: colDef.references.table,
					columns: [colDef.references.column ?? 'id'],
				},
			});
		}
	}

	// Determine primary key - fallback to 'id' if not defined
	let primaryKey: string | readonly string[];
	if (primaryKeys.length === 0) {
		// Fallback: check if 'id' column exists, otherwise use first column
		const hasId = columns.some((c) => c.name === 'id');
		primaryKey = hasId ? 'id' : (columns[0]?.name ?? 'id');
	} else if (primaryKeys.length === 1) {
		// TypeScript needs explicit type assertion here
		primaryKey = primaryKeys[0] as string;
	} else {
		primaryKey = primaryKeys;
	}

	return {
		name: tableName,
		columns,
		primaryKey,
		foreignKeys,
	};
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
	const cardinality: Cardinality =
		hint?.cardinality === 'one'
			? 'one'
			: genRelation.kind === 'belongsTo'
				? 'one'
				: 'many';

	// Determine optionality from nullable FK (for belongsTo) or default to 'optional' for hasMany
	const optionality: Optionality =
		genRelation.kind === 'belongsTo' ? 'optional' : 'optional';

	// Build base relation
	const baseRelation = {
		name: relationName,
		source: sourceTable,
		target: genRelation.target,
		type: mapRelationType(genRelation.kind),
		cardinality,
		optionality,
		includeStrategy: 'auto' as IncludeStrategy,
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
 * import { buildModelFromSchema, createOrm } from '@db-semantic-planner/core';
 *
 * const model = buildModelFromSchema(schema);
 * const orm = createOrm({ model, adapter });
 * ```
 */
export function buildModelFromSchema(schema: GeneratedSchema): ModelIR {
	const tables = new Map<string, TableIR>();
	const relations = new Map<string, RelationIR>();

	// Build tables
	for (const [tableName, genTable] of Object.entries(schema.tables)) {
		tables.set(tableName, buildTableIR(tableName, genTable));
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
 * Type guard for GeneratedSchema.
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

// ============================================================================
// Valibot Validation Schemas (CORE-005)
// ============================================================================

/**
 * Schema column type from @db-semantic-planner/schema
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
]);

/**
 * Foreign key reference schema
 */
const ForeignKeyReferenceSchema = v.object({
	table: v.string(),
	column: v.optional(v.string()),
});

/**
 * Column definition schema (from @db-semantic-planner/schema)
 */
const ColumnDefinitionSchema = v.object({
	type: SchemaColumnTypeSchema,
	primaryKey: v.optional(v.boolean()),
	nullable: v.optional(v.boolean()),
	unique: v.optional(v.boolean()),
	default: v.optional(v.string()),
	references: v.optional(ForeignKeyReferenceSchema),
});

/**
 * Table definition schema
 */
const TableDefinitionSchema = v.record(v.string(), ColumnDefinitionSchema);

/**
 * Tables definition schema
 */
const TablesDefinitionSchema = v.record(v.string(), TableDefinitionSchema);

/**
 * BelongsTo relation schema
 */
const BelongsToRelationSchema = v.object({
	kind: v.literal('belongsTo'),
	target: v.string(),
	foreignKey: v.string(),
	targetKey: v.optional(v.string()),
});

/**
 * HasMany relation schema
 */
const HasManyRelationSchema = v.object({
	kind: v.literal('hasMany'),
	target: v.string(),
	foreignKey: v.string(),
	sourceKey: v.optional(v.string()),
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
});

/**
 * Complete ResolvedSchema validation schema
 */
export const ResolvedSchemaValidation = v.object({
	tables: TablesDefinitionSchema,
	relations: RelationsDefinitionSchema,
	hints: HintsDefinitionSchema,
	conventions: ConventionsDefinitionSchema,
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
	}
}

/**
 * Convert a validated column definition to GeneratedColumn.
 */
function convertColumn(
	col: v.InferOutput<typeof ColumnDefinitionSchema>,
): GeneratedColumn {
	const result: GeneratedColumn = {
		type: mapSchemaColumnType(col.type),
	};
	if (col.primaryKey !== undefined) {
		(result as { primaryKey?: boolean }).primaryKey = col.primaryKey;
	}
	if (col.nullable !== undefined) {
		(result as { nullable?: boolean }).nullable = col.nullable;
	}
	if (col.unique !== undefined) {
		(result as { unique?: boolean }).unique = col.unique;
	}
	if (col.default !== undefined) {
		(result as { default?: string }).default = col.default;
	}
	if (col.references) {
		const refs: { table: string; column?: string } = {
			table: col.references.table,
		};
		if (col.references.column !== undefined) {
			refs.column = col.references.column;
		}
		(result as { references?: { table: string; column?: string } }).references =
			refs;
	}
	return result;
}

/**
 * Convert a validated relation definition to GeneratedRelation.
 */
function convertRelation(
	rel: v.InferOutput<typeof RelationDefinitionSchema>,
): GeneratedRelation {
	switch (rel.kind) {
		case 'belongsTo': {
			const result: GeneratedBelongsTo = {
				kind: 'belongsTo',
				target: rel.target,
				foreignKey: rel.foreignKey,
			};
			if (rel.targetKey !== undefined) {
				(result as { targetKey?: string }).targetKey = rel.targetKey;
			}
			return result;
		}
		case 'hasMany': {
			const result: GeneratedHasMany = {
				kind: 'hasMany',
				target: rel.target,
				foreignKey: rel.foreignKey,
			};
			if (rel.sourceKey !== undefined) {
				(result as { sourceKey?: string }).sourceKey = rel.sourceKey;
			}
			return result;
		}
		case 'manyToMany':
			return {
				kind: 'manyToMany',
				target: rel.target,
				through: rel.through,
				sourceFk: rel.sourceFk,
				targetFk: rel.targetFk,
			};
	}
}

/**
 * Convert a validated hint definition to GeneratedHint.
 */
function convertHint(
	hint: v.InferOutput<typeof HintDefinitionSchema>,
): GeneratedHint {
	const result: GeneratedHint = {};
	if (hint.defaultStrategy !== undefined) {
		(result as { defaultStrategy?: 'exists' | 'join' }).defaultStrategy =
			hint.defaultStrategy;
	}
	if (hint.cardinality !== undefined) {
		(result as { cardinality?: 'one' | 'many' }).cardinality = hint.cardinality;
	}
	return result;
}

/**
 * Result of schema conversion.
 */
export type SchemaConversionResult =
	| { success: true; schema: GeneratedSchema }
	| { success: false; errors: v.BaseIssue<unknown>[] };

/**
 * Convert a ResolvedSchema (from @db-semantic-planner/schema) to GeneratedSchema.
 *
 * This function validates the input using Valibot and then converts the
 * schema structure to the format expected by createOrm().
 *
 * @param input - The ResolvedSchema to convert (output of defineSchema())
 * @returns Conversion result with either the converted schema or validation errors
 *
 * @example
 * ```typescript
 * import { defineSchema } from '@db-semantic-planner/schema';
 * import { resolvedSchemaToGeneratedSchema, createOrm } from '@db-semantic-planner/core';
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

	// Convert tables
	const tables: Record<string, GeneratedTable> = {};
	for (const [tableName, tableDef] of Object.entries(validated.tables)) {
		const convertedTable: Record<string, GeneratedColumn> = {};
		for (const [colName, colDef] of Object.entries(tableDef)) {
			convertedTable[colName] = convertColumn(colDef);
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
		const messages = result.errors.map((e) => e.message).join(', ');
		throw new Error(`Schema validation failed: ${messages}`);
	}
	return result.schema;
}
