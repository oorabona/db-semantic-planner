/**
 * @module schema-builder
 * Fluent builder API for defining ModelIR schemas.
 */

import { ModelIRImpl } from './model-impl.js';
import type {
	Cardinality,
	ColumnIR,
	ColumnType,
	FilterStrategy,
	ForeignKeyIR,
	IncludeStrategy,
	IndexIR,
	JoinDefault,
	ModelIR,
	OnDeleteAction,
	Optionality,
	RelationIR,
	RelationType,
	TableIR,
} from './model-ir.js';

// ============================================================================
// Builder Types
// ============================================================================

/**
 * SQL expression wrapper for defaults - triggers RAW_SQL_USAGE warning
 */
export interface SqlDefault {
	readonly sql: string;
}

/**
 * Safe default value: literal or SQL expression
 */
export type DefaultValue = string | number | boolean | null | SqlDefault;

/**
 * Foreign key reference definition
 */
export interface FKReference {
	readonly table: string;
	readonly column?: string; // default: 'id'
	readonly onDelete?: OnDeleteAction;
}

/**
 * Rich column definition with constraints
 */
export interface ColumnDef {
	readonly type: ColumnType;
	readonly nullable?: boolean;
	readonly unique?: boolean;
	readonly primaryKey?: boolean;
	readonly default?: DefaultValue;
	readonly index?: boolean | string;
	readonly references?: FKReference;
}

/**
 * Index definition for table-level composite indexes
 */
export interface IndexDef {
	readonly columns: readonly string[];
	readonly unique?: boolean;
	readonly name?: string;
}

/**
 * Table definition with optional config
 */
export interface TableDefWithConfig {
	readonly columns: Record<string, ColumnDef>;
	readonly primaryKey?: string | readonly string[];
	readonly indexes?: readonly IndexDef[];
}

/**
 * Table definition: simple (columns only) or with config
 */
export type TableDef = Record<string, ColumnDef> | TableDefWithConfig;

/**
 * Type guard to check if TableDef has config
 */
export function isTableDefWithConfig(def: TableDef): def is TableDefWithConfig {
	return 'columns' in def && typeof def.columns === 'object';
}

/**
 * Valid SQL identifier pattern
 */
export const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validate that a string is a valid SQL identifier
 */
export function isValidIdentifier(name: string): boolean {
	return IDENTIFIER_REGEX.test(name);
}

/**
 * Optional hints to override default planner strategies
 */
export interface RelationHints {
	/** Override include strategy: 'join' | 'separate' | 'auto' */
	includeStrategy?: IncludeStrategy;
	/** Override filter strategy: 'exists' | 'join' | 'auto' */
	filterStrategy?: FilterStrategy;
	/** Override join type: 'left' | 'inner' | 'auto' */
	joinDefault?: JoinDefault;
	/** Override optionality: 'required' | 'optional' */
	optionality?: Optionality;
}

/**
 * Single relation definition (returned by hasOne, hasMany, etc.)
 */
export interface RelationDef {
	readonly type: RelationType;
	readonly target: string;
	readonly foreignKey?: string | readonly string[] | undefined;
	readonly through?: string | undefined;
	readonly otherKey?: string | undefined;
	readonly hints?: RelationHints | undefined;
}

/**
 * Relations definition for a set of tables.
 * Maps table name → relation name → relation definition
 */
export type RelationsDef<T extends Record<string, TableDef>> = {
	[TableName in keyof T]?: Record<string, RelationDef>;
};

/**
 * Reference to a model for type-safe queries.
 * Created from the schema builder result.
 */
export interface ModelRef<T> {
	readonly __modelType: T;
	readonly tableName: string;
}

// ============================================================================
// Relation Helper Functions
// ============================================================================

/**
 * Define a hasOne relation (source has one target via FK on target)
 */
export function hasOne(
	target: string,
	options: { foreignKey: string | readonly string[] },
	hints?: RelationHints,
): RelationDef {
	return {
		type: 'hasOne',
		target,
		foreignKey: options.foreignKey,
		hints,
	};
}

/**
 * Define a hasMany relation (source has many targets via FK on target)
 */
export function hasMany(
	target: string,
	options: { foreignKey: string | readonly string[] },
	hints?: RelationHints,
): RelationDef {
	return {
		type: 'hasMany',
		target,
		foreignKey: options.foreignKey,
		hints,
	};
}

/**
 * Define a belongsTo relation (source belongs to target via FK on source)
 */
export function belongsTo(
	target: string,
	options: { foreignKey: string | readonly string[] },
	hints?: RelationHints,
): RelationDef {
	return {
		type: 'belongsTo',
		target,
		foreignKey: options.foreignKey,
		hints,
	};
}

/**
 * Define a belongsToMany relation (M:N via junction table)
 */
export function belongsToMany(
	target: string,
	options: { through: string; foreignKey?: string; otherKey?: string },
	hints?: RelationHints,
): RelationDef {
	return {
		type: 'belongsToMany',
		target,
		through: options.through,
		foreignKey: options.foreignKey,
		otherKey: options.otherKey,
		hints,
	};
}

// ============================================================================
// Schema Builder
// ============================================================================

/**
 * Schema definition builder (thenable pattern)
 */
export interface SchemaBuilder<T extends Record<string, TableDef>> {
	/**
	 * Define relations between tables
	 */
	relations<R extends RelationsDef<T>>(
		relations: R,
	): SchemaBuilderWithRelations;

	/**
	 * Build the final ModelIR without relations
	 */
	build(): ModelIR;
}

export interface SchemaBuilderWithRelations {
	/**
	 * Build the final ModelIR (immutable after this)
	 */
	build(): ModelIR;
}

/**
 * Entry point for schema definition
 */
export function defineSchema<T extends Record<string, TableDef>>(
	tables: T,
): SchemaBuilder<T> {
	return new SchemaBuilderImpl(tables);
}

// ============================================================================
// Builder Implementation
// ============================================================================

class SchemaBuilderImpl<T extends Record<string, TableDef>>
	implements SchemaBuilder<T>
{
	constructor(private readonly tableDefs: T) {}

	relations<R extends RelationsDef<T>>(
		relationsDefs: R,
	): SchemaBuilderWithRelations {
		return new SchemaBuilderWithRelationsImpl(this.tableDefs, relationsDefs);
	}

	build(): ModelIR {
		return this.buildWithRelations({});
	}

	private buildWithRelations(relationsDefs: RelationsDef<T>): ModelIR {
		const tables = this.buildTables();
		const relations = this.buildRelations(relationsDefs);
		return new ModelIRImpl(tables, relations);
	}

	private buildTables(): Map<string, TableIR> {
		const tables = new Map<string, TableIR>();

		for (const [tableName, tableDef] of Object.entries(this.tableDefs)) {
			// Extract columns and config from TableDef
			const columnDefs = isTableDefWithConfig(tableDef)
				? tableDef.columns
				: tableDef;
			const tableConfig = isTableDefWithConfig(tableDef) ? tableDef : null;

			const columns: ColumnIR[] = [];
			const foreignKeys: ForeignKeyIR[] = [];
			const indexes: IndexIR[] = [];
			const pkColumns: string[] = [];
			let hasIdColumn = false;

			for (const [colName, colDef] of Object.entries(columnDefs)) {
				// Validate identifier
				if (!isValidIdentifier(colName)) {
					throw new Error(
						`Invalid column name '${colName}' in table '${tableName}': must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`,
					);
				}

				// V2: Nullable primary key
				if (colDef.primaryKey && colDef.nullable) {
					throw new Error(
						`Primary key column '${colName}' in table '${tableName}' cannot be nullable`,
					);
				}

				// V3: Default null on non-nullable
				if (colDef.default === null && !colDef.nullable) {
					throw new Error(
						`Cannot set default to null on non-nullable column '${colName}' in table '${tableName}'`,
					);
				}

				// V5: Validate FK reference table identifier
				if (colDef.references) {
					if (!isValidIdentifier(colDef.references.table)) {
						throw new Error(
							`Invalid table name '${colDef.references.table}' in FK reference for column '${colName}'`,
						);
					}
					if (
						colDef.references.column &&
						!isValidIdentifier(colDef.references.column)
					) {
						throw new Error(
							`Invalid column name '${colDef.references.column}' in FK reference for column '${colName}'`,
						);
					}
				}

				// Build ColumnIR
				columns.push({
					name: colName,
					type: colDef.type,
					nullable: colDef.nullable ?? false,
					default: colDef.default,
				});

				// Track primary key columns
				if (colDef.primaryKey) {
					pkColumns.push(colName);
				}
				if (colName === 'id') {
					hasIdColumn = true;
				}

				// Extract explicit FK references
				if (colDef.references) {
					const fkDef: ForeignKeyIR = {
						columns: [colName],
						references: {
							table: colDef.references.table,
							columns: [colDef.references.column ?? 'id'],
						},
					};
					if (colDef.references.onDelete) {
						(fkDef as { onDelete?: OnDeleteAction }).onDelete =
							colDef.references.onDelete;
					}
					foreignKeys.push(fkDef);
				}

				// Extract column-level index
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
				}

				// Unique constraint creates implicit index (optional: track separately)
				// For now, unique is handled in DDL generation directly
			}

			// V1: Multiple primaryKey: true
			if (pkColumns.length > 1) {
				throw new Error(
					`Multiple columns have primaryKey: true in table '${tableName}'. Use table-level primaryKey for composite keys.`,
				);
			}

			// Determine final primary key
			let primaryKey: string | readonly string[];
			const singlePkCol = pkColumns.length === 1 ? pkColumns[0] : undefined;
			if (tableConfig?.primaryKey) {
				// Table-level primaryKey takes precedence
				primaryKey = tableConfig.primaryKey;
			} else if (singlePkCol !== undefined) {
				primaryKey = singlePkCol;
			} else if (hasIdColumn) {
				primaryKey = 'id';
			} else {
				// Default to first column if no id
				primaryKey = columns[0]?.name ?? 'id';
			}

			// Extract table-level indexes
			if (tableConfig?.indexes) {
				for (const idxDef of tableConfig.indexes) {
					const indexName =
						idxDef.name ?? `idx_${tableName}_${idxDef.columns.join('_')}`;
					indexes.push({
						name: indexName,
						columns: idxDef.columns,
						unique: idxDef.unique ?? false,
					});
				}
			}

			const table: TableIR = Object.freeze({
				name: tableName,
				columns: Object.freeze(columns),
				primaryKey,
				foreignKeys: Object.freeze(foreignKeys),
				indexes: Object.freeze(indexes),
			});

			tables.set(tableName, table);
		}

		// V4: Validate FK references point to existing tables
		for (const [tableName, table] of tables) {
			for (const fk of table.foreignKeys) {
				if (!tables.has(fk.references.table)) {
					throw new Error(
						`Foreign key in table '${tableName}' references unknown table '${fk.references.table}'`,
					);
				}
			}
		}

		return tables;
	}

	private buildRelations(
		relationsDefs: RelationsDef<T>,
	): Map<string, RelationIR> {
		const relations = new Map<string, RelationIR>();

		for (const [sourceTable, tableRelations] of Object.entries(relationsDefs)) {
			if (!tableRelations) continue;

			for (const [relationName, relationDef] of Object.entries(
				tableRelations as Record<string, RelationDef>,
			)) {
				const qualifiedName = `${sourceTable}.${relationName}`;

				const cardinality = this.inferCardinality(relationDef.type);
				const optionality = relationDef.hints?.optionality ?? 'optional';
				const includeStrategy = relationDef.hints?.includeStrategy ?? 'auto';
				const filterStrategy = relationDef.hints?.filterStrategy ?? 'auto';
				const joinDefault = relationDef.hints?.joinDefault ?? 'auto';

				const relation: RelationIR = Object.freeze({
					name: relationName,
					type: relationDef.type,
					source: sourceTable,
					target: relationDef.target,
					through: relationDef.through,
					foreignKey: relationDef.foreignKey,
					otherKey: relationDef.otherKey,
					cardinality,
					optionality,
					includeStrategy,
					filterStrategy,
					joinDefault,
				});

				relations.set(qualifiedName, relation);
			}
		}

		return relations;
	}

	private inferCardinality(type: RelationType): Cardinality {
		switch (type) {
			case 'hasOne':
			case 'belongsTo':
				return 'one';
			case 'hasMany':
			case 'belongsToMany':
				return 'many';
		}
	}
}

class SchemaBuilderWithRelationsImpl<
	T extends Record<string, TableDef>,
	R extends RelationsDef<T>,
> implements SchemaBuilderWithRelations
{
	private readonly builder: SchemaBuilderImpl<T>;

	constructor(
		tableDefs: T,
		private readonly relationsDefs: R,
	) {
		this.builder = new SchemaBuilderImpl(tableDefs);
	}

	build(): ModelIR {
		// Access private method via casting (implementation detail)
		return (
			this.builder as unknown as {
				buildWithRelations: (r: RelationsDef<T>) => ModelIR;
			}
		).buildWithRelations(this.relationsDefs);
	}
}
