/**
 * ARCH-002 Block 6: Schema Bridge
 *
 * Converts generated schema (from dbsp generate manifest) to ModelIR.
 * This enables sync createOrm usage with codegen-first schemas.
 */

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
